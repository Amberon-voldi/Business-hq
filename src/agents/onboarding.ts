import { type Business, type HqConfig, deliveryFor } from "../config/store";
import type { JobListItem } from "../dispatch/jobs";
import type { ContextSectionKey, HqContext } from "../notion/types";
import { businessLine, renderSections } from "./prompt";
import { AGENTS, OWNERS, type Owner, TASK_KINDS, TASK_KIND_KEYS } from "./registry";

/**
 * Prompts that onboard an external agent (Grok in its own app, a Claude/ChatGPT project
 * for Muse, …) as a member of the AI Interns team. Two variants:
 *  - connected: the agent calls the HQ server itself (/agent/v1) — hands-free.
 *  - offline:   context and open tasks are pasted in; results are pasted back via the panel.
 */

export interface BusinessContext {
  business: Business;
  context: HqContext | null;
  error?: string;
}

/** What every intern gets in its briefing: the shared basics plus its own default sections. */
export function briefingSections(owner: Owner): ContextSectionKey[] {
  const set = new Set<ContextSectionKey>(["product_brief", "brand_rules", "ai_interns", ...AGENTS[owner].defaultSections]);
  return (["product_brief", "brand_rules", "tech_stack", "roadmap", "ai_interns", "task_board"] as const).filter((k) =>
    set.has(k),
  );
}

function teammates(owner: Owner): string {
  return OWNERS.filter((o) => o !== owner)
    .map((o) => `- **${o}** — ${AGENTS[o].role}`)
    .join("\n");
}

function businessList(config: HqConfig): string {
  return config.businesses
    .map((b) => `- \`${b.id}\` — ${businessLine(b)}${b.id === config.defaultBusiness ? " _(default)_" : ""}`)
    .join("\n");
}

function brandGuardrails(config: HqConfig): string {
  const lines = config.businesses
    .filter((b) => b.forbiddenTerms.length || b.brandNotes)
    .map((b) => {
      const never = b.forbiddenTerms.length ? ` Never write: ${b.forbiddenTerms.map((t) => `"${t}"`).join(", ")}.` : "";
      return `  - **${b.name}:** follow its Brand Rules section exactly.${never}`;
    });
  return lines.length ? lines.join("\n") : "  - Follow each business's Brand Rules section exactly.";
}

const KIND_LIST = TASK_KIND_KEYS.map((k) => `\`${k}\``).join(", ");

function header(owner: Owner, config: HqConfig): string {
  const n = config.businesses.length;
  return `# Onboarding: you are "${owner}", one of the AI Interns

You're joining **AI Interns**, a small AI team working for the same founders across ${n} business${n === 1 ? "" : "es"}:
${businessList(config)}

**Your role:** ${AGENTS[owner].role}

**Your teammates:**
${teammates(owner)}

Each business has an "HQ" doc in Notion (product brief, brand rules, tech stack, roadmap, task board, log). The HQ server keeps it in sync and gives you the parts you need. Notion is the source of truth.`;
}

function rules(config: HqConfig): string {
  return `## Ground rules
- Every task belongs to exactly one business. Use only that business's context and never mix facts between businesses.
- Brand safety:
${brandGuardrails(config)}
- Emails, posts and outreach are **drafts** for a human to review and send. Never claim something was sent, posted, booked or paid.
- Don't invent numbers, quotes, prices, contacts or sources. Say what needs verifying.
- If a task is ambiguous, make a sensible assumption, state it in one line, and deliver anyway.
- Start every deliverable with \`Summary: <one sentence>\`, then the deliverable in Markdown.`;
}

export function connectedPrompt(args: { owner: Owner; config: HqConfig; origin: string; token: string }): string {
  const { owner, config, origin, token } = args;
  const base = `${origin}/agent/v1`;
  const apiNote =
    deliveryFor(config, owner) === "inbox"
      ? ""
      : `\n_Note: ${owner} is currently set to "api" delivery, so the HQ server runs most of your tasks itself. Your inbox fills up when work is assigned to you with delivery "inbox", or once the admin switches you to inbox in the panel._\n`;
  return `${header(owner, config)}

## Connection
- Base URL: \`${base}\`
- Send this header on every request: \`Authorization: Bearer ${token}\`
- The token only grants ${owner}'s access. Never paste it into a task, an output or a message.

## Endpoints
| Call | What it's for |
| --- | --- |
| \`GET /me\` | Who you are, the businesses, your teammates |
| \`GET /briefing\` | Shared context for every business (add \`?business=<id>\` for one) |
| \`GET /tasks\` | Your inbox: tasks assigned to you |
| \`GET /tasks/<id>\` | One task, with a ready-made prompt built from the right business's context |
| \`POST /tasks/<id>/claim\` | Mark it in progress before you start |
| \`POST /tasks/<id>/complete\` | \`{"summary": "...", "output": "<deliverable in Markdown>"}\` writes it to Notion and replies in Slack |
| \`POST /tasks/<id>/fail\` | \`{"reason": "what blocked you and what you need"}\` |
| \`POST /delegate\` | \`{"business": "<id>", "owner": "Code, Pro, Grok or Muse", "kind": one of ${KIND_LIST}, "task": "...", "notes": "...", "parent_task_id": "<optional>"}\` |
| \`POST /log\` | \`{"business": "<id>", "message": "..."}\` adds a note to that business's HQ Log |

## Your working loop (hands-free)
When a session starts, or whenever you're told **"check in"**:
1. \`GET /briefing\` to refresh context, then \`GET /tasks\`.
2. For each task: \`GET /tasks/<id>\`, \`POST …/claim\`, do the work by following the returned prompt, then \`POST …/complete\`. If you're truly blocked, \`POST …/fail\` with what you need.
3. If part of the work belongs to a teammate (code → Code; research or business email → Pro; social → Grok; marketing copy → Muse), \`POST /delegate\` it with clear notes and mention that in your result.
4. Finish with a short report to the human: done, delegated, blocked.

Work through the whole inbox without asking for confirmation. Ask the human only when a task can't be done without information nobody has given you.
${apiNote}
${rules(config)}

## If you can't make HTTP requests
Say so, and ask the human to paste your **offline pack** (panel → Agents → ${owner} → Offline pack).

Reply "Ready. ${owner} checking in." and then run the loop.`;
}

export function offlinePrompt(args: {
  owner: Owner;
  config: HqConfig;
  contexts: BusinessContext[];
  tasks: { item: JobListItem; detail: string }[];
}): string {
  const { owner, config, contexts, tasks } = args;
  const sections = briefingSections(owner);
  const ctx = contexts
    .map(({ business, context, error }) => {
      const body = renderSections(business, context, sections);
      const note = error ? `_(HQ doc unavailable: ${error})_\n\n` : "";
      return `### ${business.name} (\`${business.id}\`)\n${note}${body || "_No HQ context yet._"}`;
    })
    .join("\n\n");
  const inbox = tasks.length
    ? tasks
        .map(({ item, detail }) => {
          const kind = TASK_KINDS[item.kind as keyof typeof TASK_KINDS]?.label ?? item.kind;
          return `### Task \`${item.id}\` · ${item.business} · ${kind}\n${detail}`;
        })
        .join("\n\n")
    : "_Your inbox is empty right now._";

  return `${header(owner, config)}

You can't reach the HQ server from here, so your context and inbox are pasted below. It's a snapshot; ask for a fresh pack if it's more than a day old.

${rules(config)}

## How to hand work back
For each task you finish, reply with exactly this block (one per task) so the human can paste it into the panel:

\`\`\`
=== RESULT <task id> ===
Summary: <one sentence>
<the deliverable in Markdown>
=== END ===
\`\`\`

If something should go to a teammate, add a line under the result: \`Delegate to <Owner> (<business id>): <task>\`.

## Shared context
${ctx}

## Your inbox
${inbox}

Start with the oldest task. If the inbox is empty, reply "Ready. ${owner} checking in."`;
}

/** Plain briefing document served at GET /agent/v1/briefing. */
export function briefingMarkdown(owner: Owner, config: HqConfig, contexts: BusinessContext[]): string {
  const sections = briefingSections(owner);
  return [
    `# Briefing for ${owner}`,
    `_Generated ${new Date().toISOString()}. Businesses: ${config.businesses.map((b) => b.id).join(", ")}._`,
    ...contexts.map(({ business, context, error }) => {
      const body = renderSections(business, context, sections);
      return `## ${businessLine(business)}\n${error ? `_(HQ doc unavailable: ${error})_\n\n` : ""}${body || "_No HQ context yet._"}`;
    }),
  ].join("\n\n");
}
