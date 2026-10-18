import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Owner } from "../agents/registry";
import * as agent from "../agents/service";
import type { AppBindings } from "../env";
import { ownerFromAgentToken } from "../lib/agentTokens";
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
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
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
