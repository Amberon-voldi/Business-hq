import type { Owner } from "./registry";
import { AGENTS } from "./registry";

/**
 * Used only when the HQ doc's Brand Rules section can't be read, so copy tasks
 * never go out without guardrails. Notion stays the source of truth.
 */
export const BRAND_BASELINE = `- Product name: **noida.fit**, pronounced "Noida dot fit". Always lowercase with the dot.
- noida.fit is a city-first fitness discovery platform for the NCR region (Delhi-NCR).
- MVP features: the event directory and **.fit ID** — a personal fitness card with verified check-ins.
- Say ".fit ID" (spoken "dot fit ID"). Never "Fitness ID" or "Fit ID" without the dot.
- Never name specific localities such as "Noida & Greater Noida" in marketing; speak to the NCR / the city.
- Visual identity: accent lime #9ddc2e on dark background #090a0f.`;

const COPY_KEYWORDS =
  /\b(tweet|thread|post|caption|copy|copywriting|tagline|headline|slogan|ad|ads|campaign|marketing|landing page|email|newsletter|social|instagram|linkedin|reel|launch|announcement|press|blog|bio|cta|brand)\b/i;

/** Brand safety trigger: copy agents always, plus any task that reads like marketing. */
export function isCopyTask(task: string, owner: Owner): boolean {
  return AGENTS[owner].writesCopy || COPY_KEYWORDS.test(task);
}

interface BrandRule {
  pattern: RegExp;
  message: string;
}

const BRAND_RULES: BrandRule[] = [
  { pattern: /\bfitness[\s-]?id\b/i, message: 'Uses "Fitness ID" — the product is ".fit ID".' },
  { pattern: /(?<![.\w])fit[\s-]?id\b/i, message: 'Uses "Fit ID" without the leading dot — write ".fit ID".' },
  {
    pattern: /\bgreater\s+noida\b/i,
    message: 'Names a specific location ("Greater Noida") — marketing must speak to the NCR, not localities.',
  },
  { pattern: /\bnoida[\s-]?fit\b(?!\.)/i, message: 'Writes the brand as "Noida Fit"/"NoidaFit" — use "noida.fit".' },
];

/** Flags brand-rule violations in agent output. Advisory: surfaced in Notion and Slack, not blocking. */
export function lintBrand(text: string): string[] {
  return BRAND_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => `Brand check: ${rule.message}`);
}
