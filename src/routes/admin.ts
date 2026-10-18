import { Hono } from "hono";
import { connectedPrompt, offlinePrompt } from "../agents/onboarding";
import { SECTION_TITLES } from "../agents/prompt";
import { AGENTS, OWNERS, TASK_KINDS, TASK_KIND_KEYS, parseOwner } from "../agents/registry";
import { ConfigError, deliveryFor, findBusiness, getConfig, saveConfig } from "../config/store";
import { listJobs, loadJobState } from "../dispatch/jobs";
import type { AppBindings, Env } from "../env";
import { agentToken } from "../lib/agentTokens";
import { HttpError, errorMessage } from "../lib/errors";
import { getHqContext } from "../notion/hq";
import { CONTEXT_SECTION_KEYS } from "../notion/types";
import { requireSharedSecret } from "./auth";
import { loadContexts, promptForJob } from "./util";

/** Admin JSON API behind the panel. Everything here requires WEBHOOK_SECRET. */
export const adminRoutes = new Hono<AppBindings>();
adminRoutes.use("*", requireSharedSecret);

const origin = (url: string) => new URL(url).origin;

/** Static facts + config the panel renders from. */
adminRoutes.get("/meta", async (c) => {
  const config = await getConfig(c.env);
  return c.json({
    owners: OWNERS.map((o) => ({ ...AGENTS[o], delivery: deliveryFor(config, o) })),
    sections: CONTEXT_SECTION_KEYS.map((key) => ({ key, title: SECTION_TITLES[key] })),
    kinds: TASK_KIND_KEYS.map((key) => ({ key, label: TASK_KINDS[key].label, owner: TASK_KINDS[key].owner })),
    businesses: config.businesses,
    defaultBusiness: config.defaultBusiness,
    config: {
      claudeModel: c.env.CLAUDE_MODEL,
      claudeEffort: c.env.CLAUDE_EFFORT,
      grokModel: c.env.GROK_MODEL,
      cacheTtlSeconds: Number(c.env.CONTEXT_CACHE_TTL_SECONDS) || 300,
    },
  });
});

adminRoutes.get("/config", async (c) => c.json(await getConfig(c.env)));

adminRoutes.put("/config", async (c) => {
  const body = await c.req.json().catch(() => {
    throw new HttpError(400, "Body must be JSON");
  });
  try {
    return c.json(await saveConfig(c.env, body));
  } catch (err) {
    if (err instanceof ConfigError) throw new HttpError(422, err.message);
    throw err;
  }
});

/** Connection test for a business's HQ doc: forces a fresh read from Notion. */
adminRoutes.post("/businesses/:id/test", async (c) => {
  const business = findBusiness(await getConfig(c.env), c.req.param("id"));
  if (!business) throw new HttpError(404, "Unknown business");
  try {
    const { context } = await getHqContext(c.env, business, { forceRefresh: true });
    return c.json({
      ok: true,
      title: context.title,
      sections: Object.keys(context.sections),
      tasks: context.tasks.length,
      taskBoardIsDatabase: Boolean(context.taskDataSourceId),
      warnings: context.warnings,
    });
  } catch (err) {
    return c.json({ ok: false, error: errorMessage(err) });
  }
});

/** Per-intern delivery, inbox counts and API token (for the onboarding prompts). */
adminRoutes.get("/agents", async (c) => {
  const config = await getConfig(c.env);
  const open = await listJobs(c.env, 500, { statuses: ["assigned", "running"] });
  return c.json({
    agents: await Promise.all(
      OWNERS.map(async (o) => ({
        owner: o,
        role: AGENTS[o].role,
        provider: AGENTS[o].provider,
        delivery: deliveryFor(config, o),
        token: await agentToken(c.env.WEBHOOK_SECRET, o),
        inbox: open.filter((j) => j.owner === o && j.delivery === "inbox").length,
      })),
    ),
  });
});

/** GET /api/onboarding/:owner?variant=connected|offline — the setup prompt to paste into the agent. */
adminRoutes.get("/onboarding/:owner", async (c) => {
  const owner = parseOwner(c.req.param("owner"));
  if (!owner) throw new HttpError(404, "Unknown intern");
  const config = await getConfig(c.env);
  const variant = c.req.query("variant") === "offline" ? "offline" : "connected";

  let prompt: string;
  if (variant === "connected") {
    prompt = connectedPrompt({ owner, config, origin: origin(c.req.url), token: await agentToken(c.env.WEBHOOK_SECRET, owner) });
  } else {
    const contexts = await loadContexts(c.env, config);
    const items = (await listJobs(c.env, 30, { owner, statuses: ["assigned", "running"] }))
      .filter((j) => j.delivery === "inbox")
      .reverse();
    const tasks = await Promise.all(
      items.map(async (item) => {
        const state = await loadJobState(c.env, item.id);
        const detail = state.job ? (await promptForJob(c.env, state.job).catch(() => null))?.user ?? state.job.task : item.task;
        return { item, detail };
      }),
    );
    prompt = offlinePrompt({ owner, config, contexts, tasks });
  }
  return c.text(prompt, 200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
});

interface SecretInfo {
  name: string;
  required: boolean;
  set: boolean;
  purpose: string;
  where: string;
}

function secretsStatus(env: Env, notionTokenEnvs: string[]): SecretInfo[] {
  const has = (k: string) => Boolean((env as unknown as Record<string, unknown>)[k]);
  const list: Omit<SecretInfo, "set">[] = [
    { name: "WEBHOOK_SECRET", required: true, purpose: "Signs in to this panel, authenticates /dispatch, /context and Notion automations, and derives agent tokens.", where: "Make one: openssl rand -hex 32" },
    { name: "NOTION_TOKEN", required: true, purpose: "Reads HQ docs and writes status, deliverables and logs.", where: "notion.so/profile/integrations → New internal integration (Read, Update, Insert content)" },
    { name: "ANTHROPIC_API_KEY", required: true, purpose: "Runs Code, Pro and Muse via Claude when their delivery is \"api\".", where: "platform.claude.com → API keys" },
    { name: "NOTION_HQ_PAGE_ID", required: false, purpose: "noida.fit's HQ page (you can also set it in Directory instead).", where: "The 32-character id at the end of the HQ page URL" },
    { name: "XAI_API_KEY", required: false, purpose: "Runs Grok via the xAI API when Grok's delivery is \"api\".", where: "console.x.ai → API keys" },
    { name: "SLACK_SIGNING_SECRET", required: false, purpose: "Verifies /intern slash commands and @mentions.", where: "api.slack.com/apps → your app → Basic Information" },
    { name: "SLACK_BOT_TOKEN", required: false, purpose: "Lets the bot reply in threads and post results after the 30-min response window.", where: "api.slack.com/apps → OAuth & Permissions (chat:write) → Bot User OAuth Token" },
    { name: "GITHUB_WEBHOOK_SECRET", required: false, purpose: "Verifies GitHub webhooks (falls back to WEBHOOK_SECRET).", where: "Any random string; paste the same value into the GitHub webhook" },
    { name: "NOTION_WEBHOOK_VERIFICATION_TOKEN", required: false, purpose: "Verifies signed Notion integration webhooks (automations use WEBHOOK_SECRET instead).", where: "Sent by Notion when you create the subscription; shown in `wrangler tail`" },
    ...notionTokenEnvs.map((name) => ({ name, required: true, purpose: "Notion token for a business whose HQ lives in another workspace.", where: "An internal integration created in that workspace" })),
  ];
  return list.map((s) => ({ ...s, set: has(s.name) }));
}

/** Everything needed to wire the worker up: secrets, bindings, and copy-ready URLs. */
adminRoutes.get("/setup", async (c) => {
  const config = await getConfig(c.env);
  const base = origin(c.req.url);
  const multi = config.businesses.length > 1;
  const q = (id: string) => (multi ? `?business=${id}` : "");
  return c.json({
    workerUrl: base,
    secrets: secretsStatus(c.env, [...new Set(config.businesses.map((b) => b.notionTokenEnv).filter(Boolean))]),
    bindings: {
      HQ_CACHE: Boolean(c.env.HQ_CACHE),
      DISPATCH_QUEUE: Boolean(c.env.DISPATCH_QUEUE),
    },
    vars: {
      CLAUDE_MODEL: c.env.CLAUDE_MODEL,
      CLAUDE_EFFORT: c.env.CLAUDE_EFFORT,
      GROK_MODEL: c.env.GROK_MODEL,
      CONTEXT_CACHE_TTL_SECONDS: c.env.CONTEXT_CACHE_TTL_SECONDS,
      LOG_TIMEZONE_OFFSET_MINUTES: c.env.LOG_TIMEZONE_OFFSET_MINUTES,
    },
    businesses: config.businesses.map((b) => ({
      id: b.id,
      name: b.name,
      connected: Boolean(b.hqPageId),
      webhooks: {
        notion: `${base}/webhook/notion${q(b.id)}`,
        github: `${base}/webhook/github${q(b.id)}`,
      },
    })),
    slack: { url: `${base}/webhook/slack`, command: "/intern" },
    endpoints: [
      { method: "GET", path: "/health", auth: "none", purpose: "Health and config check" },
      { method: "GET", path: "/panel", auth: "sign-in", purpose: "This panel" },
      { method: "POST", path: "/dispatch", auth: "Bearer WEBHOOK_SECRET", purpose: "Delegate a task: {task, owner?, kind?, business?, context_sections?, notion_task_id?, delivery?, async?}" },
      { method: "GET", path: "/context?business=<id>", auth: "Bearer WEBHOOK_SECRET", purpose: "A business's HQ context (JSON, or ?format=markdown)" },
      { method: "POST", path: "/webhook/notion?business=<id>", auth: "X-Webhook-Secret or X-Notion-Signature", purpose: "Task → In progress triggers its intern" },
      { method: "POST", path: "/webhook/github?business=<id>", auth: "X-Hub-Signature-256", purpose: "ai:<intern> labels dispatch; pushes are logged" },
      { method: "POST", path: "/webhook/slack", auth: "X-Slack-Signature", purpose: "/intern [business] <intern|type> <task>, @mentions" },
      { method: "GET", path: "/agent/v1/…", auth: "Bearer agent token", purpose: "External agents: me, briefing, tasks, claim, complete, fail, delegate, log" },
      { method: "GET", path: "/api/…", auth: "Bearer WEBHOOK_SECRET", purpose: "Panel API: meta, config, jobs, agents, onboarding, setup" },
    ],
  });
});
