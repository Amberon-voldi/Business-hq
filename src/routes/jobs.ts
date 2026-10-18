import { Hono } from "hono";
import { z } from "zod";
import { type JobStatus, listJobs, loadJobState } from "../dispatch/jobs";
import { completeExternally } from "../dispatch/run";
import { startDispatch } from "../dispatch/start";
import type { DispatchJob } from "../dispatch/types";
import type { AppBindings } from "../env";
import { DispatchError, HttpError, errorMessage } from "../lib/errors";
import { requireSharedSecret } from "./auth";

export const jobRoutes = new Hono<AppBindings>();
jobRoutes.use("*", requireSharedSecret);

/** GET /api/jobs?limit=50&business=&owner=&status=assigned,running — recent jobs, newest first. */
jobRoutes.get("/", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const statuses = c.req.query("status")?.split(",").filter(Boolean) as JobStatus[] | undefined;
  const business = c.req.query("business");
  const owner = c.req.query("owner");
  return c.json({
    jobs: await listJobs(c.env, limit, {
      ...(business ? { business } : {}),
      ...(owner ? { owner } : {}),
      ...(statuses?.length ? { statuses } : {}),
    }),
  });
});

/** POST /api/jobs/:id/complete — paste an offline agent's result for an inbox task. */
jobRoutes.post("/:id/complete", async (c) => {
  const body = z
    .object({ output: z.string().trim().min(1).max(100_000), summary: z.string().trim().max(500).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw new HttpError(422, "output is required");
  try {
    const result = await completeExternally(c.env, c.req.param("id"), { ...body.data, by: "admin" });
    return c.json({ id: c.req.param("id"), status: "done", summary: result.summary, warnings: result.warnings });
  } catch (err) {
    const status = err instanceof DispatchError && !err.retryable ? 422 : 502;
    throw new HttpError(status, errorMessage(err));
  }
});

/** GET /api/jobs/:id — full job record including the agent's output. */
jobRoutes.get("/:id", async (c) => {
  const state = await loadJobState(c.env, c.req.param("id"));
  if (!state.job) throw new HttpError(404, "Job not found (jobs are kept for 7 days)");
  return c.json({ id: c.req.param("id"), ...state });
});

/** POST /api/jobs/:id/retry — re-runs a job's task as a new job. */
jobRoutes.post("/:id/retry", async (c) => {
  const state = await loadJobState(c.env, c.req.param("id"));
  if (!state.job) throw new HttpError(404, "Job not found (jobs are kept for 7 days)");
  if (state.status === "queued" || state.status === "assigned" || state.status === "running" || state.status === "retrying") {
    throw new HttpError(409, `Job is still ${state.status}`);
  }
  const { id: _old, ...rest } = state.job;
  const job: DispatchJob = {
    ...rest,
    id: crypto.randomUUID(),
    // The original Slack response_url may have expired; replies for retries go to Notion only.
    source: rest.source.kind === "slack" ? { kind: "manual" } : rest.source,
    requestedAt: new Date().toISOString(),
  };
  const outcome = await startDispatch(c.env, job, { async: true });
  return c.json({ id: outcome.mode === "queued" ? outcome.id : job.id, status: "queued", retryOf: _old }, 202);
});
