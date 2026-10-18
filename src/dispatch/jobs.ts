import type { Env } from "../env";
import { clip } from "../notion/blocks";
import type { DispatchJob, DispatchResult } from "./types";

export type JobStatus = "queued" | "assigned" | "running" | "retrying" | "done" | "failed";
export const ACTIVE_STATUSES: readonly JobStatus[] = ["queued", "assigned", "running", "retrying"];

/**
 * Everything known about a job, kept in KV for a week. Doubles as the checkpoint
 * that stops a retried message from re-running the LLM or double-writing Notion.
 */
export interface JobState {
  job?: DispatchJob;
  status?: JobStatus;
  error?: string;
  attempts?: number;
  result?: DispatchResult;
  done: { deliverable?: boolean; status?: boolean; log?: boolean; notify?: boolean };
  createdAt?: string;
  updatedAt?: string;
}

/** Small summary stored as KV metadata so the job list needs no per-key reads. */
export interface JobMeta {
  business: string;
  kind: string;
  delivery: string;
  owner: string;
  task: string;
  status: JobStatus;
  source: string;
  createdAt: string;
  updatedAt: string;
  summary?: string;
  error?: string;
}

const JOB_PREFIX = "job:";
const JOB_TTL_SECONDS = 60 * 60 * 24 * 7;

const jobKey = (id: string) => `${JOB_PREFIX}${id}`;

export async function loadJobState(env: Env, id: string): Promise<JobState> {
  return (await env.HQ_CACHE.get<JobState>(jobKey(id), "json")) ?? { done: {} };
}

export async function saveJobState(env: Env, id: string, state: JobState): Promise<void> {
  const now = new Date().toISOString();
  state.updatedAt = now;
  state.createdAt ??= state.job?.requestedAt ?? now;
  const metadata: JobMeta | undefined = state.job && {
    business: state.job.business ?? "",
    kind: state.job.kind ?? "general",
    delivery: state.job.delivery ?? "api",
    owner: state.job.owner,
    task: clip(state.job.task, 160),
    status: state.status ?? "queued",
    source: state.job.source.kind,
    createdAt: state.createdAt,
    updatedAt: now,
    ...(state.result ? { summary: clip(state.result.summary, 200) } : {}),
    ...(state.error ? { error: clip(state.error, 200) } : {}),
  };
  await env.HQ_CACHE.put(jobKey(id), JSON.stringify(state), {
    expirationTtl: JOB_TTL_SECONDS,
    ...(metadata ? { metadata } : {}),
  });
}

/** Read-modify-write of a job's status. Best-effort bookkeeping; KV is eventually consistent. */
export async function markJob(
  env: Env,
  job: DispatchJob,
  patch: Pick<JobState, "status"> & Partial<Pick<JobState, "error" | "attempts">>,
): Promise<JobState> {
  const state = await loadJobState(env, job.id);
  state.job ??= job;
  Object.assign(state, patch);
  if (patch.status && patch.status !== "failed" && patch.status !== "retrying") delete state.error;
  await saveJobState(env, job.id, state);
  return state;
}

export interface JobListItem extends JobMeta {
  id: string;
}

/** Most recent jobs first. KV list returns keys in id order, so we sort by metadata. */
export interface JobFilter {
  owner?: string;
  business?: string;
  statuses?: readonly JobStatus[];
}

export async function listJobs(env: Env, limit = 50, filter: JobFilter = {}): Promise<JobListItem[]> {
  const items: JobListItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.HQ_CACHE.list<JobMeta>({ prefix: JOB_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const k of page.keys) {
      const m = k.metadata;
      if (!m) continue;
      if (filter.owner && m.owner !== filter.owner) continue;
      if (filter.business && m.business !== filter.business) continue;
      if (filter.statuses && !filter.statuses.includes(m.status)) continue;
      items.push({ id: k.name.slice(JOB_PREFIX.length), ...m });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && items.length < 5000);
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
