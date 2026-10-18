import { z } from "zod";
import { deliveryFor, getConfig } from "../config/store";
import { listJobs, loadJobState, markJob } from "../dispatch/jobs";
import { completeExternally, reportFailure } from "../dispatch/run";
import { startDispatch } from "../dispatch/start";
import type { DispatchJob } from "../dispatch/types";
import type { Env } from "../env";
import { DispatchError, HttpError, errorMessage } from "../lib/errors";
import { formatLogTimestamp } from "../lib/time";
import { createNotion } from "../notion/client";
import { appendLogEntry } from "../notion/writeback";
import { businessFromRef, loadContexts, promptForJob } from "../routes/util";
import { parseRecipient, readInbox, sendMessage, teamFeed, unreadCount } from "../team/messages";
import { briefingMarkdown } from "./onboarding";
import { AGENTS, OWNERS, type Owner, TASK_KINDS, TASK_KIND_KEYS, type TaskKind, parseOwner } from "./registry";

/**
 * Everything an intern can do, shared by the HTTP agent API (/agent/v1) and the MCP
 * connector (/mcp/<token>). Throws HttpError with a message written for the agent.
 */

const MAX_DELEGATION_DEPTH = 3;

function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw new HttpError(422, `Invalid ${what}: ${z.prettifyError(result.error)}`);
  return result.data;
}

async function ownTask(env: Env, owner: Owner, id: string) {
  if (!id) throw new HttpError(422, "task id is required");
  const state = await loadJobState(env, id);
  if (!state.job) throw new HttpError(404, "Task not found (tasks are kept for 7 days)");
  if (state.job.owner !== owner) throw new HttpError(403, `This task belongs to ${state.job.owner}`);
  return state as typeof state & { job: DispatchJob };
}

export async function whoAmI(env: Env, owner: Owner) {
  const config = await getConfig(env);
  return {
    owner,
    role: AGENTS[owner].role,
    delivery: deliveryFor(config, owner),
    businesses: config.businesses.map((b) => ({ id: b.id, aliases: b.aliases, name: b.name, domain: b.domain, description: b.description })),
    defaultBusiness: config.defaultBusiness,
    teammates: OWNERS.filter((o) => o !== owner).map((o) => ({ owner: o, role: AGENTS[o].role })),
    taskKinds: Object.fromEntries(TASK_KIND_KEYS.map((k) => [k, { label: TASK_KINDS[k].label, suggestedOwner: TASK_KINDS[k].owner }])),
    unreadMessages: await unreadCount(env, owner),
  };
}

export async function briefing(env: Env, owner: Owner, businessRef?: string): Promise<string> {
  const config = await getConfig(env);
  const only = businessRef ? await businessFromRef(env, businessRef) : undefined;
  return briefingMarkdown(owner, config, await loadContexts(env, config, only));
}

export async function listTasks(env: Env, owner: Owner) {
  const items = await listJobs(env, 50, { owner, statuses: ["assigned", "running"] });
  return items
    .filter((j) => j.delivery === "inbox")
    .reverse() // oldest first: work the queue in order
    .map((j) => ({ id: j.id, business: j.business, kind: j.kind, status: j.status, task: j.task, createdAt: j.createdAt }));
}

export async function getTask(env: Env, owner: Owner, id: string) {
  const state = await ownTask(env, owner, id);
  const job = state.job;
  return {
    id: job.id,
    business: job.business,
    kind: job.kind ?? "general",
    status: state.status,
    task: job.task,
    details: job.details ?? {},
    delegatedBy: job.delegation?.by ?? null,
    notionTaskUrl: job.taskPageId ? `https://www.notion.so/${job.taskPageId.replace(/-/g, "")}` : null,
    prompt: await promptForJob(env, job),
  };
}

export async function claimTask(env: Env, owner: Owner, id: string) {
  const state = await ownTask(env, owner, id);
  if (state.status !== "assigned" && state.status !== "running") throw new HttpError(409, `Task is ${state.status}`);
  await markJob(env, state.job, { status: "running" });
  return { id: state.job.id, status: "running" };
}

const CompleteInput = z.object({
  output: z.string().trim().min(1, "output is required").max(100_000),
  summary: z.string().trim().max(500).optional(),
});

export async function completeTask(env: Env, owner: Owner, id: string, input: unknown) {
  const state = await ownTask(env, owner, id);
  if (state.status === "done") throw new HttpError(409, "Task is already done");
  const body = parse(CompleteInput, input, "result");
  try {
    const result = await completeExternally(env, state.job.id, { ...body, by: owner });
    return { id: state.job.id, status: "done", summary: result.summary, warnings: result.warnings };
  } catch (err) {
    // The result is saved; calling complete again resumes the remaining write-backs.
    throw new HttpError(err instanceof DispatchError && !err.retryable ? 422 : 502, errorMessage(err));
  }
}

export async function failTask(env: Env, owner: Owner, id: string, input: unknown) {
  const state = await ownTask(env, owner, id);
  if (state.status === "done") throw new HttpError(409, "Task is already done");
  const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(2000) }), input, "failure");
  await reportFailure(env, state.job, new Error(`${owner}: ${reason}`));
  return { id: state.job.id, status: "failed" };
}

const DelegateInput = z.object({
  task: z.string().trim().min(1).max(20_000),
  owner: z.string().optional(),
  kind: z.enum(TASK_KIND_KEYS as [TaskKind, ...TaskKind[]]).default("general"),
  business: z.string().optional(),
  notes: z.string().trim().max(20_000).optional(),
  parent_task_id: z.string().optional(),
});

export async function delegate(env: Env, from: Owner, input: unknown) {
  const body = parse(DelegateInput, input, "delegation");
  const owner = parseOwner(body.owner) ?? (body.owner ? null : TASK_KINDS[body.kind].owner);
  if (!owner) throw new HttpError(422, `owner must be one of ${OWNERS.join(", ")} (or give a kind that implies one)`);
  if (owner === from) throw new HttpError(422, "You can't delegate to yourself; just do the task");

  let depth = 1;
  let business = body.business;
  if (body.parent_task_id) {
    const parent = await loadJobState(env, body.parent_task_id);
    if (parent.job) {
      depth = (parent.job.delegation?.depth ?? 0) + 1;
      business ??= parent.job.business;
    }
  }
  if (depth > MAX_DELEGATION_DEPTH) {
    throw new HttpError(422, `Delegation chain is too deep (max ${MAX_DELEGATION_DEPTH}). Finish the task or fail it with a reason.`);
  }
  const target = await businessFromRef(env, business);
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
  const outcome = await startDispatch(env, job, { async: true });
  await sendMessage(env, {
    from,
    to: owner,
    text: `I've put a ${TASK_KINDS[body.kind].label.toLowerCase()} task in your inbox: "${body.task.slice(0, 200)}"`,
    business: target.id,
    taskId: job.id,
  });
  return { id: job.id, owner, business: target.id, status: outcome.mode };
}

const MessageInput = z.object({
  to: z.string(),
  text: z.string().trim().min(1).max(4000),
  business: z.string().optional(),
  task_id: z.string().optional(),
});

export async function message(env: Env, from: Owner, input: unknown) {
  const body = parse(MessageInput, input, "message");
  const to = parseRecipient(body.to);
  if (!to) throw new HttpError(422, `"to" must be one of ${OWNERS.join(", ")}, Human or team`);
  if (to === from) throw new HttpError(422, "You can't message yourself");
  const business = body.business ? (await businessFromRef(env, body.business)).id : undefined;
  const sent = await sendMessage(env, { from, to, text: body.text, business, taskId: body.task_id });
  return { id: sent.id, to, sentAt: sent.createdAt };
}

export async function readMessages(env: Env, owner: Owner, input?: { history?: boolean }) {
  const unread = await readInbox(env, owner);
  return {
    unread,
    ...(input?.history ? { recentTeamFeed: (await teamFeed(env, 30)).filter((m) => !unread.some((u) => u.id === m.id)) } : {}),
  };
}

export async function logNote(env: Env, owner: Owner, input: unknown) {
  const body = parse(z.object({ business: z.string().optional(), message: z.string().trim().min(1).max(2000) }), input, "note");
  const business = await businessFromRef(env, body.business);
  if (!business.hqPageId) throw new HttpError(409, `${business.name} has no Notion HQ page yet`);
  await appendLogEntry(createNotion(env, business), business.hqPageId, {
    timestamp: formatLogTimestamp(new Date(), Number(env.LOG_TIMEZONE_OFFSET_MINUTES) || 0),
    agent: owner,
    task: "Note",
    outcome: "event",
    summary: body.message,
  });
  return { ok: true, business: business.id };
}
