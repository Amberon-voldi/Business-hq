import type { ContextSectionKey } from "../notion/types";

export const OWNERS = ["Code", "Pro", "Grok", "Muse"] as const;
export type Owner = (typeof OWNERS)[number];

export type Provider = "anthropic" | "xai";

export interface AgentProfile {
  owner: Owner;
  provider: Provider;
  /** Fallback role text; a matching row in the HQ "AI Interns" table overrides it. */
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
    role: "Engineering intern. Writes and reviews code, technical specs, migrations and implementation plans for the noida.fit product.",
    defaultSections: ["product_brief", "tech_stack", "roadmap"],
    writesCopy: false,
  },
  Pro: {
    owner: "Pro",
    provider: "anthropic",
    role: "Product & strategy intern. Writes PRDs, research summaries, prioritisation and ops docs for noida.fit.",
    defaultSections: ["product_brief", "roadmap", "task_board"],
    writesCopy: false,
  },
  Grok: {
    owner: "Grok",
    provider: "xai",
    role: "Social & trends intern. Drafts posts and threads for X, reacts to what's trending, writes punchy short-form copy.",
    defaultSections: ["product_brief", "brand_rules"],
    writesCopy: true,
  },
  Muse: {
    owner: "Muse",
    provider: "anthropic",
    role: "Creative & brand intern. Writes marketing copy, campaign ideas, naming, landing-page and email content.",
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
