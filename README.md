# AI Interns HQ — Cloudflare Worker

One always-on server that runs an AI team ("AI Interns") across **multiple businesses**, currently **noida.fit** and **SP International** (spinternationalpvtltd.com).

- **Delegate anything:** emails, research, social posts, marketing copy, code and docs. Send work from the panel, Notion, Slack, GitHub or the API.
- **Shared context:** each business has a Notion **HQ doc** (Product Brief, Brand Rules, Tech Stack, Roadmap, AI Interns, Task Board, Log). Every task gets only the sections it needs.
- **No per-token API bill by default:** every intern runs in an app you already use (a Claude Project or Claude Code on your Pro/Max plan, Grok…). business-hq is only the coordination hub: inboxes, shared context, team chat and the Notion write-back. You give each intern **one setup prompt** containing its connector URL, key, endpoints, webhooks, team roster and routine, and it works from there.
- **Interns talk to each other:** they delegate tasks, message teammates or the whole team, and get a message automatically when delegated work is done or blocked.
- **Everything lands in Notion:** task status, the deliverable on the task page, and an audit line in the business's **Log**.
- **Management panel** at `/panel`: overview, delegate, task board, jobs, agents, business directory, HQ context, and a setup checklist with every key, env var, webhook URL and endpoint.

```
 Panel / API / Notion / Slack / GitHub
                 │
                 ▼
     Worker (Hono) ── business directory + config (KV)
                 │
     ┌───────────┴─────────────┐
 delivery: inbox (default)   delivery: api (optional, billed)
 intern's own app via         Queue → Claude/Grok API
 MCP connector / HTTP API     (needs ANTHROPIC_API_KEY / XAI_API_KEY)
     └───────────┬─────────────┘
                 ▼
  brand check → Notion (status · deliverable · Log) → Slack reply
```

---

## Quick start

Prerequisites: Node 20+, a Cloudflare account on the **Workers Paid** plan (Queues need it), and `npx wrangler login`.

```bash
npm install
npx wrangler queues create ai-interns-dispatch-dlq    # dead-letter queue (the rest auto-provisions)

npx wrangler secret put WEBHOOK_SECRET      # openssl rand -hex 32 — also your panel password
npx wrangler secret put NOTION_TOKEN        # Notion internal integration
npx wrangler secret put NOTION_HQ_PAGE_ID   # optional: noida.fit's HQ page (or set it in the panel)
# No ANTHROPIC_API_KEY / XAI_API_KEY needed: interns work in their own apps.

npm run check && npm run deploy             # or push to main if Workers Builds is connected
```

Then open **`https://<worker>/panel`**, sign in with `WEBHOOK_SECRET`, and follow the **Setup** tab. It shows which secrets are set, the exact `wrangler secret put` commands, and copy-ready webhook URLs for each business.

### Secrets

| Secret | Required | Purpose |
|---|---|---|
| `WEBHOOK_SECRET` | ✓ | Panel sign-in, `/dispatch` and `/context` auth, Notion automation header, and the seed for agent tokens |
| `NOTION_TOKEN` | ✓ | Read HQ docs and write status, deliverables and logs |
| `ANTHROPIC_API_KEY` | | Only for `api` delivery. Billed per token by Anthropic, **separately from a Claude subscription** |
| `NOTION_HQ_PAGE_ID` | | noida.fit's HQ page (can be set in Directory instead) |
| `XAI_API_KEY` | | Only for Grok on `api` delivery (billed per token by xAI) |
| `SLACK_SIGNING_SECRET` | | Verifies `/intern` commands and @mentions |
| `SLACK_BOT_TOKEN` | | Threaded replies, and posting after Slack's 30-minute `response_url` window |
| `GITHUB_WEBHOOK_SECRET` | | GitHub webhook signature (falls back to `WEBHOOK_SECRET`) |
| `NOTION_WEBHOOK_VERIFICATION_TOKEN` | | Signed Notion integration webhooks |
| *custom, e.g.* `NOTION_TOKEN_SPI` | | A business whose HQ lives in a **different Notion workspace**. Set its name in Directory |

### Vars (`wrangler.jsonc`)

| Var | Default | |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model for Code / Pro / Muse |
| `CLAUDE_EFFORT` | `medium` | `low` … `max` |
| `GROK_MODEL` | `grok-4` | Check xAI's current list |
| `CONTEXT_CACHE_TTL_SECONDS` | `300` | HQ context cache |
| `LOG_TIMEZONE_OFFSET_MINUTES` | `330` | Log timestamps (IST) |

---

## Businesses (Directory)

The directory is stored in KV and edited in the panel (**Directory** tab). It's seeded with:

| id | Name | Aliases | Notes |
|---|---|---|---|
| `noidafit` *(default)* | noida.fit | `nf`, `noida` | Uses `NOTION_HQ_PAGE_ID`; noida.fit brand notes and never-use terms are pre-filled |
| `spinternational` | SP International | `spi`, `sp` | **Connect its HQ page** and add a description in Directory |

Each business has: name, domain, aliases, a one-line description, a Notion HQ page, an optional Notion token secret (for another workspace), fallback brand notes, and **never-use phrases** that every piece of copy is checked against. A business without an HQ doc still works: interns use the directory description and the result carries a warning.

Use **Test connection** in Directory to confirm the worker can read an HQ doc and see which sections it found.

## Task types

| Kind | Default intern | What the deliverable looks like |
|---|---|---|
| `email` | Pro | Subject + body + sign-off, `[placeholders]` for unknowns. **Draft only, never sent** |
| `research` | Pro | Findings, comparison table, recommendation, open questions. No invented facts |
| `social` | Grok | 3 post options with rationale |
| `copy` | Muse | Polished copy with variants |
| `code` | Code | Working code or a precise plan, with verification steps |
| `doc` | Pro | Structured doc with decisions, owners and next steps |
| `general` | — | No extra format |

Brand Rules are always attached for Grok and Muse, for `email`, `social` and `copy`, and for anything that reads like marketing.

## Interns & delivery

| Intern | Role | API model |
|---|---|---|
| **Code** | Engineering: code, specs, integrations | Claude |
| **Pro** | Ops & strategy: research, business email, PRDs, proposals | Claude |
| **Grok** | Social & trends: X posts, threads, trend scans | Grok (xAI) |
| **Muse** | Creative & brand: marketing copy, campaigns, newsletters | Claude |

**Delivery** is set per intern in the **Agents** tab:
- **Inbox** *(default)*: the intern's own app does the work. No API key, no per-token bill.
- **API** *(optional)*: the worker calls Claude/Grok itself. This is only possible when that provider's key is set, and it's billed per token. Without a key, tasks always go to the inbox.

### Each intern's two endpoints

| | Endpoint | |
|---|---|---|
| **LISTEN** | `wss://<worker>/agent/v1/listen` · `Authorization: Bearer <key>` (or `?key=`) | WebSocket, always on. Pushes `{"type":"task"}` the moment work is assigned and `{"type":"message"}` when someone writes. On every connect: `hello` + the backlog (open tasks, unread messages), so a dropped connection loses nothing. Send `ping` every ~30 s (answered `pong`). |
| **SEND** | `POST https://<worker>/agent/v1/send` · `Authorization: Bearer <key>` | Everything the intern does: `{"action": "checkin" \| "briefing" \| "task" \| "claim" \| "complete" \| "fail" \| "delegate" \| "message" \| "log", …}`. `delegate` and `message` are pushed live to the recipient's LISTEN. |

Live delivery runs on a Durable Object per intern (`AgentHub`, WebSocket hibernation, so idle connections are free). The panel's Agents tab shows **listening** while an intern is connected.

### Onboarding an intern (one prompt)
Agents tab → intern → **Setup prompt** → copy it into the app the intern runs in. The prompt contains:
- identity, role, teammates (plus `Human`), and every business
- **Connector URL (MCP)** `https://<worker>/mcp/<key>`, with instructions for the Claude app (Settings → Connectors → Add custom connector) and Claude Code (`claude mcp add --transport http business-hq <url>`)
- **HTTP API** base URL + `Authorization: Bearer <key>`, with every endpoint and body
- the webhooks and how work arrives (panel, Slack, Notion, GitHub, teammates)
- the routine ("check in" → messages → briefing → get/claim/complete → delegate → report), the team-chat etiquette, and the ground rules (one business per task, brand rules, drafts only, no invented facts)

Keys are derived from `WEBHOOK_SECRET` and scoped to one intern; changing the secret rotates them all.

**Agents with their own computer (always on), e.g. Grok and Muse:** the setup prompt starts with the `hq` CLI (one Python file, no dependencies):

```bash
mkdir -p ~/.local/bin
curl -fsSL https://<worker>/agent/hq -o ~/.local/bin/hq && chmod +x ~/.local/bin/hq
hq setup --url https://<worker> --key <intern key>     # saved to ~/.config/business-hq/config.json (600)
```

| Command | |
|---|---|
| `hq listen [--once] [--exec ./handler] [--json]` | **LISTEN**: stay connected and receive work and messages live (auto-reconnect, keepalive). `--once` exits on the first task/message; `--exec` runs a handler per event with the JSON on stdin |
| `hq send '{"action":"…"}'` | **SEND**: raw action |
| `hq checkin` | New messages (marked read) + open tasks |
| `hq wait [--interval 60] [--timeout N]` | Polling fallback for when WebSockets aren't possible |
| `hq briefing [--business id]` | Shared context |
| `hq task <id>` · `hq claim <id>` | Task with its ready-made prompt · mark in progress |
| `hq complete <id> --summary "…" --file out.md` | Submit (or pipe Markdown on stdin) |
| `hq fail <id> --reason "…"` | Blocked: say what's needed |
| `hq delegate "<task>" --to Code --kind code --business spi --parent <id>` | Hand off to a teammate |
| `hq msg <Code\|Pro\|Grok\|Muse\|Human\|team> "<text>"` · `hq inbox [--history]` | Team chat |
| `hq log "<note>" --business <id>` | Note in the HQ Log |

`hq --json <command>` gives machine-readable output. The always-on loop is: `hq listen --once` → handle it (via SEND / the `hq` shortcuts) → repeat, or run `hq listen --exec ./handle.sh` as a service.

**Other setups:** in Claude Code run `/loop 15m check in`. In a chat app, say "check in" whenever you want it to work.

**Apps that can't call tools:** use the **Offline pack** (context, inbox and messages pasted in). The intern replies with `=== RESULT <id> ===` and `=== MESSAGE <to> ===` blocks; paste them into **Agents → Paste an offline agent's reply**.

### MCP tools
`check_in`, `get_briefing`, `list_tasks`, `get_task`, `claim_task`, `complete_task`, `fail_task`, `delegate_task`, `send_message`, `read_messages`, `log_note`.

---

## Endpoints

### Public / integrations
| Method | Path | Auth | |
|---|---|---|---|
| `GET` | `/health` | — | Health + config check |
| `GET` | `/panel` | sign-in in the browser | Management panel |
| `GET` | `/agent/hq` | — | The `hq` CLI (no secrets inside) |
| `POST` | `/webhook/notion?business=<id>` | `X-Webhook-Secret` or `X-Notion-Signature` | Task → **In progress** triggers its Owner |
| `POST` | `/webhook/github?business=<id>` | `X-Hub-Signature-256` | `ai:<intern>` labels delegate; default-branch pushes are logged |
| `POST` | `/webhook/slack` | `X-Slack-Signature` | `/intern [business] <intern\|type> <task>`, @mentions |

### Admin (Bearer `WEBHOOK_SECRET`)
| Method | Path | |
|---|---|---|
| `POST` | `/dispatch` | `{task, owner?, kind?, business?, context_sections?, notion_task_id?, delivery?, async?}`. `owner` can be omitted when `kind` implies one |
| `GET` | `/context?business=<id>&sections=…&format=markdown&refresh=1` | A business's HQ context |
| `GET` | `/api/meta`, `/api/config` · `PUT /api/config` | Directory + intern delivery |
| `POST` | `/api/businesses/:id/test` | Read the HQ doc fresh and report what was found |
| `GET` | `/api/jobs?business=&owner=&status=` · `/api/jobs/:id` | Job history (7 days) |
| `POST` | `/api/jobs/:id/retry` · `/api/jobs/:id/complete` | Re-run · submit an offline agent's result |
| `GET` | `/api/agents` · `/api/onboarding/:owner?variant=connected\|offline` | Keys, connector URLs, inbox and unread counts · setup prompts |
| `GET` · `POST` | `/api/messages` | Team chat feed · post as Human (or relay as an intern: `{from, to, text}`) |
| `GET` | `/api/setup` | Secrets status, bindings, per-business webhook URLs, endpoint list |

### Agent connector (MCP)
`POST /mcp/<agent key>`: stateless MCP over Streamable HTTP with the tools listed above.

### Agents (Bearer agent token, `/agent/v1`)
`GET /listen` (WebSocket) and `POST /send` are the two endpoints interns need. The REST routes below do the same things individually.

| Method | Path | |
|---|---|---|
| `GET` | `/me` | Identity, businesses, teammates, task kinds |
| `GET` | `/briefing?business=<id>&format=json` | Shared context (Markdown by default) |
| `GET` | `/pending` | Counts of open tasks and unread messages (cheap poll; marks nothing read) |
| `GET` | `/tasks` · `/tasks/:id` | Inbox · one task with a ready-made prompt (system + user) |
| `POST` | `/tasks/:id/claim` · `/complete` · `/fail` | `complete`: `{summary?, output}` · `fail`: `{reason}` |
| `POST` | `/delegate` | `{task, owner?, kind?, business?, notes?, parent_task_id?}`. Hand off to a teammate (max chain depth 3, not to yourself); they get a message |
| `GET` | `/messages?history=1` · `POST /messages` | Unread team messages (marked read) · `{to: Code\|Pro\|Grok\|Muse\|Human\|team, text, business?, task_id?}` |
| `POST` | `/log` | `{business?, message}` adds a note to that business's HQ Log |

### Examples
```bash
# Research for SP International (kind → Pro)
curl -X POST "$URL/dispatch" -H "Authorization: Bearer $WEBHOOK_SECRET" -H "Content-Type: application/json" \
  -d '{"business":"spi","kind":"research","task":"Compare freight forwarders for Mumbai → Dubai, 2 pallets/month"}'

# Email draft for noida.fit, straight to Muse's inbox
curl -X POST "$URL/dispatch" -H "Authorization: Bearer $WEBHOOK_SECRET" -H "Content-Type: application/json" \
  -d '{"business":"noidafit","owner":"Muse","kind":"email","delivery":"inbox","task":"Invite gym owners to list events"}'
```
Slack: `/intern spi email follow up with the distributor about the revised quote` · `/intern muse 3 taglines for the .fit ID launch`

---

## Notion setup (per business)
1. Create the HQ page with these headings: **Product Brief, Brand Rules, Tech Stack, Roadmap, AI Interns, Task Board, Log**. Emoji, suffixes and toggle headings are fine.
2. Under **Task Board**, add an **inline database** with:
   - a title property
   - **Owner** (Select: Code / Pro / Grok / Muse / Human)
   - **Status** (Status or Select: To do / In progress / Done / Blocked)
   - optionally **Type** (Email / Research / Social post / Marketing copy / Code / technical / Doc / plan)

   Other properties and the page body are passed to the intern as details.
3. Share the page with the integration (••• → Connections). If the business is in another workspace, create an integration there, store its token as a secret, and put the secret's name in Directory.
4. Paste the page URL into **Directory → Edit → Notion HQ page**, then click **Test connection**.
5. Add a database automation: **Status is set to In progress → Send webhook** to the business's Notion URL from the Setup tab, with the header `X-Webhook-Secret: <WEBHOOK_SECRET>`.

## Reliability notes
- Webhooks are verified, acknowledged in under a second, and processed through the queue (retries with backoff, dead-letter queue). A failed job sets the task to **Blocked**, logs ❌, and replies in Slack.
- Each job's result and write-back steps are checkpointed in KV, so retries never call the model twice or write duplicates.
- HQ context is cached per business for 5 minutes. If Notion is down, the last good copy (up to 24 h old) is served.
- With `api` delivery (optional), Claude calls stream, cache the system prompt, use adaptive thinking with `CLAUDE_EFFORT`, and enable server-side refusal fallbacks.
- Connector URLs carry the agent key, so request logs redact them (`/mcp/[token]`).
- The panel ships with a strict nonce-based CSP. Agent output is only ever rendered as text.

## Development
```bash
cp .dev.vars.example .dev.vars   # fill in values
npm run dev                      # http://localhost:8787/panel
npm test                         # vitest
npm run check                    # typecheck + tests + bundle
```

```
src/
  index.ts            app, middleware, routing, queue handler
  config/store.ts     business directory + intern delivery (KV)
  routes/             webhooks (notion, github, slack), dispatch, context, jobs, admin, agent API, MCP, panel
  team/messages.ts    team chat between interns and the human
  hub/                AgentHub Durable Object (LISTEN WebSockets) + push helpers
  dispatch/           job types, start (api/inbox), queue consumer, run pipeline, job records
  agents/             registry + task kinds, prompt builder, brand safety, onboarding prompts, Claude/Grok clients
  notion/             HQ fetch + cache, heading parser, Markdown→blocks, write-back
  panel/panel.html    management panel (single file, no build step)
  cli/hq.py           agent CLI served at /agent/hq
  lib/                signatures, agent tokens, errors, logging, Slack, idempotency, time
test/                 vitest unit tests
```
