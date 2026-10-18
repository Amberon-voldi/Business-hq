import { type Client, collectPaginatedAPI, isFullBlock, isFullPage } from "@notionhq/client";
import { lintBrand } from "../agents/brand";
import { callClaude } from "../agents/claude";
import { callGrok } from "../agents/grok";
import { buildPrompt, resolveSections, splitSummary } from "../agents/prompt";
import { AGENTS, type Owner } from "../agents/registry";
import { type Business, findBusiness, getConfig } from "../config/store";
import type { Env } from "../env";
import { DispatchError, errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { postSlackReply, slackSummary } from "../lib/slack";
import { formatLogTimestamp } from "../lib/time";
import { createNotion } from "../notion/client";
import { emptyHqContext, getHqContext, isRetryableNotionError } from "../notion/hq";
import { nodeToMarkdown, richTextToPlain } from "../notion/parse";
import { taskDetails } from "../notion/properties";
import type { HqTable } from "../notion/types";
import { appendDeliverable, appendLogEntry, updateTaskStatus } from "../notion/writeback";
import { sendMessage } from "../team/messages";
import { type JobState, loadJobState, markJob, saveJobState } from "./jobs";
import type { DispatchJob, DispatchResult } from "./types";

const ACTIVE_TTL_SECONDS = 60 * 60 * 24; // inbox tasks can sit for a while before an agent picks them up

export const activeTaskKey = (pageId: string) => `active-task:${pageId}`;

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

const notionUrl = (pageId: string) => `https://www.notion.so/${pageId.replace(/-/g, "")}`;

export async function businessForJob(env: Env, job: DispatchJob): Promise<Business> {
  const business = findBusiness(await getConfig(env), job.business);
  if (!business) throw new DispatchError(`Unknown business "${job.business}" — check the Directory tab.`, false);
  return business;
}

/**
 * The worker-run pipeline: load the business's scoped HQ context -> call the model ->
 * brand-check -> write back to Notion -> notify Slack. Throws DispatchError; `retryable`
 * tells the queue consumer whether to retry.
 */
export async function runDispatch(env: Env, job: DispatchJob): Promise<DispatchResult> {
  const business = await businessForJob(env, job);
  const state = await loadJobState(env, job.id);
  state.job ??= job;
  state.status = "running";
  delete state.error;
  await saveJobState(env, job.id, state);

  if (!state.result) {
    state.result = await generate(env, business, createNotion(env, business), job);
    await saveJobState(env, job.id, state);
  } else {
    log("info", "dispatch_resume", { jobId: job.id, done: state.done });
  }
  return finalize(env, job, business, state);
}

/**
 * An external agent (or a human pasting an offline answer) submits the result of an
 * inbox task. Runs the same brand check and Notion write-back as worker-run jobs.
 */
export async function completeExternally(
  env: Env,
  jobId: string,
  input: { output: string; summary?: string | undefined; by: Owner | "admin" },
): Promise<DispatchResult> {
  const state = await loadJobState(env, jobId);
  const job = state.job;
  if (!job) throw new DispatchError("Job not found (jobs are kept for 7 days)", false);
  if (state.status === "done") throw new DispatchError("Job is already done", false);
  const business = await businessForJob(env, job);

  if (!state.result) {
    const split = input.summary ? { summary: input.summary.trim(), body: input.output.trim() } : splitSummary(input.output);
    const kind = job.kind ?? "general";
    const { sections, brandSafety } = resolveSections(job.owner, job.task, job.contextSections, kind);
    const body = split.body || input.output.trim();
    state.result = {
      id: job.id,
      owner: job.owner,
      provider: "external",
      model: input.by === "admin" ? "external agent (submitted via panel)" : `${input.by} (external agent)`,
      summary: split.summary || "Completed.",
      output: body,
      warnings: brandSafety ? lintBrand(body, business) : [],
      sectionsUsed: sections,
      brandSafety,
      completedAt: new Date().toISOString(),
    };
  }
  state.job = job;
  state.status = "running";
  await saveJobState(env, job.id, state);
  return finalize(env, job, business, state);
}

async function finalize(env: Env, job: DispatchJob, business: Business, state: JobState): Promise<DispatchResult> {
  const result = state.result as DispatchResult;
  const notion = createNotion(env, business);
  const when = timestamp(env, new Date(result.completedAt));
  const agentLabel = job.delegation ? `${job.owner} ← ${job.delegation.by}` : job.owner;

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
    if (!business.hqPageId) return;
    await appendLogEntry(notion, business.hqPageId, {
      timestamp: when,
      agent: agentLabel,
      task: job.task,
      outcome: "done",
      summary: result.warnings.length ? `${result.summary} (⚠️ ${result.warnings.length} warning(s))` : result.summary,
      taskUrl: job.taskPageId ? notionUrl(job.taskPageId) : null,
      // Without a task page, the log entry is the only home for the deliverable.
      ...(job.taskPageId ? {} : { detailMarkdown: result.output }),
    });
  });

  await step(env, job, state, "notify", async () => {
    if (job.source.kind !== "slack") return;
    await postSlackReply(env.SLACK_BOT_TOKEN, {
      text: slackSummary(`${job.owner} · ${business.name}`, result.summary, result.output, result.warnings),
      responseUrl: job.source.responseUrl,
      channel: job.source.channel,
      threadTs: job.source.threadTs,
    });
  });

  await step(env, job, state, "team", async () => {
    // Close the loop with whoever handed this over.
    if (!job.delegation) return;
    await sendMessage(env, {
      from: job.owner,
      to: job.delegation.by,
      text: `Done: "${job.task.slice(0, 160)}" — ${result.summary.replace(/[.\s]+$/, "")}${result.warnings.length ? ` (⚠️ ${result.warnings.length} warning(s))` : ""}. Full output is in ${business.name}'s Notion (task ${job.id}).`,
      business: business.id,
      taskId: job.id,
    });
  });

  state.status = "done";
  await saveJobState(env, job.id, state);
  if (job.taskPageId) await env.HQ_CACHE.delete(activeTaskKey(job.taskPageId));
  log("info", "dispatch_done", { jobId: job.id, business: business.id, owner: job.owner, model: result.model });
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
    // The result is already saved, so retrying only redoes the write-backs that failed.
    const retryable = name === "notify" || name === "team" ? true : isRetryableNotionError(err);
    throw new DispatchError(`Write-back step "${name}" failed: ${errorMessage(err)}`, retryable, { cause: err });
  }
  state.done[name] = true;
  await saveJobState(env, job.id, state);
}

async function generate(env: Env, business: Business, notion: Client, job: DispatchJob): Promise<DispatchResult> {
  let context = emptyHqContext(business);
  const noHq = !business.hqPageId;
  try {
    if (!noHq) ({ context } = await getHqContext(env, business));
  } catch (err) {
    throw new DispatchError(
      `Could not load ${business.name}'s HQ context from Notion: ${errorMessage(err)}`,
      isRetryableNotionError(err),
      { cause: err },
    );
  }

  const details = { ...(job.details ?? {}) };
  if (job.taskPageId) Object.assign(details, await loadTaskPageDetails(notion, job.taskPageId));

  const prompt = buildPrompt({
    owner: job.owner,
    task: job.task,
    kind: job.kind,
    business,
    context,
    requestedSections: job.contextSections,
    details,
  });

  const call = { system: prompt.system, user: prompt.user };
  const output = AGENTS[job.owner].provider === "xai" ? await callGrok(env, call) : await callClaude(env, call);

  const { summary, body } = splitSummary(output.text);
  const warnings = [
    ...(noHq ? [`${business.name} has no Notion HQ doc connected, so this was written from the directory description only.`] : []),
    ...output.warnings,
    ...(prompt.brandSafety ? lintBrand(body, business) : []),
  ];

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
export async function loadTaskPageDetails(notion: Client, pageId: string): Promise<Record<string, string>> {
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
  log("error", "dispatch_failed", { jobId: job.id, business: job.business, owner: job.owner, error: reason });
  const attempts: Promise<unknown>[] = [markJob(env, job, { status: "failed", error: reason })];

  const business = await businessForJob(env, job).catch(() => null);
  if (business) {
    const notion = createNotion(env, business);
    if (business.hqPageId) {
      attempts.push(
        appendLogEntry(notion, business.hqPageId, {
          timestamp: timestamp(env),
          agent: job.owner,
          task: job.task,
          outcome: "failed",
          summary: reason,
          taskUrl: job.taskPageId ? notionUrl(job.taskPageId) : null,
        }),
      );
    }
    if (job.taskPageId) attempts.push(updateTaskStatus(notion, job.taskPageId, "Blocked"));
  }
  if (job.taskPageId) attempts.push(env.HQ_CACHE.delete(activeTaskKey(job.taskPageId)));
  attempts.push(
    sendMessage(env, {
      from: job.owner,
      to: job.delegation?.by ?? "Human",
      text: `Blocked on "${job.task.slice(0, 160)}": ${reason}`,
      ...(job.business ? { business: job.business } : {}),
      taskId: job.id,
    }),
  );
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
