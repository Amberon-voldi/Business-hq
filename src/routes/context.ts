import { Hono } from "hono";
import type { AppBindings } from "../env";
import { HttpError } from "../lib/errors";
import { getHqContext } from "../notion/hq";
import { CONTEXT_SECTION_KEYS, type ContextSectionKey, type HqSection } from "../notion/types";
import { requireSharedSecret } from "./auth";
import { businessFromRef } from "./util";

export const contextRoutes = new Hono<AppBindings>();

/**
 * GET /context                       full HQ context as JSON
 * GET /context?sections=a,b          only those sections
 * GET /context?refresh=1             bypass the 5-min cache
 * GET /context?format=markdown       one Markdown document (handy for pasting into an agent)
 * GET /context?business=spinternational   another business from the directory (default: the default business)
 */
contextRoutes.get("/", requireSharedSecret, async (c) => {
  const requested = c.req.query("sections")?.split(",").map((s) => s.trim()).filter(Boolean);
  const invalid = requested?.filter((s) => !(CONTEXT_SECTION_KEYS as string[]).includes(s)) ?? [];
  if (invalid.length) {
    throw new HttpError(422, `Unknown section(s): ${invalid.join(", ")}`, { valid: CONTEXT_SECTION_KEYS });
  }
  const keys = (requested?.length ? requested : CONTEXT_SECTION_KEYS) as ContextSectionKey[];
  const refresh = ["1", "true"].includes(c.req.query("refresh") ?? "");

  const business = await businessFromRef(c.env, c.req.query("business"));
  const { context, cache } = await getHqContext(c.env, business, { forceRefresh: refresh });
  c.header("X-Cache", cache.toUpperCase());

  const sections: Partial<Record<ContextSectionKey, Omit<HqSection, "appendTarget" | "key">>> = {};
  for (const key of keys) {
    const s = context.sections[key];
    if (s) sections[key] = { title: s.title, markdown: s.markdown, tables: s.tables };
  }

  if (c.req.query("format") === "markdown") {
    const md = [`# ${context.title}`, `_Fetched ${context.fetchedAt}_`]
      .concat(Object.values(sections).map((s) => `## ${s.title}\n\n${s.markdown}`))
      .join("\n\n");
    return c.text(md, 200, { "content-type": "text/markdown; charset=utf-8" });
  }

  return c.json({
    business: { id: business.id, name: business.name, domain: business.domain },
    pageId: context.pageId,
    title: context.title,
    fetchedAt: context.fetchedAt,
    cache,
    sections,
    ...(keys.includes("task_board") ? { tasks: context.tasks } : {}),
    warnings: context.warnings,
  });
});
