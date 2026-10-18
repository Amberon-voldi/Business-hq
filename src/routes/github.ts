import { Hono } from "hono";
import { type Owner, parseOwner } from "../agents/registry";
import { enqueueDispatch } from "../dispatch/queue";
import type { DispatchJob } from "../dispatch/types";
import type { AppBindings, Env } from "../env";
import { verifyGitHubSignature } from "../lib/crypto";
import { HttpError, errorMessage } from "../lib/errors";
import { firstDelivery } from "../lib/idempotency";
import { log } from "../lib/logger";
import { formatLogTimestamp } from "../lib/time";
import { createNotion } from "../notion/client";
import { appendLogEntry } from "../notion/writeback";

export const githubWebhook = new Hono<AppBindings>();

/** Issue/PR labels like `ai:code`, `ai:muse` route work to an intern. */
const AI_LABEL = /^ai[:/-](\w+)$/i;

interface Label {
  name: string;
}
interface GitHubPayload {
  action?: string;
  label?: Label;
  repository?: { full_name: string; default_branch?: string; html_url?: string };
  issue?: { number: number; title: string; body?: string | null; html_url: string; labels?: Label[]; pull_request?: unknown };
  pull_request?: { number: number; title: string; body?: string | null; html_url: string; labels?: Label[] };
  ref?: string;
  commits?: { message: string }[];
  compare?: string;
  pusher?: { name?: string };
  sender?: { login?: string };
}

function ownerFromLabels(labels: Label[] | undefined): Owner | null {
  for (const l of labels ?? []) {
    const m = l.name.match(AI_LABEL);
    const owner = m ? parseOwner(m[1]) : null;
    if (owner) return owner;
  }
  return null;
}

githubWebhook.post("/", async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET || c.env.WEBHOOK_SECRET;
  const raw = await c.req.text();
  if (!(await verifyGitHubSignature(secret, raw, c.req.header("x-hub-signature-256")))) {
    throw new HttpError(401, "Invalid GitHub signature");
  }

  const event = c.req.header("x-github-event") ?? "unknown";
  const delivery = c.req.header("x-github-delivery");
  if (event === "ping") return c.json({ status: "pong" });
  if (delivery && !(await firstDelivery(c.env, `github:${delivery}`))) {
    return c.json({ status: "ignored", reason: "duplicate delivery" });
  }

  let payload: GitHubPayload;
  try {
    payload = JSON.parse(raw) as GitHubPayload;
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  const repo = payload.repository?.full_name ?? "unknown/repo";

  // Pushes to the default branch are recorded in the HQ Log (no AI involved).
  if (event === "push") {
    const branch = payload.ref?.replace("refs/heads/", "");
    if (!branch || branch !== payload.repository?.default_branch) {
      return c.json({ status: "ignored", reason: "not the default branch" });
    }
    const commits = payload.commits ?? [];
    const head = commits.at(-1)?.message.split("\n")[0] ?? "";
    c.executionCtx.waitUntil(
      logEvent(c.env, `${repo}@${branch}`, `${commits.length} commit(s) by ${payload.pusher?.name ?? "someone"}: ${head}`, payload.compare),
    );
    return c.json({ status: "logged" });
  }

  // Issues and PRs labelled ai:<intern> are dispatched.
  if (event === "issues" || event === "pull_request") {
    const item = event === "issues" ? payload.issue : payload.pull_request;
    if (!item || !["opened", "labeled", "reopened"].includes(payload.action ?? "")) {
      return c.json({ status: "ignored", reason: `action ${payload.action ?? "none"}` });
    }
    // On "labeled", only react to the label that was just added.
    const owner = payload.action === "labeled" ? ownerFromLabels(payload.label ? [payload.label] : []) : ownerFromLabels(item.labels);
    if (!owner) return c.json({ status: "ignored", reason: "no ai:<intern> label" });

    const kind = event === "issues" ? "issue" : "pull request";
    const job: DispatchJob = {
      id: crypto.randomUUID(),
      task: `GitHub ${kind} #${item.number} in ${repo}: ${item.title}`,
      owner,
      details: {
        [`GitHub ${kind}`]: `${item.html_url}\n\n${(item.body ?? "").slice(0, 15_000) || "(no description)"}`,
      },
      source: { kind: "github", repo, url: item.html_url, event },
      requestedAt: new Date().toISOString(),
    };
    await enqueueDispatch(c.env, job);
    return c.json({ status: "queued", id: job.id, owner }, 202);
  }

  return c.json({ status: "ignored", reason: `event ${event} not handled` });
});

async function logEvent(env: Env, where: string, summary: string, url?: string): Promise<void> {
  try {
    await appendLogEntry(createNotion(env), env.NOTION_HQ_PAGE_ID, {
      timestamp: formatLogTimestamp(new Date(), Number(env.LOG_TIMEZONE_OFFSET_MINUTES) || 0),
      agent: "GitHub",
      task: where,
      outcome: "event",
      summary,
      taskUrl: url ?? null,
    });
  } catch (err) {
    log("error", "github_event_log_failed", { error: errorMessage(err) });
  }
}
