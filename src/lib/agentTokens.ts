import { OWNERS, type Owner } from "../agents/registry";
import { hmacSha256Hex, timingSafeEqual } from "./crypto";

/**
 * Per-intern API tokens, derived from WEBHOOK_SECRET so there's nothing extra to store.
 * A token only unlocks /agent/v1 for that intern. Rotating WEBHOOK_SECRET rotates all of them.
 */
export async function agentToken(secret: string, owner: Owner): Promise<string> {
  const mac = await hmacSha256Hex(secret, `ai-interns-agent-token:v1:${owner}`);
  return `aih_${owner.toLowerCase()}_${mac.slice(0, 40)}`;
}

export async function ownerFromAgentToken(secret: string, token: string): Promise<Owner | null> {
  const m = token.match(/^aih_([a-z]+)_[0-9a-f]{40}$/);
  if (!m) return null;
  const owner = OWNERS.find((o) => o.toLowerCase() === m[1]);
  if (!owner) return null;
  return timingSafeEqual(await agentToken(secret, owner), token) ? owner : null;
}
