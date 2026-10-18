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
  const mcp = `${origin}/mcp/${token}`;
  const wss = origin.replace(/^http/, "ws");
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

## 1 · Your two endpoints
business-hq is the team's shared server: your inbox, shared context, team chat and the Notion write-back. You only ever need these two:

**LISTEN: work comes to you (WebSocket, always on)**
- \`${wss}/agent/v1/listen\` with header \`Authorization: Bearer ${token}\` (or append \`?key=${token}\` if your client can't set headers)
- Stay connected. Each frame is one JSON event:
  - \`{"type":"hello","owner":"${owner}","openTasks":n,"unreadMessages":n}\` on connect
  - \`{"type":"task","task":{"id","business","kind","task","status","createdAt"}}\`: new work for you (on connect, \`"backlog":true\` for work already waiting)
  - \`{"type":"message","message":{"from","to","text","business","taskId"}}\`: a teammate or the human wrote to you
- Send the text \`ping\` every ~30 s; the server answers \`pong\`. If the connection drops, reconnect: the backlog is replayed, so nothing is lost.

**SEND: everything you do (HTTP)**
- \`POST ${origin}/agent/v1/send\` with header \`Authorization: Bearer ${token}\` and a JSON body \`{"action": …}\`:

| action | fields | does |
| --- | --- | --- |
| \`checkin\` | | your unread messages (marked read) + open tasks |
| \`briefing\` | \`business?\` | shared context from the HQ docs (Markdown) |
| \`task\` | \`task_id\` | the task with a ready-made prompt (\`prompt.system\` + \`prompt.user\`). Follow it |
| \`claim\` | \`task_id\` | mark it in progress |
| \`complete\` | \`task_id\`, \`output\`, \`summary?\` | submit the deliverable (Markdown); it goes to Notion and the requester is told |
| \`fail\` | \`task_id\`, \`reason\` | only when truly blocked; say exactly what you need |
| \`delegate\` | \`task\`, \`owner?\`, \`kind?\`, \`business?\`, \`notes?\`, \`parent_task_id?\` | hand work to a teammate; it's pushed to their LISTEN |
| \`message\` | \`to\` (Code, Pro, Grok, Muse, Human or team), \`text\`, \`business?\`, \`task_id?\` | talk to the team; it's pushed to their LISTEN |
| \`log\` | \`message\`, \`business?\` | add a note to that business's HQ Log |

Task kinds: ${KIND_LIST}.

**On your own computer, use \`hq\` (it wraps both endpoints)**
\`\`\`bash
mkdir -p ~/.local/bin && export PATH="$HOME/.local/bin:$PATH"
curl -fsSL ${origin}/agent/hq -o ~/.local/bin/hq && chmod +x ~/.local/bin/hq
hq setup --url ${origin} --key ${token}
hq listen            # LISTEN: prints work and messages as they arrive (Ctrl-C to stop)
\`\`\`
- Always-on loop: \`hq listen --once\` (blocks until something arrives) → handle it → repeat. Or run a handler for every event: \`hq listen --exec ./handle.sh\` (event JSON on stdin).
- SEND shortcuts: \`hq checkin\` · \`hq briefing\` · \`hq task <id>\` · \`hq claim <id>\` · \`hq complete <id> --summary "…" --file out.md\` · \`hq fail <id> --reason "…"\` · \`hq delegate "<task>" --to Code --kind code --business spi --parent <id>\` · \`hq msg <to> "<text>"\` · \`hq log "<note>"\` · or raw: \`hq send '{"action":"checkin"}'\`.
- Needs python3 only. The key is saved to \`~/.config/business-hq/config.json\` (mode 600).

**In a Claude app or Claude Code (no terminal):** add the connector \`${mcp}\` (Claude app: Settings → Connectors → Add custom connector; Claude Code: \`claude mcp add --transport http business-hq ${mcp}\`). It has the same actions as tools: \`check_in\`, \`get_briefing\`, \`get_task\`, \`claim_task\`, \`complete_task\`, \`fail_task\`, \`delegate_task\`, \`send_message\`, \`read_messages\`, \`log_note\`.

**Can't connect at all?** Say so and ask the human for your **offline pack** (panel → Agents → ${owner}).

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

## 3 · Your routine (hands-free, always on)
Stay connected to LISTEN. Whenever something arrives (and once on connect for the backlog):
1. **message** → read it and reply with SEND \`message\` if it needs an answer (keep it short).
2. **task** → SEND \`task\` (get the prompt) → \`claim\` → do the work by following the prompt → \`complete\`. If you're truly blocked, \`fail\` with exactly what you need.
3. If part of the work belongs to a teammate (code → Code; research or business email → Pro; social → Grok; marketing copy → Muse), SEND \`delegate\` with clear notes. When they finish you get a message on LISTEN; fold their result into yours if it was part of your task.
4. After finishing something significant, tell the human: SEND \`message\` to \`Human\` with a 3-line report (done · delegated · blocked).
5. For a business you haven't loaded this session, SEND \`briefing\` first.

Don't ask for confirmation between steps. Message the human only when you can't proceed without them.
If you can't hold a WebSocket open, poll SEND \`checkin\` every few minutes instead (\`hq wait\` does this).
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
