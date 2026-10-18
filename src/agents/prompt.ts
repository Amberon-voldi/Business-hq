import { CONTEXT_SECTION_KEYS, type ContextSectionKey, type HqContext, type HqTable } from "../notion/types";
import { BRAND_BASELINE, isCopyTask } from "./brand";
import { AGENTS, type Owner } from "./registry";

const SECTION_TITLES: Record<ContextSectionKey, string> = {
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
 * Scoped context: only the sections the agent needs. Brand Rules are forced in for
 * any copy/marketing task, whatever the caller asked for.
 */
export function resolveSections(
  owner: Owner,
  task: string,
  requested?: ContextSectionKey[],
): { sections: ContextSectionKey[]; brandSafety: boolean } {
  const base = requested && requested.length > 0 ? requested : AGENTS[owner].defaultSections;
  const brandSafety = isCopyTask(task, owner);
  const set = new Set(base);
  if (brandSafety) set.add("brand_rules");
  // Stable order keeps the system prompt byte-identical across calls (prompt caching).
  return { sections: CONTEXT_SECTION_KEYS.filter((k) => set.has(k)), brandSafety };
}

/** Role text from the HQ "AI Interns" table, if a row names this owner. */
export function roleFromInternsTable(context: HqContext, owner: Owner): string | null {
  for (const table of context.sections.ai_interns?.tables ?? []) {
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

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const { owner, task, context } = input;
  const { sections, brandSafety } = resolveSections(owner, task, input.requestedSections);
  const role = roleFromInternsTable(context, owner) ?? AGENTS[owner].role;

  const blocks: string[] = [];
  for (const key of sections) {
    const section = context.sections[key];
    let body = section?.markdown?.trim() ?? "";
    if (key === "brand_rules" && !body) body = BRAND_BASELINE;
    if (key === "task_board" && context.tasks.length > 0) body = renderTasks(context) + (body ? `\n\n${body}` : "");
    if (!body) continue;
    blocks.push(`<section name="${SECTION_TITLES[key]}">\n${body}\n</section>`);
  }

  const system = [
    `You are "${owner}", one of the AI Interns working for noida.fit — a city-first fitness discovery platform for Delhi-NCR, pronounced "Noida dot fit".`,
    `Your role: ${role}`,
    "",
    "Below is context from the team's HQ doc in Notion. Treat it as the source of truth about the product, brand and plans. If the task conflicts with it, follow the HQ doc and point out the conflict.",
    brandSafety
      ? "This task produces public-facing copy. Follow every rule in the Brand Rules section exactly; never use a name, phrase or location the rules forbid."
      : "",
    "",
    blocks.join("\n\n"),
    "",
    "Output format:",
    "- First line: `Summary: <one sentence describing what you delivered>`.",
    "- Then the deliverable itself in Markdown, ready to paste. No preamble about being an AI.",
    "- If the task is ambiguous, make a sensible assumption, state it in one line, and deliver anyway.",
  ]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n");

  const detailLines = Object.entries(input.details ?? {})
    .filter(([, v]) => v.trim())
    .map(([k, v]) => `### ${k}\n${v.trim()}`);
  const user = [`# Task\n${task.trim()}`, ...detailLines].join("\n\n");

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
