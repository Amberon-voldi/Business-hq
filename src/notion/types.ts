export const SECTION_KEYS = [
  "product_brief",
  "brand_rules",
  "tech_stack",
  "roadmap",
  "ai_interns",
  "task_board",
  "log",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** Sections an agent may receive as context (the Log is write-only audit data). */
export const CONTEXT_SECTION_KEYS = SECTION_KEYS.filter((k) => k !== "log") as Exclude<SectionKey, "log">[];
export type ContextSectionKey = Exclude<SectionKey, "log">;

export interface HqTable {
  headers: string[];
  rows: string[][];
}

export interface AppendTarget {
  /** Block (or page) to append children to. */
  parentId: string;
  /** Insert after this child of `parentId`; undefined = append at the end. */
  afterBlockId?: string;
}

export interface HqSection {
  key: SectionKey;
  title: string;
  markdown: string;
  tables: HqTable[];
  /** Where new content for this section should be appended. */
  appendTarget: AppendTarget;
}

export type TaskStatus = "To do" | "In progress" | "Done" | "Blocked";
export const TASK_STATUSES: readonly TaskStatus[] = ["To do", "In progress", "Done", "Blocked"];

export interface HqTask {
  /** Notion page id for database rows; synthetic id for plain table rows. */
  id: string;
  title: string;
  owner: string | null;
  status: string | null;
  url: string | null;
  /** Only database rows can be updated by the worker. */
  writable: boolean;
}

export interface HqContext {
  pageId: string;
  title: string;
  fetchedAt: string;
  sections: Partial<Record<SectionKey, HqSection>>;
  tasks: HqTask[];
  /** Data source backing the Task Board, when it is an inline database. */
  taskDataSourceId: string | null;
  /** Non-fatal problems hit while parsing (missing sections, unreadable databases). */
  warnings: string[];
}
