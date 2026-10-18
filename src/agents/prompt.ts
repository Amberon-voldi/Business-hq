import type { Business } from "../config/store";
import { CONTEXT_SECTION_KEYS, type ContextSectionKey, type HqContext, type HqTable } from "../notion/types";
import { isCopyTask } from "./brand";
import { AGENTS, OWNERS, type Owner, TASK_KINDS, type TaskKind } from "./registry";

export const SECTION_TITLES: Record<ContextSectionKey, string> = {
  product_brief: "Product Brief",
  brand_rules: "Brand Rules",
  tech_stack: "Tech Stack",
  roadmap: "Roadmap",
  ai_interns: "AI Interns",
  task_board: "Task Board",
};

export interface PromptInput {
  owner: Owner;
  task: string;
  kind?: TaskKind | undefined;
  business: Business;
  context: HqContext;
  requestedSections?: ContextSectionKey[] | undefined;
  /** Extra task details (Notion row properties, page notes, GitHub issue body…). */
  details?: Record<string, string> | undefined;
}

export interface BuiltPrompt {
  system: string;
  user: string;
  sectionsUsed: ContextSectionKey[];
  brandSafety: boolean;
}

/**
 * Scoped context: only the sections the intern needs. Brand Rules are forced in for
 * any copy/marketing task, whatever the caller asked for.
 */
export function resolveSections(
  owner: Owner,
  task: string,
  requested?: ContextSectionKey[],
  kind: TaskKind = "general",
): { sections: ContextSectionKey[]; brandSafety: boolean } {
  const base = requested && requested.length > 0 ? requested : AGENTS[owner].defaultSections;
  const brandSafety = isCopyTask(task, owner, kind);
  const set = new Set(base);
  if (brandSafety) set.add("brand_rules");
  // Stable order keeps the system prompt byte-identical across calls (prompt caching).
  return { sections: CONTEXT_SECTION_KEYS.filter((k) => set.has(k)), brandSafety };
}

/** Role text from the business's "AI Interns" table, if a row names this intern. */
export function roleFromInternsTable(context: HqContext | null, owner: Owner): string | null {
  for (const table of context?.sections.ai_interns?.tables ?? []) {
    for (const row of table.rows) {
      const idx = row.findIndex((cell) => cell.trim().toLowerCase() === owner.toLowerCase());
      if (idx < 0) continue;
      const desc = row
        .map((cell, i) => (i === idx || !cell ? null : `${table.headers[i] ?? ""}: ${cell}`))
        .filter(Boolean)
        .join("; ");
      if (desc) return desc;
    }
  }
  return null;
}

export function businessLine(b: Business): string {
  const domain = b.domain && b.domain !== b.name ? ` (${b.domain})` : "";
  return `${b.name}${domain}${b.description ? ` — ${b.description}` : ""}`;
}

/** Renders scoped HQ sections as tagged blocks; used by the worker and by agent briefings. */
export function renderSections(business: Business, context: HqContext | null, sections: ContextSectionKey[]): string {
  const blocks: string[] = [];
  for (const key of sections) {
    let body = context?.sections[key]?.markdown?.trim() ?? "";
    if (key === "brand_rules" && !body) body = business.brandNotes;
    if (key === "brand_rules" && business.forbiddenTerms.length) {
      body += `${body ? "\n" : ""}- Never use: ${business.forbiddenTerms.map((t) => `"${t}"`).join(", ")}.`;
    }
    if (key === "task_board" && context && context.tasks.length > 0) body = renderTasks(context) + (body ? `\n\n${body}` : "");
    if (!body) continue;
    blocks.push(`<section business="${business.name}" name="${SECTION_TITLES[key]}">\n${body}\n</section>`);
  }
  return blocks.join("\n\n");
}

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const { owner, task, context, business } = input;
  const kind = input.kind ?? "general";
  const { sections, brandSafety } = resolveSections(owner, task, input.requestedSections, kind);
  const role = roleFromInternsTable(context, owner) ?? AGENTS[owner].role;
  const teammates = OWNERS.filter((o) => o !== owner)
    .map((o) => `${o} (${AGENTS[o].role.split(".")[0]})`)
    .join(", ");

  const system = [
    `You are "${owner}", one of the AI Interns. You are working for ${businessLine(business)}.`,
    `Your role: ${role}`,
    `Teammates: ${teammates}.`,
    "",
    `Below is context from ${business.name}'s HQ doc in Notion. Treat it as the source of truth about this business. If the task conflicts with it, follow the HQ doc and point out the conflict. Do not mix in facts about other businesses.`,
    brandSafety
      ? `This task produces outward-facing text. Follow every rule in ${business.name}'s Brand Rules exactly; never use a name, phrase or location the rules forbid.`
      : "",
    "",
    renderSections(business, context, sections),
    "",
    "Output format:",
    "- First line: `Summary: <one sentence describing what you delivered>`.",
    "- Then the deliverable itself in Markdown, ready to use. No preamble about being an AI.",
    "- If the task is ambiguous, make a sensible assumption, state it in one line, and deliver anyway.",
  ]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n");

  const detailLines = Object.entries(input.details ?? {})
    .filter(([, v]) => v.trim())
    .map(([k, v]) => `### ${k}\n${v.trim()}`);
  const kindLine = TASK_KINDS[kind].instructions ? [`## Deliverable type: ${TASK_KINDS[kind].label}\n${TASK_KINDS[kind].instructions}`] : [];
  const user = [`# Task\n${task.trim()}`, ...kindLine, ...detailLines].join("\n\n");

  return { system, user, sectionsUsed: sections, brandSafety };
}

function renderTasks(context: HqContext): string {
  const table: HqTable = {
    headers: ["Task", "Owner", "Status"],
    rows: context.tasks.slice(0, 100).map((t) => [t.title, t.owner ?? "", t.status ?? ""]),
  };
  return [
    `| ${table.headers.join(" | ")} |`,
    "| --- | --- | --- |",
    ...table.rows.map((r) => `| ${r.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`),
  ].join("\n");
}

/** Splits the model's "Summary:" line from the deliverable body. */
export function splitSummary(text: string): { summary: string; body: string } {
  const trimmed = text.trim();
  const match = trimmed.match(/^\**summary:?\**\s*:?\s*(.+?)\s*(?:\n|$)/i);
  if (!match) {
    const firstLine = trimmed.split("\n").find((l) => l.trim()) ?? "";
    return { summary: firstLine.replace(/^#+\s*/, "").slice(0, 300), body: trimmed };
  }
  return { summary: (match[1] ?? "").trim(), body: trimmed.slice(match[0].length).trim() };
}
