import {
  APIErrorCode,
  type Client,
  collectAllDataSourceRows,
  collectPaginatedAPI,
  isFullBlock,
  isFullPage,
  isNotionClientError,
} from "@notionhq/client";
import type { Env } from "../env";
import { errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { createNotion, normalizeNotionId } from "./client";
import { type BlockNode, parseSections, tasksFromTable } from "./parse";
import { pageToTask } from "./properties";
import type { HqContext, HqTask } from "./types";

const CACHE_KEY_PREFIX = "hq:context:v1:";
/** Stale copies are kept this long so Notion outages degrade to slightly-old context. */
const STALE_RETENTION_SECONDS = 60 * 60 * 24;
const MAX_DEPTH = 4;
const CONCURRENCY = 3; // Notion's rate limit is ~3 req/s per integration.

export type CacheStatus = "hit" | "miss" | "stale" | "refresh";

export interface LoadedContext {
  context: HqContext;
  cache: CacheStatus;
}

function cacheKey(env: Env): string {
  return CACHE_KEY_PREFIX + normalizeNotionId(env.NOTION_HQ_PAGE_ID);
}

function ttlSeconds(env: Env): number {
  const n = Number(env.CONTEXT_CACHE_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

/**
 * Returns the parsed HQ doc, served from KV when younger than the TTL (default 5 min).
 * If Notion is unreachable, falls back to the last good copy (up to 24h old).
 */
export async function getHqContext(env: Env, opts: { forceRefresh?: boolean } = {}): Promise<LoadedContext> {
  const key = cacheKey(env);
  const cached = await env.HQ_CACHE.get<HqContext>(key, "json").catch((err: unknown) => {
    log("warn", "kv_read_failed", { error: errorMessage(err) });
    return null;
  });

  if (cached && !opts.forceRefresh) {
    const ageSeconds = (Date.now() - Date.parse(cached.fetchedAt)) / 1000;
    if (ageSeconds < ttlSeconds(env)) return { context: cached, cache: "hit" };
  }

  try {
    const context = await fetchHqContext(env);
    await env.HQ_CACHE.put(key, JSON.stringify(context), { expirationTtl: STALE_RETENTION_SECONDS }).catch(
      (err: unknown) => log("warn", "kv_write_failed", { error: errorMessage(err) }),
    );
    return { context, cache: opts.forceRefresh ? "refresh" : "miss" };
  } catch (err) {
    if (cached) {
      log("warn", "notion_fetch_failed_serving_stale", { error: errorMessage(err), fetchedAt: cached.fetchedAt });
      return { context: cached, cache: "stale" };
    }
    throw err;
  }
}

export async function invalidateHqContext(env: Env): Promise<void> {
  await env.HQ_CACHE.delete(cacheKey(env));
}

export async function fetchHqContext(env: Env, notion: Client = createNotion(env)): Promise<HqContext> {
  const pageId = normalizeNotionId(env.NOTION_HQ_PAGE_ID);
  const page = await notion.pages.retrieve({ page_id: pageId });
  const title = isFullPage(page)
    ? Object.values(page.properties)
        .flatMap((p) => (p.type === "title" ? p.title.map((t) => t.plain_text) : []))
        .join("")
    : "AI Interns — HQ";

  const tree = await fetchBlockTree(notion, pageId, 0);
  const { sections, taskDatabaseIds } = parseSections(pageId, tree);
  const warnings: string[] = [];

  for (const key of ["product_brief", "brand_rules", "tech_stack", "roadmap", "ai_interns", "task_board"] as const) {
    if (!sections[key]) warnings.push(`Section not found in HQ doc: ${key}`);
  }

  let tasks: HqTask[] = [];
  let taskDataSourceId: string | null = null;
  for (const dbId of taskDatabaseIds) {
    try {
      const result = await fetchTasksFromDatabase(notion, dbId);
      tasks = tasks.concat(result.tasks);
      taskDataSourceId ??= result.dataSourceId;
    } catch (err) {
      warnings.push(`Could not read Task Board database ${dbId}: ${errorMessage(err)}`);
    }
  }
  if (tasks.length === 0) {
    for (const table of sections.task_board?.tables ?? []) tasks = tasks.concat(tasksFromTable(table));
  }

  return { pageId, title, fetchedAt: new Date().toISOString(), sections, tasks, taskDataSourceId, warnings };
}

async function fetchBlockTree(notion: Client, blockId: string, depth: number): Promise<BlockNode[]> {
  const raw = await collectPaginatedAPI(notion.blocks.children.list, { block_id: blockId, page_size: 100 });
  const blocks = raw.filter(isFullBlock);
  const nodes: BlockNode[] = blocks.map((block) => ({ block, children: [] }));

  const expandable = nodes.filter(
    (n) =>
      n.block.has_children &&
      depth < MAX_DEPTH &&
      n.block.type !== "child_page" &&
      n.block.type !== "child_database",
  );
  await mapWithConcurrency(expandable, CONCURRENCY, async (n) => {
    n.children = await fetchBlockTree(notion, n.block.id, depth + 1);
  });
  return nodes;
}

async function fetchTasksFromDatabase(
  notion: Client,
  databaseId: string,
): Promise<{ tasks: HqTask[]; dataSourceId: string | null }> {
  const db = await notion.databases.retrieve({ database_id: databaseId });
  const dataSourceId = "data_sources" in db ? (db.data_sources[0]?.id ?? null) : null;
  if (!dataSourceId) return { tasks: [], dataSourceId: null };
  const rows = await collectAllDataSourceRows(notion, { data_source_id: dataSourceId, page_size: 100 });
  return { tasks: rows.filter(isFullPage).map(pageToTask), dataSourceId };
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** True for Notion errors where retrying later could succeed. */
export function isRetryableNotionError(err: unknown): boolean {
  if (!isNotionClientError(err)) return true; // network/unknown — worth one more try
  return (
    err.code === APIErrorCode.RateLimited ||
    err.code === APIErrorCode.InternalServerError ||
    err.code === APIErrorCode.ServiceUnavailable ||
    err.code === APIErrorCode.ConflictError ||
    err.code === "notionhq_client_request_timeout"
  );
}
