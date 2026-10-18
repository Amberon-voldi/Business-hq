import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { handleQueueBatch } from "./dispatch/queue";
import type { DispatchJob } from "./dispatch/types";
import { type AppBindings, type Env, missingRequiredSecrets } from "./env";
import { HttpError } from "./lib/errors";
import { log } from "./lib/logger";
import { adminRoutes } from "./routes/admin";
import { agentRoutes } from "./routes/agent";
import { contextRoutes } from "./routes/context";
import { dispatchRoutes } from "./routes/dispatch";
import { githubWebhook } from "./routes/github";
import { jobRoutes } from "./routes/jobs";
import { notionWebhook } from "./routes/notion";
import { panelRoutes } from "./routes/panel";
import { slackWebhook } from "./routes/slack";

const VERSION = "1.0.0";

const app = new Hono<AppBindings>();

app.use("*", async (c, next) => {
  const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
  c.set("requestId", requestId);
  const started = Date.now();
  await next();
  c.header("X-Request-Id", requestId);
  log("info", "request", {
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    ms: Date.now() - started,
  });
});

// Webhook payloads are small; refuse anything absurd before reading it into memory.
app.use(
  "*",
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: () => {
      throw new HttpError(413, "Payload too large");
    },
  }),
);

// Fail closed if the worker is deployed without its required secrets.
// The panel page and /health stay reachable so a misconfiguration is visible.
const ALWAYS_REACHABLE = new Set(["/", "/health", "/panel"]);
app.use("*", async (c, next) => {
  if (!ALWAYS_REACHABLE.has(c.req.path)) {
    const missing = missingRequiredSecrets(c.env);
    if (missing.length) throw new HttpError(503, "Worker is not configured", { missing });
  }
  await next();
});

app.get("/health", (c) => {
  const missing = missingRequiredSecrets(c.env);
  return c.json(
    {
      ok: missing.length === 0,
      service: "ai-interns-hq",
      version: VERSION,
      time: new Date().toISOString(),
      config: {
        missingSecrets: missing,
        grok: Boolean(c.env.XAI_API_KEY),
        slack: Boolean(c.env.SLACK_SIGNING_SECRET),
        notionSignedWebhooks: Boolean(c.env.NOTION_WEBHOOK_VERIFICATION_TOKEN),
      },
    },
    missing.length === 0 ? 200 : 503,
  );
});

app.route("/webhook/notion", notionWebhook);
app.route("/webhook/github", githubWebhook);
app.route("/webhook/slack", slackWebhook);
app.route("/dispatch", dispatchRoutes);
app.route("/context", contextRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api", adminRoutes);
app.route("/agent/v1", agentRoutes);
app.route("/", panelRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  const requestId = c.get("requestId");
  if (err instanceof HttpError) {
    if (err.status >= 500) log("error", "http_error", { requestId, status: err.status, error: err.message });
    return c.json({ error: err.message, ...(err.details ? { details: err.details } : {}), requestId }, err.status);
  }
  log("error", "unhandled_error", {
    requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json({ error: "Internal error", requestId }, 500);
});

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<DispatchJob>, env: Env) => handleQueueBatch(batch, env),
} satisfies ExportedHandler<Env, DispatchJob>;

export { app };
