import type { Owner, Provider } from "../agents/registry";
import type { ContextSectionKey } from "../notion/types";

export type DispatchSource =
  | { kind: "manual" }
  | { kind: "notion" }
  | { kind: "slack"; responseUrl?: string; channel?: string; threadTs?: string; userId?: string }
  | { kind: "github"; repo: string; url: string; event: string };

export interface DispatchJob {
  id: string;
  task: string;
  owner: Owner;
  contextSections?: ContextSectionKey[];
  /** Notion Task Board row to update with status + deliverable. */
  taskPageId?: string;
  details?: Record<string, string>;
  source: DispatchSource;
  requestedAt: string;
}

export interface DispatchResult {
  id: string;
  owner: Owner;
  provider: Provider;
  model: string;
  summary: string;
  output: string;
  warnings: string[];
  sectionsUsed: ContextSectionKey[];
  brandSafety: boolean;
  completedAt: string;
}
