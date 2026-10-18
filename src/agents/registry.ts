import type { ContextSectionKey } from "../notion/types";

export const OWNERS = ["Code", "Pro", "Grok", "Muse"] as const;
export type Owner = (typeof OWNERS)[number];

export type Provider = "anthropic" | "xai" | "external";

export interface AgentProfile {
  owner: Owner;
  /** Model used when the worker runs the task itself (delivery "api"). */
  provider: Exclude<Provider, "external">;
  /** Fallback role text; a matching row in a business's "AI Interns" table overrides it. */
  role: string;
  /** Context sections sent when the caller doesn't specify any. */
  defaultSections: ContextSectionKey[];
  /** Marketing/copy agent: Brand Rules are always attached. */
  writesCopy: boolean;
}

export const AGENTS: Record<Owner, AgentProfile> = {
  Code: {
    owner: "Code",
    provider: "anthropic",
    role: "Engineering intern. Writes and reviews code, technical specs, integrations and implementation plans.",
    defaultSections: ["product_brief", "tech_stack", "roadmap"],
    writesCopy: false,
  },
  Pro: {
    owner: "Pro",
    provider: "anthropic",
    role: "Operations & strategy intern. Research, business emails, PRDs, proposals, prioritisation and ops docs.",
    defaultSections: ["product_brief", "roadmap", "task_board"],
    writesCopy: false,
  },
  Grok: {
    owner: "Grok",
    provider: "xai",
    role: "Social & trends intern. Posts and threads for X, trend and competitor scans, punchy short-form copy.",
    defaultSections: ["product_brief", "brand_rules"],
    writesCopy: true,
  },
  Muse: {
    owner: "Muse",
    provider: "anthropic",
    role: "Creative & brand intern. Marketing copy, campaigns, naming, landing pages, newsletters and email content.",
    defaultSections: ["product_brief", "brand_rules", "roadmap"],
    writesCopy: true,
  },
};

/** Maps a Notion/Slack/label value to an AI owner. Returns null for "Human" or unknown values. */
export function parseOwner(value: string | null | undefined): Owner | null {
  if (!value) return null;
  const norm = value.trim().toLowerCase();
  return OWNERS.find((o) => o.toLowerCase() === norm) ?? null;
}

/** Task types shape the deliverable and suggest who should do it. */
export const TASK_KINDS = {
  general: {
    label: "General",
    owner: null,
    copy: false,
    instructions: "",
  },
  email: {
    label: "Email draft",
    owner: "Pro",
    copy: true,
    instructions:
      "Deliver a ready-to-send email draft: a `Subject:` line, the body, and a sign-off. Use [placeholders] for any name, date or figure you were not given. This is a draft for a human to review and send — never claim it has been sent.",
  },
  research: {
    label: "Research",
    owner: "Pro",
    copy: false,
    instructions:
      "Deliver a research brief: the question, key findings as bullets, options or comparisons in a table where useful, a recommendation, and open questions. Separate what you know from what you are assuming. Do not invent statistics, quotes, prices or sources — say what would need verifying.",
  },
  social: {
    label: "Social post",
    owner: "Grok",
    copy: true,
    instructions:
      "Deliver 3 distinct post options (platform-appropriate length), each with a one-line rationale. No hashtag spam; at most 2 relevant hashtags.",
  },
  copy: {
    label: "Marketing copy",
    owner: "Muse",
    copy: true,
    instructions: "Deliver polished copy with 2–3 variants where it helps the reviewer choose, plus a one-line note on the angle of each.",
  },
  code: {
    label: "Code / technical",
    owner: "Code",
    copy: false,
    instructions:
      "Deliver working code or a precise technical plan. State assumptions about the stack, list files to change, and include tests or verification steps.",
  },
  doc: {
    label: "Doc / plan",
    owner: "Pro",
    copy: false,
    instructions: "Deliver a structured document with clear headings, decisions, owners and next steps.",
  },
} as const satisfies Record<string, { label: string; owner: Owner | null; copy: boolean; instructions: string }>;

export type TaskKind = keyof typeof TASK_KINDS;
export const TASK_KIND_KEYS = Object.keys(TASK_KINDS) as TaskKind[];

export function parseKind(value: string | null | undefined): TaskKind | null {
  if (!value) return null;
  const norm = value.trim().toLowerCase();
  return TASK_KIND_KEYS.find((k) => k === norm || TASK_KINDS[k].label.toLowerCase() === norm) ?? null;
}
