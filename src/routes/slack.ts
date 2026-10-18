import { Hono } from "hono";
import { AGENTS, OWNERS, type Owner, TASK_KINDS, type TaskKind, parseKind, parseOwner } from "../agents/registry";
import { type HqConfig, findBusiness, getConfig } from "../config/store";
import { startDispatch } from "../dispatch/start";
import type { DispatchJob, DispatchSource } from "../dispatch/types";
import type { AppBindings } from "../env";
import { verifySlackSignature } from "../lib/crypto";
import { HttpError, errorMessage } from "../lib/errors";
import { firstDelivery } from "../lib/idempotency";
import { log } from "../lib/logger";

export const slackWebhook = new Hono<AppBindings>();

function help(config: HqConfig): string {
  return [
    "*AI Interns* — `/intern [business] <intern or task type> <task>`",
    `Businesses: ${config.businesses.map((b) => `\`${[b.id, ...b.aliases].join("/")}\` (${b.name})`).join(", ")} — default \`${config.defaultBusiness}\``,
    ...OWNERS.map((o) => `• \`${o.toLowerCase()}\` — ${AGENTS[o].role}`),
    `Task types: ${Object.entries(TASK_KINDS)
      .filter(([, k]) => k.owner)
      .map(([key, k]) => `\`${key}\` → ${k.owner}`)
      .join(", ")}`,
    "Examples: `/intern muse 3 taglines for the .fit ID launch` · `/intern spi email follow up with the distributor`",
  ].join("\n");
}

export interface ParsedCommand {
  business: string | null;
  owner: Owner;
  kind: TaskKind;
  task: string;
}

/**
 * "[business] <intern|kind>[:] <task>" — e.g. "muse write a tweet", "spi email: chase invoice 42",
 * "noidafit research gyms with open-gym events". Returns null when no intern or kind is given.
 */
export function parseSlackCommand(text: string, config: HqConfig): ParsedCommand | null {
  const words = text.trim().split(/\s+/);
  let business: string | null = null;
  const first = (words[0] ?? "").replace(/[:,]$/, "");
  if (first && !parseOwner(first) && !parseKind(first)) {
    const b = findBusiness(config, first);
    if (b) {
      business = b.id;
      words.shift();
    }
  }
  const head = (words.shift() ?? "").replace(/[:,]$/, "");
  const task = words.join(" ").trim();
  if (!task) return null;
  const owner = parseOwner(head);
  if (owner) return { business, owner, kind: "general", task };
  const kind = parseKind(head);
  const kindOwner = kind ? TASK_KINDS[kind].owner : null;
  if (kind && kindOwner) return { business, owner: kindOwner, kind, task };
  return null;
}

slackWebhook.post("/", async (c) => {
  if (!c.env.SLACK_SIGNING_SECRET) throw new HttpError(503, "SLACK_SIGNING_SECRET is not configured");
  const raw = await c.req.text();
  const ok = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    raw,
    c.req.header("x-slack-request-timestamp"),
    c.req.header("x-slack-signature"),
  );
  if (!ok) throw new HttpError(401, "Invalid Slack signature");

  // We always ack within Slack's 3s window, so retries are duplicates.
  if (c.req.header("x-slack-retry-num")) return c.body(null, 200);

  const config = await getConfig(c.env);
  const contentType = c.req.header("content-type") ?? "";

  // Slash command (application/x-www-form-urlencoded)
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(raw);
    const parsed = parseSlackCommand(form.get("text") ?? "", config);
    if (!parsed) return c.json({ response_type: "ephemeral", text: help(config) });

    const source: DispatchSource = {
      kind: "slack",
      ...(form.get("response_url") ? { responseUrl: form.get("response_url") as string } : {}),
      ...(form.get("channel_id") ? { channel: form.get("channel_id") as string } : {}),
      ...(form.get("user_id") ? { userId: form.get("user_id") as string } : {}),
    };
    const job = newJob(parsed, source, form.get("user_name"));
    try {
      const outcome = await startDispatch(c.env, job, { async: true });
      const where = findBusiness(config, job.business)?.name ?? job.business;
      const how =
        outcome.mode === "assigned"
          ? `It's in ${parsed.owner}'s inbox; the result is posted here when they finish.`
          : "I'll post the result here when it's ready.";
      return c.json({
        response_type: "ephemeral",
        text: `:brain: *${parsed.owner}* · ${where} · ${TASK_KINDS[parsed.kind].label}. ${how} (job \`${job.id.slice(0, 8)}\`)`,
      });
    } catch (err) {
      return c.json({ response_type: "ephemeral", text: `:x: ${errorMessage(err)}` });
    }
  }

  // Events API (JSON)
  let body: {
    type?: string;
    challenge?: string;
    event_id?: string;
    event?: { type?: string; text?: string; channel?: string; ts?: string; thread_ts?: string; user?: string; bot_id?: string; subtype?: string };
  };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    throw new HttpError(400, "Body must be JSON or form-encoded");
  }

  if (body.type === "url_verification") return c.json({ challenge: body.challenge });

  const event = body.event;
  if (body.type !== "event_callback" || event?.type !== "app_mention" || event.bot_id || event.subtype) {
    return c.body(null, 200);
  }
  if (body.event_id && !(await firstDelivery(c.env, `slack:${body.event_id}`))) return c.body(null, 200);

  const parsed = parseSlackCommand((event.text ?? "").replace(/<@[A-Z0-9]+>/g, ""), config);
  if (!parsed) return c.body(null, 200);

  const threadTs = event.thread_ts ?? event.ts;
  const job = newJob(parsed, {
    kind: "slack",
    ...(event.channel ? { channel: event.channel } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(event.user ? { userId: event.user } : {}),
  });
  // Ack first; start the dispatch in the background so Slack never waits on Notion.
  c.executionCtx.waitUntil(
    startDispatch(c.env, job, { async: true }).catch((err: unknown) =>
      log("error", "slack_mention_dispatch_failed", { error: errorMessage(err) }),
    ),
  );
  return c.body(null, 200);
});

function newJob(parsed: ParsedCommand, source: DispatchSource, requester?: string | null): DispatchJob {
  return {
    id: crypto.randomUUID(),
    ...(parsed.business ? { business: parsed.business } : {}),
    task: parsed.task,
    owner: parsed.owner,
    kind: parsed.kind,
    ...(requester ? { details: { "Requested by": `@${requester} via Slack` } } : {}),
    source,
    requestedAt: new Date().toISOString(),
  };
}
