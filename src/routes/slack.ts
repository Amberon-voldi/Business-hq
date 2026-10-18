import { Hono } from "hono";
import { AGENTS, OWNERS, type Owner, parseOwner } from "../agents/registry";
import { enqueueDispatch } from "../dispatch/queue";
import type { DispatchJob, DispatchSource } from "../dispatch/types";
import type { AppBindings } from "../env";
import { verifySlackSignature } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import { firstDelivery } from "../lib/idempotency";

export const slackWebhook = new Hono<AppBindings>();

const HELP = [
  "*AI Interns* — usage: `/intern <intern> <task>`",
  ...OWNERS.map((o) => `• \`${o.toLowerCase()}\` — ${AGENTS[o].role}`),
  "Example: `/intern muse write 3 taglines for the .fit ID launch`",
].join("\n");

/** "muse: write a tweet" / "Muse write a tweet" -> { owner: "Muse", task: "write a tweet" } */
export function parseSlackCommand(text: string): { owner: Owner; task: string } | null {
  const m = text.trim().match(/^(\w+)[:,]?\s+([\s\S]+)$/);
  if (!m) return null;
  const owner = parseOwner(m[1]);
  const task = (m[2] ?? "").trim();
  return owner && task ? { owner, task } : null;
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

  const contentType = c.req.header("content-type") ?? "";

  // Slash command (application/x-www-form-urlencoded)
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(raw);
    const parsed = parseSlackCommand(form.get("text") ?? "");
    if (!parsed) return c.json({ response_type: "ephemeral", text: HELP });

    const source: DispatchSource = {
      kind: "slack",
      ...(form.get("response_url") ? { responseUrl: form.get("response_url") as string } : {}),
      ...(form.get("channel_id") ? { channel: form.get("channel_id") as string } : {}),
      ...(form.get("user_id") ? { userId: form.get("user_id") as string } : {}),
    };
    const job = newJob(parsed.owner, parsed.task, source, form.get("user_name"));
    await enqueueDispatch(c.env, job);
    return c.json({
      response_type: "ephemeral",
      text: `:brain: Dispatched to *${parsed.owner}*. I'll post the result here when it's ready. (job \`${job.id.slice(0, 8)}\`)`,
    });
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

  const text = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  const parsed = parseSlackCommand(text);
  if (!parsed) return c.body(null, 200);

  const threadTs = event.thread_ts ?? event.ts;
  const job = newJob(parsed.owner, parsed.task, {
    kind: "slack",
    ...(event.channel ? { channel: event.channel } : {}),
    ...(threadTs ? { threadTs } : {}),
    ...(event.user ? { userId: event.user } : {}),
  });
  await enqueueDispatch(c.env, job);
  return c.body(null, 200);
});

function newJob(owner: Owner, task: string, source: DispatchSource, requester?: string | null): DispatchJob {
  return {
    id: crypto.randomUUID(),
    task,
    owner,
    ...(requester ? { details: { "Requested by": `@${requester} via Slack` } } : {}),
    source,
    requestedAt: new Date().toISOString(),
  };
}
