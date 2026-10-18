import { type Client, isFullPage, collectPaginatedAPI, isFullBlock } from "@notionhq/client";
import { lintBrand } from "../agents/brand";
import { callClaude } from "../agents/claude";
import { callGrok } from "../agents/grok";
import { buildPrompt, splitSummary } from "../agents/prompt";
import { AGENTS } from "../agents/registry";
import type { Env } from "../env";
import { DispatchError, errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { postSlackReply, slackSummary } from "../lib/slack";
import { formatLogTimestamp } from "../lib/time";
import { createNotion } from "../notion/client";
import { getHqContext, isRetryableNotionError } from "../notion/hq";
import { nodeToMarkdown, richTextToPlain } from "../notion/parse";
import { taskDetails } from "../notion/properties";
import type { HqTable } from "../notion/types";
import { appendDeliverable, appendLogEntry, updateTaskStatus } from "../notion/writeback";
import type { DispatchJob, DispatchResult } from "./types";

/** Per-job progress kept in KV so a retried message never re-runs the LLM or double-writes Notion. */
interface JobState {
  result?: DispatchResult;
  done: { deliverable?: boolean; status?: boolean; log?: boolean; notify?: boolean };
}

const STATE_TTL_SECONDS = 60 * 60 * 24 * 3;
const ACTIVE_TTL_SECONDS = 60 * 60;

const stateKey = (id: string) => `job:${id}`;
export const activeTaskKey = (pageId: string) => `active-task:${pageId}`;

async function loadState(env: Env, id: string): Promise<JobState> {
  return (await env.HQ_CACHE.get<JobState>(stateKey(id), "json")) ?? { done: {} };
}

async function saveState(env: Env, id: string, state: JobState): Promise<void> {
  await env.HQ_CACHE.put(stateKey(id), JSON.stringify(state), { expirationTtl: STATE_TTL_SECONDS });
}

/** Marks a Notion task as being worked on so duplicate webhooks don't double-dispatch it. */
export async function markTaskActive(env: Env, pageId: string, jobId: string): Promise<boolean> {
  const existing = await env.HQ_CACHE.get(activeTaskKey(pageId));
  if (existing) return false;
  await env.HQ_CACHE.put(activeTaskKey(pageId), jobId, { expirationTtl: ACTIVE_TTL_SECONDS });
  return true;
}

function timestamp(env: Env, date = new Date()): string {
  return formatLogTimestamp(date, Number(env.LOG_TIMEZONE_OFFSET_MINUTES) || 0);
}

/**
 * The core pipeline: load scoped HQ context -> call the agent -> brand-check ->
 * write deliverable, status and audit log back to Notion -> notify Slack.
 * Throws DispatchError; `retryable` tells the queue consumer whether to retry.
 */
export async function runDispatch(env: Env, job: DispatchJob): Promise<DispatchResult> {
  const notion = createNotion(env);
  const state = await loadState(env, job.id);

  if (!state.result) {
    state.result = await generate(env, notion, job);
    await saveState(env, job.id, state);
  } else {
    log("info", "dispatch_resume", { jobId: job.id, done: state.done });
  }
  const result = state.result;
  const when = timestamp(env, new Date(result.completedAt));

  await step(env, job, state, "deliverable", async () => {
    if (!job.taskPageId) return;
    await appendDeliverable(notion, job.taskPageId, {
      agent: `${job.owner} (${result.model})`,
      timestamp: when,
      markdown: result.output,
      warnings: result.warnings,
    });
  });

  await step(env, job, state, "status", async () => {
    if (job.taskPageId) await updateTaskStatus(notion, job.taskPageId, "Done");
  });

  await step(env, job, state, "log", async () => {
    await appendLogEntry(notion, env.NOTION_HQ_PAGE_ID, {
      timestamp: when,
      agent: job.owner,
      task: job.task,
      outcome: "done",
      summary: result.warnings.length ? `${result.summary} (⚠️ ${result.warnings.length} warning(s))` : result.summary,
      taskUrl: job.taskPageId ? `https://www.notion.so/${job.taskPageId.replace(/-/g, "")}` : null,
      // Without a task page, the log entry is the only home for the deliverable.
      ...(job.taskPageId ? {} : { detailMarkdown: result.output }),
    });
  });

  await step(env, job, state, "notify", async () => {
    if (job.source.kind !== "slack") return;
    await postSlackReply(env.SLACK_BOT_TOKEN, {
      text: slackSummary(job.owner, result.summary, result.output, result.warnings),
      responseUrl: job.source.responseUrl,
      channel: job.source.channel,
      threadTs: job.source.threadTs,
    });
  });

  if (job.taskPageId) await env.HQ_CACHE.delete(activeTaskKey(job.taskPageId));
  log("info", "dispatch_done", { jobId: job.id, owner: job.owner, model: result.model, warnings: result.warnings });
  return result;
}

async function step(
  env: Env,
  job: DispatchJob,
  state: JobState,
  name: keyof JobState["done"],
  fn: () => Promise<void>,
): Promise<void> {
  if (state.done[name]) return;
  try {
    await fn();
  } catch (err) {
    // The LLM result is already saved, so retrying only redoes the write-backs that failed.
    const retryable = name === "notify" ? true : isRetryableNotionError(err);
    throw new DispatchError(`Write-back step "${name}" failed: ${errorMessage(err)}`, retryable, { cause: err });
  }
  state.done[name] = true;
  await saveState(env, job.id, state);
}

async function generate(env: Env, notion: Client, job: DispatchJob): Promise<DispatchResult> {
  let context;
  try {
    ({ context } = await getHqContext(env));
  } catch (err) {
    throw new DispatchError(`Could not load HQ context from Notion: ${errorMessage(err)}`, isRetryableNotionError(err), {
      cause: err,
    });
  }

  const details = { ...(job.details ?? {}) };
  if (job.taskPageId) Object.assign(details, await loadTaskPageDetails(notion, job.taskPageId));

  const prompt = buildPrompt({
    owner: job.owner,
    task: job.task,
    context,
    requestedSections: job.contextSections,
    details,
  });

  const profile = AGENTS[job.owner];
  const call = { system: prompt.system, user: prompt.user };
  const output = profile.provider === "xai" ? await callGrok(env, call) : await callClaude(env, call);

  const { summary, body } = splitSummary(output.text);
  const warnings = [...output.warnings, ...(prompt.brandSafety ? lintBrand(body) : [])];

  return {
    id: job.id,
    owner: job.owner,
    provider: output.provider,
    model: output.model,
    summary: summary || "Completed.",
    output: body || output.text,
    warnings,
    sectionsUsed: prompt.sectionsUsed,
    brandSafety: prompt.brandSafety,
    completedAt: new Date().toISOString(),
  };
}

/** Task row properties + the page's body (notes, acceptance criteria) as extra prompt context. */
async function loadTaskPageDetails(notion: Client, pageId: string): Promise<Record<string, string>> {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const details = isFullPage(page) ? taskDetails(page) : {};
    const blocks = (
      await collectPaginatedAPI(notion.blocks.children.list, { block_id: pageId, page_size: 100 })
    ).filter(isFullBlock);
    // Only the notes above the first deliverable this worker wrote, so outputs don't snowball on re-runs.
    const firstDeliverable = blocks.findIndex(
      (b) => b.type === "heading_3" && richTextToPlain(b.heading_3.rich_text).startsWith("Deliverable ·"),
    );
    let end = firstDeliverable < 0 ? blocks.length : firstDeliverable;
    if (firstDeliverable > 0 && blocks[end - 1]?.type === "divider") end -= 1;
    const tables: HqTable[] = [];
    const notes = blocks
      .slice(0, end)
      .map((block) => nodeToMarkdown({ block, children: [] }, tables))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (notes) details["Task notes"] = notes.slice(0, 20_000);
    return details;
  } catch (err) {
    if (isRetryableNotionError(err)) {
      throw new DispatchError(`Could not read task page: ${errorMessage(err)}`, true, { cause: err });
    }
    throw new DispatchError(`Task page ${pageId} is not readable by the integration: ${errorMessage(err)}`, false, {
      cause: err,
    });
  }
}

/** Best-effort failure reporting: Blocked status, a ❌ log line, and a Slack reply. Never throws. */
export async function reportFailure(env: Env, job: DispatchJob, err: unknown): Promise<void> {
  const reason = errorMessage(err);
  log("error", "dispatch_failed", { jobId: job.id, owner: job.owner, error: reason });
  const notion = createNotion(env);
  const when = timestamp(env);

  const attempts: Promise<unknown>[] = [
    appendLogEntry(notion, env.NOTION_HQ_PAGE_ID, {
      timestamp: when,
      agent: job.owner,
      task: job.task,
      outcome: "failed",
      summary: reason,
      taskUrl: job.taskPageId ? `https://www.notion.so/${job.taskPageId.replace(/-/g, "")}` : null,
    }),
  ];
  if (job.taskPageId) {
    attempts.push(updateTaskStatus(notion, job.taskPageId, "Blocked"));
    attempts.push(env.HQ_CACHE.delete(activeTaskKey(job.taskPageId)));
  }
  if (job.source.kind === "slack") {
    attempts.push(
      postSlackReply(env.SLACK_BOT_TOKEN, {
        text: `:x: *${job.owner}* couldn't finish "${job.task.slice(0, 200)}": ${reason}`,
        responseUrl: job.source.responseUrl,
        channel: job.source.channel,
        threadTs: job.source.threadTs,
      }),
    );
  }
  const results = await Promise.allSettled(attempts);
  for (const r of results) {
    if (r.status === "rejected") log("error", "failure_report_step_failed", { jobId: job.id, error: errorMessage(r.reason) });
  }
}
