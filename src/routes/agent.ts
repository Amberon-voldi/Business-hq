import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { briefingMarkdown } from "../agents/onboarding";
import { AGENTS, OWNERS, type Owner, TASK_KINDS, TASK_KIND_KEYS, type TaskKind, parseOwner } from "../agents/registry";
import { deliveryFor, getConfig } from "../config/store";
import { listJobs, loadJobState, markJob } from "../dispatch/jobs";
import { completeExternally, reportFailure } from "../dispatch/run";
import { startDispatch } from "../dispatch/start";
import type { DispatchJob } from "../dispatch/types";
import type { AppBindings } from "../env";
import { ownerFromAgentToken } from "../lib/agentTokens";
import { DispatchError, HttpError, errorMessage } from "../lib/errors";
import { formatLogTimestamp } from "../lib/time";
import { createNotion } from "../notion/client";
import { appendLogEntry } from "../notion/writeback";
import { businessFromRef, loadContexts, promptForJob } from "./util";

/**
 * API for external agents (Grok, Muse… running in their own apps). Each intern
 * authenticates with its own derived token and can only see and act on its own tasks.
 */
export const agentRoutes = new Hono<AppBindings>();

const MAX_DELEGATION_DEPTH = 3;

const requireAgent = createMiddleware<AppBindings>(async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const owner = token ? await ownerFromAgentToken(c.env.WEBHOOK_SECRET, token) : null;
  if (!owner) throw new HttpError(401, "Invalid agent token. Get yours from the panel: Agents tab.");
  c.set("agent", owner);
  await next();
});
agentRoutes.use("*", requireAgent);

const me = (c: { get: (k: "agent") => Owner | undefined }): Owner => c.get("agent") as Owner;

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => {
    throw new HttpError(400, "Body must be JSON");
  });
}

/** Loads a task and checks it belongs to the calling intern. */
async function ownTask(c: Parameters<typeof me>[0] & { env: AppBindings["Bindings"] }, id: string) {
  const state = await loadJobState(c.env, id);
  if (!state.job) throw new HttpError(404, "Task not found (tasks are kept for 7 days)");
  if (state.job.owner !== me(c)) throw new HttpError(403, `This task belongs to ${state.job.owner}`);
  return state as typeof state & { job: DispatchJob };
}

agentRoutes.get("/me", async (c) => {
  const owner = me(c);
  const config = await getConfig(c.env);
  return c.json({
    owner,
    role: AGENTS[owner].role,
    delivery: deliveryFor(config, owner),
    businesses: config.businesses.map((b) => ({ id: b.id, name: b.name, domain: b.domain, description: b.description })),
    defaultBusiness: config.defaultBusiness,
    teammates: OWNERS.filter((o) => o !== owner).map((o) => ({ owner: o, role: AGENTS[o].role })),
    taskKinds: Object.fromEntries(TASK_KIND_KEYS.map((k) => [k, { label: TASK_KINDS[k].label, suggestedOwner: TASK_KINDS[k].owner }])),
  });
});

/** Shared context, as Markdown (default) or JSON (?format=json). */
agentRoutes.get("/briefing", async (c) => {
  const owner = me(c);
  const config = await getConfig(c.env);
  const ref = c.req.query("business");
  const only = ref ? await businessFromRef(c.env, ref) : undefined;
  const contexts = await loadContexts(c.env, config, only);
  if (c.req.query("format") === "json") {
    return c.json({
      owner,
      businesses: contexts.map(({ business, context, error }) => ({
        id: business.id,
        name: business.name,
        error: error ?? null,
        fetchedAt: context?.fetchedAt ?? null,
        sections: Object.fromEntries(Object.entries(context?.sections ?? {}).filter(([k]) => k !== "log").map(([k, s]) => [k, s?.markdown ?? ""])),
      })),
    });
  }
  return c.text(briefingMarkdown(owner, config, contexts), 200, { "content-type": "text/markdown; charset=utf-8" });
});

agentRoutes.get("/tasks", async (c) => {
  const owner = me(c);
  const items = await listJobs(c.env, 50, { owner, statuses: ["assigned", "running"] });
  return c.json({
    owner,
    tasks: items
      .filter((j) => j.delivery === "inbox")
      .reverse() // oldest first: work the queue in order
      .map((j) => ({ id: j.id, business: j.business, kind: j.kind, status: j.status, task: j.task, createdAt: j.createdAt })),
  });
});

agentRoutes.get("/tasks/:id", async (c) => {
  const state = await ownTask(c, c.req.param("id"));
  const job = state.job;
  return c.json({
    id: job.id,
    business: job.business,
    kind: job.kind ?? "general",
    status: state.status,
    task: job.task,
    details: job.details ?? {},
    delegatedBy: job.delegation?.by ?? null,
    notionTaskUrl: job.taskPageId ? `https://www.notion.so/${job.taskPageId.replace(/-/g, "")}` : null,
    prompt: await promptForJob(c.env, job),
  });
});

agentRoutes.post("/tasks/:id/claim", async (c) => {
  const state = await ownTask(c, c.req.param("id"));
  if (state.status !== "assigned" && state.status !== "running") throw new HttpError(409, `Task is ${state.status}`);
  await markJob(c.env, state.job, { status: "running" });
  return c.json({ id: state.job.id, status: "running" });
});

const CompleteBody = z.object({
  output: z.string().trim().min(1, "output is required").max(100_000),
  summary: z.string().trim().max(500).optional(),
});

agentRoutes.post("/tasks/:id/complete", async (c) => {
  const owner = me(c);
  const state = await ownTask(c, c.req.param("id"));
  if (state.status === "done") throw new HttpError(409, "Task is already done");
  const body = CompleteBody.safeParse(await readJson(c));
  if (!body.success) throw new HttpError(422, "Invalid result", z.flattenError(body.error).fieldErrors);
  try {
    const result = await completeExternally(c.env, state.job.id, { ...body.data, by: owner });
    return c.json({ id: state.job.id, status: "done", summary: result.summary, warnings: result.warnings });
  } catch (err) {
    // The result is saved; a retry of this call resumes the remaining write-backs.
    const status = err instanceof DispatchError && !err.retryable ? 422 : 502;
    throw new HttpError(status, errorMessage(err));
  }
});

agentRoutes.post("/tasks/:id/fail", async (c) => {
  const state = await ownTask(c, c.req.param("id"));
  if (state.status === "done") throw new HttpError(409, "Task is already done");
  const body = z.object({ reason: z.string().trim().min(1).max(2000) }).safeParse(await readJson(c));
  if (!body.success) throw new HttpError(422, "reason is required");
  await reportFailure(c.env, state.job, new Error(`${me(c)}: ${body.data.reason}`));
  return c.json({ id: state.job.id, status: "failed" });
});

const DelegateBody = z.object({
  task: z.string().trim().min(1).max(20_000),
  owner: z.string().optional(),
  kind: z.enum(TASK_KIND_KEYS as [TaskKind, ...TaskKind[]]).default("general"),
  business: z.string().optional(),
  notes: z.string().trim().max(20_000).optional(),
  parent_task_id: z.string().optional(),
});

agentRoutes.post("/delegate", async (c) => {
  const from = me(c);
  const parsed = DelegateBody.safeParse(await readJson(c));
  if (!parsed.success) throw new HttpError(422, "Invalid delegation", z.flattenError(parsed.error).fieldErrors);
  const body = parsed.data;

  const owner = parseOwner(body.owner) ?? (body.owner ? null : TASK_KINDS[body.kind].owner);
  if (!owner) throw new HttpError(422, `owner must be one of ${OWNERS.join("|")} (or give a kind that implies one)`);
  if (owner === from) throw new HttpError(422, "You can't delegate to yourself; just do the task");

  let depth = 1;
  let business = body.business;
  if (body.parent_task_id) {
    const parent = await loadJobState(c.env, body.parent_task_id);
    if (parent.job) {
      depth = (parent.job.delegation?.depth ?? 0) + 1;
      business ??= parent.job.business;
    }
  }
  if (depth > MAX_DELEGATION_DEPTH) {
    throw new HttpError(422, `Delegation chain is too deep (max ${MAX_DELEGATION_DEPTH}). Finish the task or fail it with a reason.`);
  }
  const target = await businessFromRef(c.env, business);

  const job: DispatchJob = {
    id: crypto.randomUUID(),
    business: target.id,
    task: body.task,
    owner,
    kind: body.kind,
    details: { "Delegated by": from, ...(body.notes ? { "Notes from teammate": body.notes } : {}) },
    source: { kind: "agent", by: from },
    delegation: { by: from, depth, ...(body.parent_task_id ? { parentJobId: body.parent_task_id } : {}) },
    requestedAt: new Date().toISOString(),
  };
  const outcome = await startDispatch(c.env, job, { async: true });
  return c.json({ id: job.id, owner, business: target.id, status: outcome.mode }, 202);
});

agentRoutes.post("/log", async (c) => {
  const owner = me(c);
  const body = z
    .object({ business: z.string().optional(), message: z.string().trim().min(1).max(2000) })
    .safeParse(await readJson(c));
  if (!body.success) throw new HttpError(422, "message is required");
  const business = await businessFromRef(c.env, body.data.business);
  if (!business.hqPageId) throw new HttpError(409, `${business.name} has no Notion HQ page yet`);
  await appendLogEntry(createNotion(c.env, business), business.hqPageId, {
    timestamp: formatLogTimestamp(new Date(), Number(c.env.LOG_TIMEZONE_OFFSET_MINUTES) || 0),
    agent: owner,
    task: "Note",
    outcome: "event",
    summary: body.data.message,
  });
  return c.json({ ok: true, business: business.id });
});
