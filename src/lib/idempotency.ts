import type { Env } from "../env";

/**
 * Returns true the first time `key` is seen within `ttlSeconds`. KV is eventually
 * consistent, so this filters provider retries/duplicates — it is not a lock.
 */
export async function firstDelivery(env: Env, key: string, ttlSeconds = 60 * 60 * 24): Promise<boolean> {
  const k = `idem:${key}`;
  if (await env.HQ_CACHE.get(k)) return false;
  await env.HQ_CACHE.put(k, "1", { expirationTtl: Math.max(ttlSeconds, 60) });
  return true;
}
