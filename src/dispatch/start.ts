import { AGENTS } from "../agents/registry";
import { deliveryFor, findBusiness, getConfig } from "../config/store";
import type { Env } from "../env";
import { DispatchError, HttpError, errorMessage } from "../lib/errors";
import { createNotion } from "../notion/client";
import { updateTaskStatus } from "../notion/writeback";
import { pushToAgent } from "../hub/notify";
import { markJob } from "./jobs";
import { enqueueDispatch } from "./queue";
import { activeTaskKey, markTaskActive, reportFailure, runDispatch } from "./run";
import type { DispatchJob, DispatchResult } from "./types";

export type StartOutcome =
  | { mode: "queued"; id: string }
  | { mode: "assigned"; id: string }
  | { mode: "done"; result: DispatchResult };

/**
 * Starts a dispatch from any entry point. Resolves the business and the intern's
 * delivery ("api" → queue, "inbox" → waits for the external agent), and when the job
 * is linked to a Notion task, locks it and moves it to "In progress" first.
 */
export async function startDispatch(
  env: Env,
  job: DispatchJob,
  opts: { async: boolean; /** Caller already locked the task and it's already "In progress" (Notion trigger). */ taskLocked?: boolean },
): Promise<StartOutcome> {
  const config = await getConfig(env);
  const business = findBusiness(config, job.business);
  if (!business) throw new HttpError(422, `Unknown business "${job.business}"`);
  job.business = business.id;
  const apiKeySet = AGENTS[job.owner].provider === "xai" ? Boolean(env.XAI_API_KEY) : Boolean(env.ANTHROPIC_API_KEY);
  if (job.delivery === "api" && !apiKeySet) {
    throw new HttpError(422, `${job.owner} can't run via API: no ${AGENTS[job.owner].provider === "xai" ? "XAI_API_KEY" : "ANTHROPIC_API_KEY"} is set. Use inbox delivery.`);
  }
  // Without the provider's key an intern always works from its inbox, so nothing is ever billed per token by accident.
  job.delivery ??= apiKeySet ? deliveryFor(config, job.owner) : "inbox";

  const pageId = job.taskPageId;
  if (pageId && !opts.taskLocked) {
    if (!(await markTaskActive(env, pageId, job.id))) {
      throw new HttpError(409, "That task already has a dispatch in progress");
    }
    try {
      await updateTaskStatus(createNotion(env, business), pageId, "In progress");
    } catch (err) {
      await env.HQ_CACHE.delete(activeTaskKey(pageId));
      throw new HttpError(502, `Could not update the Notion task: ${errorMessage(err)}`);
    }
  }

  if (job.delivery === "inbox") {
    const state = await markJob(env, job, { status: "assigned" });
    await pushToAgent(env, job.owner, {
      type: "task",
      task: {
        id: job.id,
        business: business.id,
        kind: job.kind ?? "general",
        status: "assigned",
        task: job.task,
        createdAt: state.createdAt ?? job.requestedAt,
      },
    });
    return { mode: "assigned", id: job.id };
  }

  if (opts.async) {
    try {
      await enqueueDispatch(env, job);
    } catch (err) {
      if (pageId) await env.HQ_CACHE.delete(activeTaskKey(pageId));
      throw err;
    }
    return { mode: "queued", id: job.id };
  }

  try {
    return { mode: "done", result: await runDispatch(env, job) };
  } catch (err) {
    await reportFailure(env, job, err);
    const status = err instanceof DispatchError && err.retryable ? 503 : 502;
    throw new HttpError(status, errorMessage(err), { id: job.id });
  }
}
