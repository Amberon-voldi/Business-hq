import { z } from "zod";
import type { Owner } from "../agents/registry";
import type { Env } from "../env";
import { normalizeNotionId } from "../lib/notionId";

/**
 * Admin-editable configuration (business directory + intern delivery), stored as
 * one KV document and edited from the panel. Secrets never live here.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{1,30}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export const BusinessSchema = z.object({
  id: z.string().regex(SLUG, "id: lowercase letters, digits and dashes (2–31 chars)"),
  name: z.string().trim().min(1).max(80),
  domain: z.string().trim().max(120).default(""),
  /** Short names accepted in Slack, URLs and API calls ("spi", "nf"). */
  aliases: z.array(z.string().trim().toLowerCase().regex(SLUG, "aliases: lowercase letters, digits and dashes")).max(10).default([]),
  description: z.string().trim().max(1000).default(""),
  /** Notion "HQ" page for this business (id or URL). Empty = not connected yet. */
  hqPageId: z.string().trim().max(300).default(""),
  /** Name of the secret holding a Notion token, when this HQ lives in another workspace. */
  notionTokenEnv: z.union([z.literal(""), z.string().regex(ENV_NAME, "notionTokenEnv must be an env var name")]).default(""),
  /** Used when the HQ doc has no readable Brand Rules section. */
  brandNotes: z.string().trim().max(4000).default(""),
  /** Phrases that must never appear in this business's copy (case-insensitive). */
  forbiddenTerms: z.array(z.string().trim().min(2).max(80)).max(50).default([]),
});
export type Business = z.infer<typeof BusinessSchema>;

export const DELIVERY = ["api", "inbox"] as const;
export type Delivery = (typeof DELIVERY)[number];

const InternSchema = z.object({ delivery: z.enum(DELIVERY).default("inbox") });

export const ConfigSchema = z.object({
  businesses: z
    .array(BusinessSchema)
    .min(1, "Keep at least one business")
    .max(20)
    .refine((list) => new Set(list.map((b) => b.id)).size === list.length, "Business ids must be unique")
    .refine((list) => {
      const names = list.flatMap((b) => [b.id, ...b.aliases]);
      return new Set(names).size === names.length;
    }, "Each business id and alias must be unique across the directory"),
  defaultBusiness: z.string(),
  interns: z.object({ Code: InternSchema, Pro: InternSchema, Grok: InternSchema, Muse: InternSchema }),
});
export type HqConfig = z.infer<typeof ConfigSchema>;

const CONFIG_KEY = "hq:config:v1";

export const NOIDAFIT_BRAND_NOTES = `- Product name: noida.fit, pronounced "Noida dot fit". Always lowercase with the dot.
- noida.fit is a city-first fitness discovery platform for the NCR region (Delhi-NCR).
- MVP features: the event directory and .fit ID — a personal fitness card with verified check-ins.
- Say ".fit ID" (spoken "dot fit ID"). Never "Fitness ID" or "Fit ID" without the dot.
- Never name specific localities such as "Noida & Greater Noida" in marketing; speak to the NCR / the city.
- Visual identity: accent lime #9ddc2e on dark background #090a0f.`;

/** First-run configuration: noida.fit (from NOTION_HQ_PAGE_ID) and an SP International stub. */
export function defaultConfig(env: Env): HqConfig {
  return {
    defaultBusiness: "noidafit",
    businesses: [
      {
        id: "noidafit",
        name: "noida.fit",
        domain: "noida.fit",
        aliases: ["nf", "noida"],
        description: "City-first fitness discovery platform for Delhi-NCR: event directory and .fit ID.",
        hqPageId: env.NOTION_HQ_PAGE_ID ?? "",
        notionTokenEnv: "",
        brandNotes: NOIDAFIT_BRAND_NOTES,
        forbiddenTerms: ["Fitness ID", "Greater Noida", "NoidaFit", "Noida Fit"],
      },
      {
        id: "spinternational",
        name: "SP International",
        domain: "spinternationalpvtltd.com",
        aliases: ["spi", "sp"],
        description: "",
        hqPageId: "",
        notionTokenEnv: "",
        brandNotes: "",
        forbiddenTerms: [],
      },
    ],
    // Inbox by default: interns run in apps you already subscribe to, so nothing is billed per token.
    interns: { Code: { delivery: "inbox" }, Pro: { delivery: "inbox" }, Grok: { delivery: "inbox" }, Muse: { delivery: "inbox" } },
  };
}

export async function getConfig(env: Env): Promise<HqConfig> {
  const stored = await env.HQ_CACHE.get<unknown>(CONFIG_KEY, "json");
  if (stored) {
    const parsed = ConfigSchema.safeParse(stored);
    if (parsed.success) return withEnvFallbacks(env, parsed.data);
  }
  return defaultConfig(env);
}

/** NOTION_HQ_PAGE_ID still feeds the noida.fit entry until an HQ page is set in the panel. */
function withEnvFallbacks(env: Env, config: HqConfig): HqConfig {
  for (const b of config.businesses) {
    if (b.id === "noidafit" && !b.hqPageId && env.NOTION_HQ_PAGE_ID) b.hqPageId = env.NOTION_HQ_PAGE_ID;
  }
  return config;
}

export class ConfigError extends Error {}

export async function saveConfig(env: Env, input: unknown): Promise<HqConfig> {
  const parsed = ConfigSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError(z.prettifyError(parsed.error));
  const config = parsed.data;
  if (!config.businesses.some((b) => b.id === config.defaultBusiness)) {
    throw new ConfigError("defaultBusiness must be one of the business ids");
  }
  for (const b of config.businesses) {
    if (!b.hqPageId) continue;
    try {
      b.hqPageId = normalizeNotionId(b.hqPageId);
    } catch {
      throw new ConfigError(`${b.name}: HQ page must be a Notion page URL or 32-character id`);
    }
  }
  await env.HQ_CACHE.put(CONFIG_KEY, JSON.stringify(config));
  return config;
}

/** Finds a business by id, name or domain ("spi", "noida.fit"…); falls back to the default when id is empty. */
export function findBusiness(config: HqConfig, ref?: string | null): Business | null {
  if (!ref?.trim()) return config.businesses.find((b) => b.id === config.defaultBusiness) ?? config.businesses[0] ?? null;
  const norm = ref.trim().toLowerCase();
  return (
    config.businesses.find(
      (b) =>
        b.id === norm ||
        b.aliases.includes(norm) ||
        b.name.toLowerCase() === norm ||
        (b.domain && (b.domain.toLowerCase() === norm || b.domain.toLowerCase().split(".")[0] === norm)),
    ) ?? null
  );
}

/** Notion token for a business: its own secret when it lives in another workspace. */
export function notionTokenFor(env: Env, business: Business | null): string {
  if (business?.notionTokenEnv) {
    const value = (env as unknown as Record<string, unknown>)[business.notionTokenEnv];
    if (typeof value === "string" && value) return value;
    throw new Error(`Secret ${business.notionTokenEnv} (Notion token for ${business.name}) is not set`);
  }
  return env.NOTION_TOKEN;
}

export function deliveryFor(config: HqConfig, owner: Owner): Delivery {
  return config.interns[owner]?.delivery ?? "inbox";
}
