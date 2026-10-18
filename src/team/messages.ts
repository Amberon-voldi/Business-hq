import { OWNERS, type Owner } from "../agents/registry";
import type { Env } from "../env";
import { pushToAgent } from "../hub/notify";

export type Participant = Owner | "Human";
export type Recipient = Participant | "team";

export interface TeamMessage {
  id: string;
  from: Participant;
  to: Recipient;
  text: string;
  business?: string;
  taskId?: string;
  createdAt: string;
}

/**
 * Team chat between interns (and the human). Each participant has an unread box;
 * a shared feed keeps recent history for the panel and for catching up.
 * Volumes are small, so read-modify-write JSON documents in KV are enough.
 */
const BOX_LIMIT = 100;
const FEED_LIMIT = 300;
const TTL_SECONDS = 60 * 60 * 24 * 30;

const boxKey = (p: Participant) => `team:box:${p}`;
const FEED_KEY = "team:feed";

async function readList(env: Env, key: string): Promise<TeamMessage[]> {
  return (await env.HQ_CACHE.get<TeamMessage[]>(key, "json")) ?? [];
}

async function writeList(env: Env, key: string, list: TeamMessage[], limit: number): Promise<void> {
  await env.HQ_CACHE.put(key, JSON.stringify(list.slice(-limit)), { expirationTtl: TTL_SECONDS });
}

export function parseRecipient(value: string | null | undefined): Recipient | null {
  if (!value) return null;
  const norm = value.trim().toLowerCase();
  if (norm === "team" || norm === "all" || norm === "everyone") return "team";
  if (norm === "human" || norm === "founder" || norm === "admin") return "Human";
  return OWNERS.find((o) => o.toLowerCase() === norm) ?? null;
}

export async function sendMessage(
  env: Env,
  input: { from: Participant; to: Recipient; text: string; business?: string | undefined; taskId?: string | undefined },
): Promise<TeamMessage> {
  const message: TeamMessage = {
    id: crypto.randomUUID(),
    from: input.from,
    to: input.to,
    text: input.text.trim().slice(0, 4000),
    ...(input.business ? { business: input.business } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    createdAt: new Date().toISOString(),
  };
  const recipients: Participant[] =
    input.to === "team" ? [...OWNERS, "Human" as const].filter((p) => p !== input.from) : [input.to];
  await Promise.all([
    ...recipients.map(async (r) => {
      // Delivered live over LISTEN counts as read; otherwise it waits in the unread box.
      if (r !== "Human" && (await pushToAgent(env, r, { type: "message", message })) > 0) return;
      await writeList(env, boxKey(r), [...(await readList(env, boxKey(r))), message], BOX_LIMIT);
    }),
    (async () => writeList(env, FEED_KEY, [...(await readList(env, FEED_KEY)), message], FEED_LIMIT))(),
  ]);
  return message;
}

/** Returns unread messages (oldest first) and marks them read. */
export async function readInbox(env: Env, who: Participant): Promise<TeamMessage[]> {
  const list = await readList(env, boxKey(who));
  if (list.length) await env.HQ_CACHE.delete(boxKey(who));
  return list;
}

export async function unreadCount(env: Env, who: Participant): Promise<number> {
  return (await readList(env, boxKey(who))).length;
}

/** Recent team history, newest last. */
export async function teamFeed(env: Env, limit = 50): Promise<TeamMessage[]> {
  return (await readList(env, FEED_KEY)).slice(-limit);
}
