import { DurableObject } from "cloudflare:workers";
import { parseOwner } from "../agents/registry";
import { listTasks } from "../agents/service";
import type { Env } from "../env";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { readInbox } from "../team/messages";
import type { HubEvent } from "./events";

/**
 * One instance per intern (idFromName(owner)). Holds that intern's open WebSockets on
 * the LISTEN endpoint and pushes events to them. Uses the hibernation API, so idle
 * connections cost nothing; "ping" is answered with "pong" without waking the object.
 */
export class AgentHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const owner = parseOwner(request.headers.get("x-agent"));
    if (!owner || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    this.ctx.waitUntil(this.sendBacklog(server, owner));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** On connect: a hello, then everything already waiting, so nothing is missed between connections. */
  private async sendBacklog(ws: WebSocket, owner: ReturnType<typeof parseOwner> & string): Promise<void> {
    try {
      const [tasks, messages] = await Promise.all([listTasks(this.env, owner), readInbox(this.env, owner)]);
      const send = (e: HubEvent) => ws.send(JSON.stringify(e));
      send({ type: "hello", owner, openTasks: tasks.length, unreadMessages: messages.length, at: new Date().toISOString() });
      for (const task of tasks) send({ type: "task", backlog: true, task });
      for (const message of messages) send({ type: "message", backlog: true, message });
    } catch (err) {
      log("error", "hub_backlog_failed", { owner, error: errorMessage(err) });
    }
  }

  /** RPC: push an event to every open connection. Returns how many sockets got it. */
  async deliver(event: string): Promise<number> {
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(event);
        delivered++;
      } catch {
        // Socket already closing; the client reconnects and gets the backlog.
      }
    }
    return delivered;
  }

  async connections(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // LISTEN is one-way; actions go to POST /agent/v1/send. Answer JSON pings for clients that can't send "ping".
    if (typeof message === "string" && message.includes('"ping"')) ws.send(JSON.stringify({ type: "pong" }));
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}
