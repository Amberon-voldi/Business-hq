import { type PageObjectResponse, isFullPage } from "@notionhq/client";
import { Hono } from "hono";
import { parseKind, parseOwner } from "../agents/registry";
import { type Business, findBusiness, getConfig } from "../config/store";
import { activeTaskKey, markTaskActive } from "../dispatch/run";
import { startDispatch } from "../dispatch/start";
import type { DispatchJob } from "../dispatch/types";
import type { AppBindings, Env } from "../env";
import { verifyNotionSignature, verifySharedSecret } from "../lib/crypto";
import { HttpError, errorMessage } from "../lib/errors";
import { log } from "../lib/logger";
import { createNotion, normalizeNotionId } from "../notion/client";
import { getHqContext, invalidateHqContext } from "../notion/hq";
import { findProperty, pageToTask, propertyToText } from "../notion/properties";

export const notionWebhook = new Hono<AppBindings>();

type NotionPayload = {
  verification_token?: string;
  type?: string;
  entity?: { id?: string; type?: string };
  data?: { id?: string; object?: string; parent?: { id?: string } };
  page_id?: string;
};

/**
 * Accepts both Notion delivery styles:
 *  - Database automations ("Send webhook"): payload `data` is the page; authenticate with a
 *    custom header `X-Webhook-Secret: <WEBHOOK_SECRET>`.
 *  - Integration webhooks (API subscriptions): signed with `X-Notion-Signature`.
 * Add `?business=<id>` to the URL when several businesses are configured; otherwise the
 * business is inferred from the HQ page / Task Board the page belongs to.
 */
notionWebhook.post("/", async (c) => {
  const raw = await c.req.text();
  let body: NotionPayload;
  try {
    body = JSON.parse(raw) as NotionPayload;
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }

  // One-time subscription handshake: Notion sends the token we must store as a secret.
  if (typeof body.verification_token === "string" && !body.type) {
    log("warn", "notion_webhook_verification_token_received", {
      hint: "Paste this token in Notion to verify, then: wrangler secret put NOTION_WEBHOOK_VERIFICATION_TOKEN",
      verification_token: body.verification_token,
    });
    return c.json({ ok: true });
  }

  const signature = c.req.header("x-notion-signature");
  const signedOk =
    !!signature &&
    !!c.env.NOTION_WEBHOOK_VERIFICATION_TOKEN &&
    (await verifyNotionSignature(c.env.NOTION_WEBHOOK_VERIFICATION_TOKEN, raw, signature));
  if (!signedOk && !verifySharedSecret(c.env.WEBHOOK_SECRET, c.req.raw.headers)) {
    throw new HttpError(401, "Invalid Notion webhook signature");
  }

  const rawId =
    (body.entity?.type === "page" ? body.entity.id : undefined) ??
    (body.data?.object === "page" ? body.data.id : undefined) ??
    body.page_id ??
    body.data?.id;
  if (!rawId) return c.json({ status: "ignored", reason: "no page id in payload" });
  const pageId = normalizeNotionId(rawId);

  const config = await getConfig(c.env);
  const ref = c.req.query("business");
  const pinned = ref ? findBusiness(config, ref) : null;
  if (ref && !pinned) throw new HttpError(422, `Unknown business "${ref}"`);
  const candidates = (pinned ? [pinned] : config.businesses).filter((b) => b.hqPageId);

  // Edits to an HQ page itself only refresh that business's cached context.
  const hqOwner = candidates.find((b) => normalizeNotionId(b.hqPageId) === pageId);
  if (hqOwner) {
    await invalidateHqContext(c.env, hqOwner);
    return c.json({ status: "context_invalidated", business: hqOwner.id });
  }

  const match = await locateTaskPage(c.env, candidates, pageId);
  if (!match) return c.json({ status: "ignored", reason: "page is not on any business's Task Board" });
  const { business, page } = match;
  c.executionCtx.waitUntil(invalidateHqContext(c.env, business));

  const task = pageToTask(page);
  if (task.status?.trim().toLowerCase() !== "in progress") {
    return c.json({ status: "ignored", reason: `status is "${task.status ?? "unset"}"` });
  }
  const owner = parseOwner(task.owner);
  if (!owner) return c.json({ status: "ignored", reason: `owner "${task.owner ?? "unset"}" is not an AI intern` });

  // Optional "Type"/"Kind" select on the Task Board maps to a task kind (Email, Research…).
  const kindProp = findProperty(page, /^(type|kind|task type)$/i, ["select", "status", "rich_text"]);
  const kind = parseKind(propertyToText(kindProp?.prop)) ?? "general";

  const job: DispatchJob = {
    id: crypto.randomUUID(),
    business: business.id,
    task: task.title,
    owner,
    kind,
    taskPageId: pageId,
    source: { kind: "notion" },
    requestedAt: new Date().toISOString(),
  };

  // The task is already "In progress" in Notion: lock it here so duplicate deliveries are ignored.
  if (!(await markTaskActive(c.env, pageId, job.id))) {
    return c.json({ status: "ignored", reason: "dispatch already in progress for this task" });
  }
  try {
    const outcome = await startDispatch(c.env, job, { async: true, taskLocked: true });
    return c.json({ status: outcome.mode, id: job.id, owner, business: business.id, kind }, 202);
  } catch (err) {
    await c.env.HQ_CACHE.delete(activeTaskKey(pageId));
    throw err;
  }
});

/**
 * Reads the page with each candidate business's Notion token and keeps the business whose
 * Task Board database contains it (or the only candidate, when there's just one).
 */
async function locateTaskPage(
  env: Env,
  candidates: Business[],
  pageId: string,
): Promise<{ business: Business; page: PageObjectResponse } | null> {
  for (const business of candidates) {
    let page;
    try {
      page = await createNotion(env, business).pages.retrieve({ page_id: pageId });
    } catch (err) {
      log("info", "notion_page_not_visible", { business: business.id, error: errorMessage(err) });
      continue;
    }
    if (!isFullPage(page)) continue;
    if (candidates.length === 1) return { business, page };
    if (page.parent.type !== "data_source_id") continue;
    const { context } = await getHqContext(env, business).catch(() => ({ context: null }));
    if (context?.taskDataSourceId === page.parent.data_source_id) return { business, page };
  }
  return null;
}
