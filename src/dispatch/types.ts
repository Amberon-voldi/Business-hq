import type { Owner, Provider, TaskKind } from "../agents/registry";
import type { Delivery } from "../config/store";
import type { ContextSectionKey } from "../notion/types";

export type DispatchSource =
  | { kind: "manual" }
  | { kind: "notion" }
  | { kind: "slack"; responseUrl?: string; channel?: string; threadTs?: string; userId?: string }
  | { kind: "github"; repo: string; url: string; event: string }
  | { kind: "agent"; by: Owner };

export interface DispatchJob {
  id: string;
  /** Business id from the directory. Older queued messages may lack it (→ default business). */
  business?: string;
  task: string;
  owner: Owner;
  kind?: TaskKind;
  /** "api": the worker calls the model. "inbox": an external agent picks it up via /agent/v1. */
  delivery?: Delivery;
  contextSections?: ContextSectionKey[];
  /** Notion Task Board row to update with status + deliverable. */
  taskPageId?: string;
  details?: Record<string, string>;
  source: DispatchSource;
  /** Set when an intern hands work to a teammate; depth caps delegation chains. */
  delegation?: { by: Owner; depth: number; parentJobId?: string };
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
