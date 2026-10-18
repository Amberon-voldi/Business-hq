import type { BlockObjectResponse, RichTextItemResponse } from "@notionhq/client";
import type { AppendTarget, HqSection, HqTable, HqTask, SectionKey } from "./types";

export interface BlockNode {
  block: BlockObjectResponse;
  children: BlockNode[];
}

const SECTION_ALIASES: Record<SectionKey, string[]> = {
  product_brief: ["product brief", "brief"],
  brand_rules: ["brand rules", "brand"],
  tech_stack: ["tech stack", "stack"],
  roadmap: ["roadmap"],
  ai_interns: ["ai interns", "interns"],
  task_board: ["task board", "tasks"],
  log: ["log", "audit log", "activity log"],
};

/** "🎨 Brand Rules" -> "brand rules" */
export function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchSection(headingText: string): SectionKey | null {
  const norm = normalizeHeading(headingText);
  for (const [key, aliases] of Object.entries(SECTION_ALIASES) as [SectionKey, string[]][]) {
    if (aliases.some((a) => norm === a)) return key;
  }
  // Looser match for headings like "Roadmap (Q4)" or "Task Board — Sprint 3".
  for (const [key, aliases] of Object.entries(SECTION_ALIASES) as [SectionKey, string[]][]) {
    if (aliases.some((a) => norm.startsWith(`${a} `))) return key;
  }
  return null;
}

export function richTextToMarkdown(items: RichTextItemResponse[]): string {
  return items
    .map((t) => {
      let s = t.plain_text;
      if (!s) return "";
      if (t.type === "text" && t.text.link?.url) s = `[${s}](${t.text.link.url})`;
      if (t.annotations.code) s = `\`${s}\``;
      if (t.annotations.bold) s = `**${s}**`;
      if (t.annotations.italic) s = `_${s}_`;
      if (t.annotations.strikethrough) s = `~~${s}~~`;
      return s;
    })
    .join("");
}

export function richTextToPlain(items: RichTextItemResponse[]): string {
  return items.map((t) => t.plain_text).join("");
}

function headingInfo(block: BlockObjectResponse): { level: 1 | 2 | 3; text: string; toggleable: boolean } | null {
  switch (block.type) {
    case "heading_1":
      return { level: 1, text: richTextToPlain(block.heading_1.rich_text), toggleable: block.heading_1.is_toggleable };
    case "heading_2":
      return { level: 2, text: richTextToPlain(block.heading_2.rich_text), toggleable: block.heading_2.is_toggleable };
    case "heading_3":
      return { level: 3, text: richTextToPlain(block.heading_3.rich_text), toggleable: block.heading_3.is_toggleable };
    default:
      return null;
  }
}

export function tableFromNode(node: BlockNode): HqTable | null {
  if (node.block.type !== "table") return null;
  const rows: string[][] = [];
  for (const child of node.children) {
    if (child.block.type !== "table_row") continue;
    rows.push(child.block.table_row.cells.map((cell) => richTextToPlain(cell).trim()));
  }
  if (rows.length === 0) return { headers: [], rows: [] };
  if (node.block.table.has_column_header) {
    const [headers = [], ...body] = rows;
    return { headers, rows: body };
  }
  const width = node.block.table.table_width;
  return { headers: Array.from({ length: width }, (_, i) => `Column ${i + 1}`), rows };
}

function tableToMarkdown(table: HqTable): string {
  if (table.headers.length === 0) return "";
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    `| ${table.headers.map(esc).join(" | ")} |`,
    `| ${table.headers.map(() => "---").join(" | ")} |`,
    ...table.rows.map((r) => `| ${table.headers.map((_, i) => esc(r[i] ?? "")).join(" | ")} |`),
  ].join("\n");
}

/** Renders a block subtree to Markdown, collecting tables along the way. */
export function nodeToMarkdown(node: BlockNode, tables: HqTable[], depth = 0): string {
  const b = node.block;
  const indent = "  ".repeat(depth);
  const kids = (d: number) =>
    node.children
      .map((c) => nodeToMarkdown(c, tables, d))
      .filter(Boolean)
      .join("\n");
  const withKids = (line: string) => {
    const k = kids(depth + 1);
    return k ? `${line}\n${k}` : line;
  };

  switch (b.type) {
    case "paragraph":
      return withKids(indent + richTextToMarkdown(b.paragraph.rich_text));
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const h = headingInfo(b);
      return withKids(`${"#".repeat((h?.level ?? 1) + 1)} ${h?.text ?? ""}`);
    }
    case "bulleted_list_item":
      return withKids(`${indent}- ${richTextToMarkdown(b.bulleted_list_item.rich_text)}`);
    case "numbered_list_item":
      return withKids(`${indent}1. ${richTextToMarkdown(b.numbered_list_item.rich_text)}`);
    case "to_do":
      return withKids(`${indent}- [${b.to_do.checked ? "x" : " "}] ${richTextToMarkdown(b.to_do.rich_text)}`);
    case "toggle":
      return withKids(`${indent}- ${richTextToMarkdown(b.toggle.rich_text)}`);
    case "quote":
      return withKids(`${indent}> ${richTextToMarkdown(b.quote.rich_text)}`);
    case "callout":
      return withKids(`${indent}> ${richTextToMarkdown(b.callout.rich_text)}`);
    case "code":
      return `\`\`\`${b.code.language}\n${richTextToPlain(b.code.rich_text)}\n\`\`\``;
    case "divider":
      return "---";
    case "table": {
      const t = tableFromNode(node);
      if (!t) return "";
      tables.push(t);
      return tableToMarkdown(t);
    }
    case "bookmark":
      return `${indent}${b.bookmark.url}`;
    case "child_page":
      return `${indent}[Sub-page: ${b.child_page.title}]`;
    case "child_database":
      return `${indent}[Database: ${b.child_database.title}]`;
    case "column_list":
    case "column":
    case "synced_block":
      return kids(depth);
    default:
      return "";
  }
}

export interface ParsedSections {
  sections: Partial<Record<SectionKey, HqSection>>;
  /** child_database blocks found inside the Task Board section. */
  taskDatabaseIds: string[];
}

/**
 * Splits the HQ page's top-level blocks into sections by heading. A heading that
 * matches a known section name starts that section; any other heading stays a
 * sub-heading of the current section. Content nested in toggle headings is included.
 */
export function parseSections(pageId: string, topLevel: BlockNode[]): ParsedSections {
  const sections: Partial<Record<SectionKey, HqSection>> = {};
  const taskDatabaseIds: string[] = [];

  type Open = { key: SectionKey; title: string; toggleable: boolean; headingNode: BlockNode; nodes: BlockNode[] };
  let current: Open | null = null;

  const flush = (open: Open) => {
    const tables: HqTable[] = [];
    const parts = [...open.headingNode.children, ...open.nodes].map((n) => nodeToMarkdown(n, tables));
    const appendTarget: AppendTarget = open.toggleable
      ? { parentId: open.headingNode.block.id }
      : { parentId: pageId, afterBlockId: (open.nodes.at(-1) ?? open.headingNode).block.id };

    // First occurrence wins so a stray duplicate heading can't shadow the real section.
    sections[open.key] ??= {
      key: open.key,
      title: open.title,
      markdown: parts.filter(Boolean).join("\n").trim(),
      tables,
      appendTarget,
    };
  };

  for (const node of topLevel) {
    const h = headingInfo(node.block);
    const key = h ? matchSection(h.text) : null;
    if (h && key) {
      if (current) flush(current);
      current = { key, title: h.text.trim(), toggleable: h.toggleable, headingNode: node, nodes: [] };
      if (key === "task_board") collectDatabases(node.children, taskDatabaseIds);
      continue;
    }
    if (current) {
      current.nodes.push(node);
      if (current.key === "task_board") collectDatabases([node], taskDatabaseIds);
    }
  }
  if (current) flush(current);
  return { sections, taskDatabaseIds };
}

function collectDatabases(nodes: BlockNode[], out: string[]): void {
  for (const n of nodes) {
    if (n.block.type === "child_database") out.push(n.block.id);
    collectDatabases(n.children, out);
  }
}

/** Fallback when the Task Board is a plain table rather than an inline database. */
export function tasksFromTable(table: HqTable): HqTask[] {
  const idx = (re: RegExp) => table.headers.findIndex((h) => re.test(h));
  const titleIdx = Math.max(idx(/task|name|title/i), 0);
  const ownerIdx = idx(/owner|agent|assignee/i);
  const statusIdx = idx(/status/i);
  return table.rows
    .filter((r) => (r[titleIdx] ?? "").trim() !== "")
    .map((r, i) => ({
      id: `table-row-${i + 1}`,
      title: r[titleIdx] ?? "",
      owner: ownerIdx >= 0 ? r[ownerIdx] || null : null,
      status: statusIdx >= 0 ? r[statusIdx] || null : null,
      url: null,
      writable: false,
    }));
}
