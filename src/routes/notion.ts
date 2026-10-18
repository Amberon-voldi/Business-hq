import { Hono } from "hono";
import { isFullPage } from "@notionhq/client";
import { parseOwner } from "../agents/registry";
import { enqueueDispatch } from "../dispatch/queue";
import { activeTaskKey, markTaskActive } from "../dispatch/run";
import type { DispatchJob } from "../dispatch/types";
import type { AppBindings } from "../env";
import { verifyNotionSignature, verifySharedSecret } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import { log } from "../lib/logger";
import { createNotion, normalizeNotionId } from "../notion/client";
import { getHqContext, invalidateHqContext } from "../notion/hq";
import { pageToTask } from "../notion/properties";

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
 *  - Database automations ("Send webhook" action): payload `data` is the page; authenticate
 *    by adding a custom header `X-Webhook-Secret: <WEBHOOK_SECRET>` in the automation.
 *  - Integration webhooks (API subscriptions): signed with `X-Notion-Signature`, payload
 *    `entity` references the page.
 * The page is always re-read from the API so the decision uses current Owner/Status.
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
  const hqPageId = normalizeNotionId(c.env.NOTION_HQ_PAGE_ID);
  if (pageId === hqPageId) {
    await invalidateHqContext(c.env);
    return c.json({ status: "context_invalidated" });
  }

  const notion = createNotion(c.env);
  const page = await notion.pages.retrieve({ page_id: pageId });
  if (!isFullPage(page)) return c.json({ status: "ignored", reason: "page not accessible" });

  // Task Board edits change the cached context; refresh it in the background.
  c.executionCtx.waitUntil(invalidateHqContext(c.env));

  const task = pageToTask(page);
  if (task.status?.trim().toLowerCase() !== "in progress") {
    return c.json({ status: "ignored", reason: `status is "${task.status ?? "unset"}"` });
  }
  const owner = parseOwner(task.owner);
  if (!owner) return c.json({ status: "ignored", reason: `owner "${task.owner ?? "unset"}" is not an AI intern` });

  // Only rows of the HQ Task Board database may trigger dispatches.
  if (page.parent.type === "data_source_id") {
    const { context } = await getHqContext(c.env);
    if (context.taskDataSourceId && context.taskDataSourceId !== page.parent.data_source_id) {
      return c.json({ status: "ignored", reason: "page is not in the HQ Task Board" });
    }
  }

  const job: DispatchJob = {
    id: crypto.randomUUID(),
    task: task.title,
    owner,
    taskPageId: pageId,
    source: { kind: "notion" },
    requestedAt: new Date().toISOString(),
  };

  if (!(await markTaskActive(c.env, pageId, job.id))) {
    return c.json({ status: "ignored", reason: "dispatch already in progress for this task" });
  }
  try {
    await enqueueDispatch(c.env, job);
  } catch (err) {
    await c.env.HQ_CACHE.delete(activeTaskKey(pageId));
    throw err;
  }
  return c.json({ status: "queued", id: job.id, owner }, 202);
});
