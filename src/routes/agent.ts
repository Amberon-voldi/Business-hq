import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Owner } from "../agents/registry";
import * as agent from "../agents/service";
import type { AppBindings } from "../env";
import { ownerFromAgentToken } from "../lib/agentTokens";
import { z } from "zod";
import { HttpError } from "../lib/errors";

/**
 * HTTP API for interns running in their own apps. Each intern authenticates with its own
 * derived token and can only see and act on its own tasks. The same operations are
 * exposed as MCP tools at /mcp/<token> (see routes/mcp.ts).
 */
export const agentRoutes = new Hono<AppBindings>();

agentRoutes.use(
  "*",
  createMiddleware<AppBindings>(async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    // WebSocket clients that can't set headers may pass ?key= on LISTEN only.
    const queryKey = c.req.path.endsWith("/listen") ? (c.req.query("key") ?? "") : "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : queryKey;
    const owner = token ? await ownerFromAgentToken(c.env.WEBHOOK_SECRET, token) : null;
    if (!owner) throw new HttpError(401, "Invalid agent token. Get yours from the panel: Agents tab.");
    c.set("agent", owner);
    await next();
  }),
);

const me = (c: Context<AppBindings>): Owner => c.get("agent") as Owner;
const body = (c: Context<AppBindings>): Promise<unknown> =>
  c.req.json().catch(() => {
    throw new HttpError(400, "Body must be JSON");
  });

agentRoutes.get("/me", async (c) => c.json(await agent.whoAmI(c.env, me(c))));

agentRoutes.get("/briefing", async (c) =>
  c.text(await agent.briefing(c.env, me(c), c.req.query("business")), 200, { "content-type": "text/markdown; charset=utf-8" }),
);

agentRoutes.get("/pending", async (c) => c.json(await agent.pending(c.env, me(c))));

agentRoutes.get("/tasks", async (c) => c.json({ owner: me(c), tasks: await agent.listTasks(c.env, me(c)) }));
agentRoutes.get("/tasks/:id", async (c) => c.json(await agent.getTask(c.env, me(c), c.req.param("id"))));
agentRoutes.post("/tasks/:id/claim", async (c) => c.json(await agent.claimTask(c.env, me(c), c.req.param("id"))));
agentRoutes.post("/tasks/:id/complete", async (c) =>
  c.json(await agent.completeTask(c.env, me(c), c.req.param("id"), await body(c))),
);
agentRoutes.post("/tasks/:id/fail", async (c) => c.json(await agent.failTask(c.env, me(c), c.req.param("id"), await body(c))));

agentRoutes.post("/delegate", async (c) => c.json(await agent.delegate(c.env, me(c), await body(c)), 202));

agentRoutes.get("/messages", async (c) =>
  c.json(await agent.readMessages(c.env, me(c), { history: c.req.query("history") === "1" })),
);
agentRoutes.post("/messages", async (c) => c.json(await agent.message(c.env, me(c), await body(c)), 201));

agentRoutes.post("/log", async (c) => c.json(await agent.logNote(c.env, me(c), await body(c))));

/**
 * LISTEN: WebSocket that pushes work as it happens. On connect you get a hello, then every
 * open task and unread message (backlog), then live {type:"task"} / {type:"message"} events.
 * Send "ping" every ~30 s to keep it alive (answered with "pong").
 */
agentRoutes.get("/listen", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "LISTEN is a WebSocket endpoint: connect with wss:// and an Upgrade: websocket request");
  }
  const owner = me(c);
  const headers = new Headers(c.req.raw.headers);
  headers.set("x-agent", owner);
  const stub = c.env.AGENT_HUB.get(c.env.AGENT_HUB.idFromName(owner));
  return stub.fetch(new Request(c.req.url, { method: "GET", headers }));
});

const SEND_ACTIONS = ["checkin", "briefing", "task", "claim", "complete", "fail", "delegate", "message", "log"] as const;
const Send = z.looseObject({ action: z.enum(SEND_ACTIONS), task_id: z.string().optional(), business: z.string().optional() });

/**
 * SEND: one endpoint for everything an intern does. Body: {"action": ..., ...fields}.
 *   checkin                         → unread messages (marked read) + open tasks
 *   briefing   {business?}          → shared context (Markdown)
 *   task       {task_id}            → task + ready-made prompt
 *   claim      {task_id}
 *   complete   {task_id, output, summary?}
 *   fail       {task_id, reason}
 *   delegate   {task, owner?, kind?, business?, notes?, parent_task_id?}
 *   message    {to, text, business?, task_id?}
 *   log        {message, business?}
 */
agentRoutes.post("/send", async (c) => {
  const parsed = Send.safeParse(await body(c));
  if (!parsed.success) {
    throw new HttpError(422, `Body must be {"action": one of ${SEND_ACTIONS.join(", ")}, ...fields}`);
  }
  const { action, ...rest } = parsed.data;
  const owner = me(c);
  const id = () => {
    if (!rest.task_id) throw new HttpError(422, `"${action}" needs task_id`);
    return rest.task_id;
  };
  switch (action) {
    case "checkin": {
      const [messages, tasks] = await Promise.all([agent.readMessages(c.env, owner), agent.listTasks(c.env, owner)]);
      return c.json({ action, unreadMessages: messages.unread, tasks });
    }
    case "briefing":
      return c.json({ action, briefing: await agent.briefing(c.env, owner, rest.business) });
    case "task":
      return c.json({ action, ...(await agent.getTask(c.env, owner, id())) });
    case "claim":
      return c.json({ action, ...(await agent.claimTask(c.env, owner, id())) });
    case "complete":
      return c.json({ action, ...(await agent.completeTask(c.env, owner, id(), rest)) });
    case "fail":
      return c.json({ action, ...(await agent.failTask(c.env, owner, id(), rest)) });
    case "delegate":
      return c.json({ action, ...(await agent.delegate(c.env, owner, rest)) }, 202);
    case "message":
      return c.json({ action, ...(await agent.message(c.env, owner, rest)) }, 201);
    case "log":
      return c.json({ action, ...(await agent.logNote(c.env, owner, rest)) });
  }
});
