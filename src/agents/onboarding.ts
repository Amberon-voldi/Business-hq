import { type Business, type HqConfig, deliveryFor } from "../config/store";
import type { JobListItem } from "../dispatch/jobs";
import type { ContextSectionKey, HqContext } from "../notion/types";
import type { TeamMessage } from "../team/messages";
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
  const api = `${origin}/agent/v1`;
  const mcp = `${origin}/mcp/${token}`;
  const multi = config.businesses.length > 1;
  const hooks = config.businesses
    .map((b) => {
      const q = multi ? `?business=${b.id}` : "";
      return `- **${b.name}**: Notion Task Board → \`${origin}/webhook/notion${q}\` · GitHub → \`${origin}/webhook/github${q}\``;
    })
    .join("\n");
  const apiNote =
    deliveryFor(config, owner) === "inbox"
      ? ""
      : `\n> ${owner} is currently set to "api" delivery, so the server runs most of your tasks itself. Ask the human to switch you to Inbox in the panel if you should do them.\n`;

  return `${header(owner, config)}

**The human** (founder) is also on the team as \`Human\`. Message them for decisions, approvals and anything only they know.

## 1 · Connect to business-hq
business-hq is the team's shared server: your inbox, the shared context, team chat and the Notion write-back. Use the first option your environment supports.

**A. Connector (MCP): Claude apps, Claude Code, any MCP client**
- Connector URL (it contains your key; keep it private): \`${mcp}\`
- Claude app: Settings → Connectors → Add custom connector → name it **business-hq** → paste the URL.
- Claude Code: \`claude mcp add --transport http business-hq ${mcp}\`
- Tools: \`check_in\`, \`get_briefing\`, \`list_tasks\`, \`get_task\`, \`claim_task\`, \`complete_task\`, \`fail_task\`, \`delegate_task\`, \`send_message\`, \`read_messages\`, \`log_note\`.

**B. HTTP API: anything that can make web requests (scripts, actions, tools)**
- Base URL: \`${api}\`
- Key, sent on every request: \`Authorization: Bearer ${token}\`

| Call | Same as tool | Body |
| --- | --- | --- |
| \`GET /me\` | (part of check_in) | |
| \`GET /briefing?business=<id>\` | get_briefing | |
| \`GET /tasks\` · \`GET /tasks/<id>\` | list_tasks · get_task | |
| \`POST /tasks/<id>/claim\` | claim_task | |
| \`POST /tasks/<id>/complete\` | complete_task | \`{"summary": "...", "output": "<Markdown>"}\` |
| \`POST /tasks/<id>/fail\` | fail_task | \`{"reason": "..."}\` |
| \`POST /delegate\` | delegate_task | \`{"task", "owner", "kind", "business", "notes", "parent_task_id"}\` |
| \`GET /messages?history=1\` · \`POST /messages\` | read_messages · send_message | \`{"to": "Code, Pro, Grok, Muse, Human or team", "text", "business", "task_id"}\` |
| \`POST /log\` | log_note | \`{"business", "message"}\` |

Task kinds: ${KIND_LIST}.

**C. Can't connect?** Say so and ask the human for your **offline pack** (panel → Agents → ${owner}).

Your key only grants ${owner}'s access. Never put it in a deliverable, a message or anywhere public.

## 2 · How work reaches the team
You don't call these; they're how work arrives, and everything ends up in your inbox:
- The human delegates from the panel (\`${origin}/panel\`) or Slack (\`/intern [business] <intern or task type> <task>\`).
- A Notion Task Board row set to **In progress** with Owner = ${owner}.
- GitHub issues or PRs labelled \`ai:${owner.toLowerCase()}\`.
- A teammate's \`delegate_task\`.

Webhooks (reference):
${hooks}
- Slack → \`${origin}/webhook/slack\`

## 3 · Your routine (hands-free)
Whenever a session starts, or you're told **"check in"**:
1. \`check_in\` reads your messages and inbox. Answer teammates' questions first, briefly.
2. \`get_briefing\` for any business you haven't loaded this session.
3. For each task, oldest first: \`get_task\` → \`claim_task\` → do the work by following the prompt it returns → \`complete_task\`. If you're truly blocked, use \`fail_task\` with exactly what you need.
4. Work that belongs to a teammate goes to them with \`delegate_task\` and clear notes (code → Code; research or business email → Pro; social → Grok; marketing copy → Muse). When they finish, you get a message. Fold their result into yours if it was part of your task.
5. End with a 3-line report to the human: done · delegated · blocked.

Don't ask for confirmation between steps. Ask the human (\`send_message\` to \`Human\`) only when you can't proceed without them.
To stay on duty without prompting: in Claude Code run \`/loop 15m check in\`. In a chat app, the human just says "check in".
${apiNote}
## 4 · Talking to teammates
- Use \`send_message\` for questions, hand-offs and FYIs. Keep it short and specific, and include the business id and task id when relevant.
- \`to: "team"\` only for things everyone needs.
- Work requests go through \`delegate_task\`, not a message, so they're tracked and land in Notion.

${rules(config)}

Reply "Ready. ${owner} checking in." and then run your routine.`;
}

export function offlinePrompt(args: {
  owner: Owner;
  config: HqConfig;
  contexts: BusinessContext[];
  tasks: { item: JobListItem; detail: string }[];
  messages?: TeamMessage[];
}): string {
  const { owner, config, contexts, tasks } = args;
  const inboxMessages = (args.messages ?? [])
    .map((m) => `- **${m.from}** → ${m.to}${m.business ? ` (${m.business})` : ""}: ${m.text}`)
    .join("\n");
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

To message a teammate or the human, or to hand work to a teammate, add:

\`\`\`
=== MESSAGE <Code|Pro|Grok|Muse|Human|team> ===
<your message; for a hand-off, say exactly what you need and for which business>
=== END ===
\`\`\`

## Shared context
${ctx}

## Messages for you
${inboxMessages || "_No messages._"}

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
