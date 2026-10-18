import { Client } from "@notionhq/client";
import type { Business } from "../config/store";
import { notionTokenFor } from "../config/store";
import type { Env } from "../env";

export function createNotion(env: Env, business: Business | null = null): Client {
  return new Client({
    auth: notionTokenFor(env, business),
    // Bind so the SDK doesn't call fetch with the wrong `this` inside workerd.
    fetch: (input, init) => fetch(input, init),
    timeoutMs: 20_000,
  });
}

export { normalizeNotionId } from "../lib/notionId";
