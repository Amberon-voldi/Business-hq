import { Client } from "@notionhq/client";
import type { Env } from "../env";

export function createNotion(env: Env): Client {
  return new Client({
    auth: env.NOTION_TOKEN,
    // Bind so the SDK doesn't call fetch with the wrong `this` inside workerd.
    fetch: (input, init) => fetch(input, init),
    timeoutMs: 20_000,
  });
}

/** Accepts a bare id, a dashed UUID, or a full notion.so URL. */
export function normalizeNotionId(raw: string): string {
  const match = raw.replace(/-/g, "").match(/[0-9a-f]{32}(?!.*[0-9a-f]{32})/i);
  if (!match) throw new Error(`Not a valid Notion id: ${raw}`);
  const h = match[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
