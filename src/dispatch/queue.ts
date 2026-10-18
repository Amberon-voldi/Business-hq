import type { Env } from "../env";
import { DispatchError, errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { markJob } from "./jobs";
import { reportFailure, runDispatch } from "./run";
import type { DispatchJob } from "./types";

/** Must match `max_retries` for the consumer in wrangler.jsonc. */
const MAX_RETRIES = 3;

export async function enqueueDispatch(env: Env, job: DispatchJob): Promise<void> {
  await env.DISPATCH_QUEUE.send(job, { contentType: "json" });
  await markJob(env, job, { status: "queued" }).catch((err: unknown) =>
    log("warn", "job_record_failed", { jobId: job.id, error: errorMessage(err) }),
  );
  log("info", "dispatch_queued", { jobId: job.id, owner: job.owner, source: job.source.kind, taskPageId: job.taskPageId });
}

export async function handleQueueBatch(batch: MessageBatch<DispatchJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    try {
      await runDispatch(env, job);
      message.ack();
    } catch (err) {
      const retryable = !(err instanceof DispatchError) || err.retryable;
      if (retryable && message.attempts <= MAX_RETRIES) {
        const delaySeconds = Math.min(30 * 2 ** (message.attempts - 1), 600);
        log("warn", "dispatch_retry", { jobId: job.id, attempt: message.attempts, delaySeconds, error: errorMessage(err) });
        message.retry({ delaySeconds });
        await markJob(env, job, { status: "retrying", error: errorMessage(err), attempts: message.attempts }).catch(
          () => undefined,
        );
        continue;
      }
      await reportFailure(env, job, err);
      message.ack();
    }
  }
}
