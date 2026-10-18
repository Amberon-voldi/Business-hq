import { Hono } from "hono";
import { z } from "zod";
import { OWNERS, parseOwner } from "../agents/registry";
import { enqueueDispatch } from "../dispatch/queue";
import { activeTaskKey, markTaskActive, reportFailure, runDispatch } from "../dispatch/run";
import type { DispatchJob } from "../dispatch/types";
import type { AppBindings } from "../env";
import { DispatchError, HttpError } from "../lib/errors";
import { createNotion, normalizeNotionId } from "../notion/client";
import { CONTEXT_SECTION_KEYS } from "../notion/types";
import { updateTaskStatus } from "../notion/writeback";
import { requireSharedSecret } from "./auth";

const DispatchBody = z.object({
  task: z.string().trim().min(1, "task is required").max(20_000),
  owner: z
    .string()
    .transform((v, ctx) => {
      const owner = parseOwner(v);
      if (!owner) {
        ctx.addIssue({ code: "custom", message: `owner must be one of ${OWNERS.join("|")}` });
        return z.NEVER;
      }
      return owner;
    }),
  context_sections: z.array(z.enum(CONTEXT_SECTION_KEYS as [string, ...string[]])).optional(),
  /** Optional Task Board row to update with status + deliverable. */
  notion_task_id: z.string().optional(),
  /** false = run inline and return the result in the response (slow; up to minutes). */
  async: z.boolean().default(true),
});

export const dispatchRoutes = new Hono<AppBindings>();

dispatchRoutes.post("/", requireSharedSecret, async (c) => {
  const json = await c.req.json().catch(() => {
    throw new HttpError(400, "Body must be JSON");
  });
  const parsed = DispatchBody.safeParse(json);
  if (!parsed.success) throw new HttpError(422, "Invalid dispatch request", z.flattenError(parsed.error).fieldErrors);
  const body = parsed.data;

  let taskPageId: string | undefined;
  if (body.notion_task_id) {
    try {
      taskPageId = normalizeNotionId(body.notion_task_id);
    } catch {
      throw new HttpError(422, "notion_task_id is not a valid Notion page id or URL");
    }
  }

  const job: DispatchJob = {
    id: crypto.randomUUID(),
    task: body.task,
    owner: body.owner,
    ...(body.context_sections ? { contextSections: body.context_sections as DispatchJob["contextSections"] } : {}),
    ...(taskPageId ? { taskPageId } : {}),
    source: { kind: "manual" },
    requestedAt: new Date().toISOString(),
  };

  if (taskPageId) {
    if (!(await markTaskActive(c.env, taskPageId, job.id))) {
      throw new HttpError(409, "That task already has a dispatch in progress");
    }
    try {
      await updateTaskStatus(createNotion(c.env), taskPageId, "In progress");
    } catch (err) {
      await c.env.HQ_CACHE.delete(activeTaskKey(taskPageId));
      throw new HttpError(502, `Could not update the Notion task: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (body.async) {
    try {
      await enqueueDispatch(c.env, job);
    } catch (err) {
      if (taskPageId) await c.env.HQ_CACHE.delete(activeTaskKey(taskPageId));
      throw err;
    }
    return c.json({ id: job.id, status: "queued", owner: job.owner }, 202);
  }

  try {
    const result = await runDispatch(c.env, job);
    return c.json({ status: "done", ...result });
  } catch (err) {
    await reportFailure(c.env, job, err);
    const status = err instanceof DispatchError && err.retryable ? 503 : 502;
    throw new HttpError(status, err instanceof Error ? err.message : "Dispatch failed", { id: job.id });
  }
});
