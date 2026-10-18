import type { Business } from "../config/store";
import { AGENTS, type Owner, TASK_KINDS, type TaskKind } from "./registry";

const COPY_KEYWORDS =
  /\b(tweet|thread|post|caption|copy|copywriting|tagline|headline|slogan|ad|ads|campaign|marketing|landing page|email|newsletter|social|instagram|linkedin|reel|launch|announcement|press|blog|bio|cta|brand|outreach|pitch)\b/i;

/** Brand safety trigger: copy interns and copy task types always, plus anything that reads like marketing. */
export function isCopyTask(task: string, owner: Owner, kind: TaskKind = "general"): boolean {
  return AGENTS[owner].writesCopy || TASK_KINDS[kind].copy || COPY_KEYWORDS.test(task);
}

/** noida.fit's naming rules need more than plain phrase matching. */
const NOIDAFIT_PATTERNS: { pattern: RegExp; message: string }[] = [
  { pattern: /(?<![.\w])fit[\s-]?id\b/i, message: 'Uses "Fit ID" without the leading dot — write ".fit ID".' },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Flags brand-rule violations in output. Advisory: surfaced in Notion, Slack and the panel, never blocking. */
export function lintBrand(text: string, business: Business): string[] {
  const warnings: string[] = [];
  // Terms like "NoidaFit" and "Noida Fit" can hit the same words; report each spot once.
  const seen: [number, number][] = [];
  for (const term of business.forbiddenTerms) {
    const re = new RegExp(`(?<![\\w.])${escapeRegExp(term).replace(/ +/g, "[\\s-]?")}(?![\\w])`, "i");
    const m = re.exec(text);
    if (!m) continue;
    const span: [number, number] = [m.index, m.index + m[0].length];
    if (seen.some(([a, b]) => span[0] < b && a < span[1])) continue;
    seen.push(span);
    warnings.push(`Brand check (${business.name}): uses "${term}", which the brand rules forbid.`);
  }
  if (business.id === "noidafit") {
    for (const rule of NOIDAFIT_PATTERNS) if (rule.pattern.test(text)) warnings.push(`Brand check (noida.fit): ${rule.message}`);
  }
  return warnings;
}
