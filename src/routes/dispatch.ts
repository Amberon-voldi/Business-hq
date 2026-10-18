import { Hono } from "hono";
import { z } from "zod";
import { OWNERS, TASK_KINDS, TASK_KIND_KEYS, type TaskKind, parseOwner } from "../agents/registry";
import { DELIVERY } from "../config/store";
import { startDispatch } from "../dispatch/start";
import type { DispatchJob } from "../dispatch/types";
import type { AppBindings } from "../env";
import { HttpError } from "../lib/errors";
import { normalizeNotionId } from "../notion/client";
import { CONTEXT_SECTION_KEYS, type ContextSectionKey } from "../notion/types";
import { requireSharedSecret } from "./auth";
import { businessFromRef } from "./util";

export const DispatchBody = z.object({
  task: z.string().trim().min(1, "task is required").max(20_000),
  /** Optional when `kind` implies an intern (email → Pro, social → Grok…). */
  owner: z.string().optional(),
  /** Business id/name/domain from the directory; defaults to the default business. */
  business: z.string().optional(),
  kind: z.enum(TASK_KIND_KEYS as [TaskKind, ...TaskKind[]]).default("general"),
  context_sections: z.array(z.enum(CONTEXT_SECTION_KEYS as [ContextSectionKey, ...ContextSectionKey[]])).optional(),
  /** Optional Task Board row to update with status + deliverable. */
  notion_task_id: z.string().optional(),
  /** Override the intern's configured delivery: "api" (worker runs it) or "inbox" (external agent). */
  delivery: z.enum(DELIVERY).optional(),
  /** false = run inline and return the result (api delivery only; can take minutes). */
  async: z.boolean().default(true),
});

export const dispatchRoutes = new Hono<AppBindings>();

dispatchRoutes.post("/", requireSharedSecret, async (c) => {
  const json = await c.req.json().catch(() => {
    throw new HttpError(400, "Body must be JSON");
  });
  const parsed = DispatchBody.safeParse(json);
  if (!parsed.success) throw new HttpError(422, "Invalid dispatch request", z.flattenError(parsed.error).fieldErrors);
  const body = parsed.data;

  const owner = parseOwner(body.owner) ?? (body.owner ? null : TASK_KINDS[body.kind].owner);
  if (!owner) {
    throw new HttpError(422, "Invalid dispatch request", {
      owner: [`owner must be one of ${OWNERS.join("|")} (or set a kind that implies one)`],
    });
  }
  const business = await businessFromRef(c.env, body.business);

  let taskPageId: string | undefined;
  if (body.notion_task_id) {
    try {
      taskPageId = normalizeNotionId(body.notion_task_id);
    } catch {
      throw new HttpError(422, "notion_task_id is not a valid Notion page id or URL");
    }
  }

  const job: DispatchJob = {
    id: crypto.randomUUID(),
    business: business.id,
    task: body.task,
    owner,
    kind: body.kind,
    ...(body.delivery ? { delivery: body.delivery } : {}),
    ...(body.context_sections ? { contextSections: body.context_sections } : {}),
    ...(taskPageId ? { taskPageId } : {}),
    source: { kind: "manual" },
    requestedAt: new Date().toISOString(),
  };

  const outcome = await startDispatch(c.env, job, { async: body.async });
  if (outcome.mode === "done") return c.json({ status: "done", business: business.id, ...outcome.result });
  return c.json(
    { id: job.id, status: outcome.mode, owner, business: business.id, kind: body.kind, delivery: job.delivery },
    202,
  );
});
