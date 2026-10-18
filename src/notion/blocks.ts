import type { BlockObjectRequest } from "@notionhq/client";

const MAX_TEXT = 2000; // Notion limit per rich_text item
export const MAX_BLOCKS_PER_APPEND = 100;

type RichText = { type: "text"; text: { content: string; link?: { url: string } } };

export function richText(content: string, link?: string): RichText[] {
  const out: RichText[] = [];
  for (let i = 0; i === 0 || i < content.length; i += MAX_TEXT) {
    out.push({ type: "text", text: { content: content.slice(i, i + MAX_TEXT), ...(link ? { link: { url: link } } : {}) } });
  }
  return out.slice(0, 100);
}

const CODE_LANGUAGES = new Set([
  "javascript", "typescript", "json", "bash", "shell", "python", "html", "css", "sql", "yaml", "markdown", "plain text",
]);

/**
 * Minimal Markdown -> Notion blocks for agent deliverables: headings, bullets,
 * numbered items, quotes, fenced code, dividers and paragraphs. Inline Markdown is
 * kept as literal text — readable, and never lossy.
 */
export function markdownToBlocks(markdown: string): BlockObjectRequest[] {
  const blocks: BlockObjectRequest[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ type: "paragraph", paragraph: { rich_text: richText(text) } });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      while (i + 1 < lines.length && !/^```\s*$/.test(lines[i + 1] ?? "")) code.push(lines[++i] ?? "");
      i++; // skip closing fence
      const lang = (fence[1] ?? "").toLowerCase();
      const language = (CODE_LANGUAGES.has(lang) ? lang : "plain text") as "plain text";
      blocks.push({ type: "code", code: { language, rich_text: richText(code.join("\n")) } });
      continue;
    }
    let m: RegExpMatchArray | null;
    if (line.trim() === "") {
      flushParagraph();
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushParagraph();
      const level = Math.min((m[1] ?? "#").length, 3);
      const rt = richText(m[2] ?? "");
      if (level === 1) blocks.push({ type: "heading_1", heading_1: { rich_text: rt } });
      else if (level === 2) blocks.push({ type: "heading_2", heading_2: { rich_text: rt } });
      else blocks.push({ type: "heading_3", heading_3: { rich_text: rt } });
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushParagraph();
      blocks.push({ type: "bulleted_list_item", bulleted_list_item: { rich_text: richText(m[1] ?? "") } });
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushParagraph();
      blocks.push({ type: "numbered_list_item", numbered_list_item: { rich_text: richText(m[1] ?? "") } });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushParagraph();
      blocks.push({ type: "quote", quote: { rich_text: richText(m[1] ?? "") } });
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushParagraph();
      blocks.push({ type: "divider", divider: {} });
    } else {
      paragraph.push(line);
    }
  }
  flushParagraph();
  return blocks;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Collapses whitespace and caps length with an ellipsis. */
export function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
