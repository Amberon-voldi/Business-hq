import { Hono } from "hono";
import { OWNERS, type Owner, TASK_KIND_KEYS } from "../agents/registry";
import * as agent from "../agents/service";
import type { AppBindings, Env } from "../env";
import { ownerFromAgentToken } from "../lib/agentTokens";
import { HttpError, errorMessage } from "../lib/errors";
import { log } from "../lib/logger";

/**
 * Minimal stateless MCP server (Streamable HTTP, JSON responses) so an intern running in
 * a Claude app, Claude Code or any MCP client can use business-hq as a connector. The
 * URL itself carries the intern's token: https://<worker>/mcp/<token>.
 */
export const mcpRoutes = new Hono<AppBindings>();

const SERVER_VERSION = "1.0.0";
const FALLBACK_PROTOCOL = "2025-06-18";

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (env: Env, owner: Owner, args: Json) => Promise<unknown>;
}

const str = (description: string) => ({ type: "string", description });
const obj = (properties: Json, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const taskId = { task_id: str("Task id from list_tasks / check_in") };

const TOOLS: Tool[] = [
  {
    name: "check_in",
    description:
      "Start here every session and whenever told to 'check in'. Returns who you are, your unread team messages (marked read) and the open tasks in your inbox.",
    inputSchema: obj({}),
    run: async (env, owner) => {
      const [me, messages, tasks] = await Promise.all([
        agent.whoAmI(env, owner),
        agent.readMessages(env, owner),
        agent.listTasks(env, owner),
      ]);
      return { you: { owner: me.owner, role: me.role }, businesses: me.businesses, teammates: me.teammates, unreadMessages: messages.unread, tasks };
    },
  },
  {
    name: "get_briefing",
    description: "Shared context (product brief, brand rules, roadmap…) from each business's Notion HQ doc. Read before working on a business you haven't seen this session.",
    inputSchema: obj({ business: str("Optional business id or alias, e.g. noidafit, spi. Omit for all businesses.") }),
    run: (env, owner, a) => agent.briefing(env, owner, typeof a.business === "string" ? a.business : undefined),
  },
  {
    name: "list_tasks",
    description: "Your inbox: tasks assigned to you, oldest first.",
    inputSchema: obj({}),
    run: (env, owner) => agent.listTasks(env, owner),
  },
  {
    name: "get_task",
    description: "One task in full, including a ready-made prompt (system + user) built from the right business's context. Follow that prompt to do the work.",
    inputSchema: obj(taskId, ["task_id"]),
    run: (env, owner, a) => agent.getTask(env, owner, String(a.task_id ?? "")),
  },
  {
    name: "claim_task",
    description: "Mark a task as in progress before you start working on it.",
    inputSchema: obj(taskId, ["task_id"]),
    run: (env, owner, a) => agent.claimTask(env, owner, String(a.task_id ?? "")),
  },
  {
    name: "complete_task",
    description: "Submit the finished deliverable. It is brand-checked and written to Notion (task page, status Done, HQ Log), and whoever asked is notified.",
    inputSchema: obj(
      { ...taskId, summary: str("One sentence describing what you delivered"), output: str("The full deliverable in Markdown") },
      ["task_id", "output"],
    ),
    run: (env, owner, a) => agent.completeTask(env, owner, String(a.task_id ?? ""), { output: a.output, summary: a.summary }),
  },
  {
    name: "fail_task",
    description: "Only when truly blocked: marks the task Blocked in Notion and tells the human what you need.",
    inputSchema: obj({ ...taskId, reason: str("What blocked you and exactly what you need") }, ["task_id", "reason"]),
    run: (env, owner, a) => agent.failTask(env, owner, String(a.task_id ?? ""), { reason: a.reason }),
  },
  {
    name: "delegate_task",
    description:
      "Hand work to a teammate (code → Code; research or business email → Pro; social → Grok; marketing copy → Muse). It lands in their inbox and they're messaged. You're told when it's done.",
    inputSchema: obj(
      {
        task: str("What the teammate should do, with enough detail to work independently"),
        owner: { type: "string", enum: [...OWNERS], description: "Teammate to delegate to (optional if kind implies one)" },
        kind: { type: "string", enum: TASK_KIND_KEYS, description: "Task type" },
        business: str("Business id or alias this task is for"),
        notes: str("Context, links, constraints"),
        parent_task_id: str("Your task this is part of, if any"),
      },
      ["task"],
    ),
    run: (env, owner, a) => agent.delegate(env, owner, a),
  },
  {
    name: "send_message",
    description: "Message a teammate, the human, or the whole team: questions, hand-offs, status updates.",
    inputSchema: obj(
      {
        to: { type: "string", enum: [...OWNERS, "Human", "team"], description: "Recipient" },
        text: str("The message"),
        business: str("Optional business id the message is about"),
        task_id: str("Optional related task id"),
      },
      ["to", "text"],
    ),
    run: (env, owner, a) => agent.message(env, owner, a),
  },
  {
    name: "read_messages",
    description: "Your unread team messages (marked read). Set history=true to also see recent team chat.",
    inputSchema: obj({ history: { type: "boolean", description: "Include recent team history" } }),
    run: (env, owner, a) => agent.readMessages(env, owner, { history: a.history === true }),
  },
  {
    name: "log_note",
    description: "Add a note to a business's HQ Log in Notion (decisions, findings worth keeping).",
    inputSchema: obj({ message: str("The note"), business: str("Business id or alias") }, ["message"]),
    run: (env, owner, a) => agent.logNote(env, owner, a),
  },
];

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
}

const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(env: Env, owner: Owner, req: RpcRequest): Promise<Json | null> {
  const isNotification = req.id === undefined;
  switch (req.method) {
    case "initialize": {
      const requested = typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : FALLBACK_PROTOCOL;
      return rpcResult(req.id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "business-hq", version: SERVER_VERSION },
        instructions: `You are ${owner}, one of the AI Interns. Call check_in first, then work your inbox: get_task → claim_task → complete_task. Use delegate_task and send_message to work with teammates.`,
      });
    }
    case "ping":
      return rpcResult(req.id, {});
    case "tools/list":
      return rpcResult(req.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(req.id, -32602, `Unknown tool: ${name}`);
      const args = (req.params?.arguments ?? {}) as Json;
      try {
        const out = await tool.run(env, owner, args);
        const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
        return rpcResult(req.id, { content: [{ type: "text", text }] });
      } catch (err) {
        // Tool errors go back to the model as readable results so it can correct itself.
        if (!(err instanceof HttpError)) log("error", "mcp_tool_failed", { owner, tool: name, error: errorMessage(err) });
        return rpcResult(req.id, { content: [{ type: "text", text: `Error: ${errorMessage(err)}` }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized etc.
      return rpcError(req.id, -32601, `Method not found: ${req.method ?? "(none)"}`);
  }
}

mcpRoutes.post("/:token", async (c) => {
  const owner = await ownerFromAgentToken(c.env.WEBHOOK_SECRET, c.req.param("token"));
  if (!owner) return c.json(rpcError(null, -32001, "Unknown connector URL. Copy it again from the panel: Agents tab."), 404);

  let payload: RpcRequest | RpcRequest[];
  try {
    payload = (await c.req.json()) as RpcRequest | RpcRequest[];
  } catch {
    return c.json(rpcError(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(payload)) {
    const results = (await Promise.all(payload.map((r) => handle(c.env, owner, r)))).filter(Boolean);
    return results.length ? c.json(results) : c.body(null, 202);
  }
  const result = await handle(c.env, owner, payload);
  return result ? c.json(result) : c.body(null, 202);
});

// Stateless server: no server-initiated stream and no sessions to end.
mcpRoutes.on(["GET", "DELETE"], "/:token", (c) => c.body(null, 405, { Allow: "POST" }));
