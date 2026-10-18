import type { Owner } from "../agents/registry";
import type { Env } from "../env";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import type { HubEvent } from "./events";

/** Pushes an event to an intern's live LISTEN connections. Returns the number of sockets reached (0 if offline). */
export async function pushToAgent(env: Env, owner: Owner, event: HubEvent): Promise<number> {
  if (!env.AGENT_HUB) return 0;
  try {
    return await env.AGENT_HUB.get(env.AGENT_HUB.idFromName(owner)).deliver(JSON.stringify(event));
  } catch (err) {
    log("warn", "hub_push_failed", { owner, type: event.type, error: errorMessage(err) });
    return 0;
  }
}

export async function agentConnections(env: Env, owner: Owner): Promise<number> {
  if (!env.AGENT_HUB) return 0;
  try {
    return await env.AGENT_HUB.get(env.AGENT_HUB.idFromName(owner)).connections();
  } catch {
    return 0;
  }
}
