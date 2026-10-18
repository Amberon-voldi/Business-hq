# AI Interns HQ — Cloudflare Worker

One always-on server that runs an AI team ("AI Interns") across **multiple businesses**, currently **noida.fit** and **SP International** (spinternationalpvtltd.com).

- **Delegate anything:** emails, research, social posts, marketing copy, code and docs. Send work from the panel, Notion, Slack, GitHub or the API.
- **Shared context:** each business has a Notion **HQ doc** (Product Brief, Brand Rules, Tech Stack, Roadmap, AI Interns, Task Board, Log). Every task gets only the sections it needs.
- **Two ways to work:** the server can run an intern itself through the Claude or Grok API, or put the task in the intern's **inbox** for an external agent (Grok in its own app, a Claude project, a custom GPT…). Inbox agents are onboarded with a generated setup prompt and work hands-free through the agent API.
- **Everything lands in Notion:** task status, the deliverable on the task page, and an audit line in the business's **Log**.
- **Management panel** at `/panel`: overview, delegate, task board, jobs, agents, business directory, HQ context, and a setup checklist with every key, env var, webhook URL and endpoint.

```
 Panel / API / Notion / Slack / GitHub
                 │
                 ▼
     Worker (Hono) ── business directory + config (KV)
                 │
     ┌───────────┴─────────────┐
 delivery: api              delivery: inbox
 Queue → Claude/Grok        waits for the external agent
     │                       (GET /agent/v1/tasks → complete)
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
npx wrangler secret put ANTHROPIC_API_KEY   # Claude (Code, Pro, Muse)
npx wrangler secret put NOTION_HQ_PAGE_ID   # optional: noida.fit's HQ page (or set it in the panel)

npm run check && npm run deploy             # or push to main if Workers Builds is connected
```

Then open **`https://<worker>/panel`**, sign in with `WEBHOOK_SECRET`, and follow the **Setup** tab. It shows which secrets are set, the exact `wrangler secret put` commands, and copy-ready webhook URLs for each business.

### Secrets

| Secret | Required | Purpose |
|---|---|---|
| `WEBHOOK_SECRET` | ✓ | Panel sign-in, `/dispatch` and `/context` auth, Notion automation header, and the seed for agent tokens |
| `NOTION_TOKEN` | ✓ | Read HQ docs and write status, deliverables and logs |
| `ANTHROPIC_API_KEY` | ✓ | Runs Code / Pro / Muse when delivery is `api` |
| `NOTION_HQ_PAGE_ID` | | noida.fit's HQ page (can be set in Directory instead) |
| `XAI_API_KEY` | | Runs Grok when its delivery is `api` |
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

**Delivery** is set per intern in the **Agents** tab, and can be overridden per task:
- **API**: the worker runs the task itself through the queue, with retries.
- **Inbox**: the task waits for the external agent, which picks it up through the agent API, or you paste its result into the panel.

### Onboarding an external agent
Agents tab → intern → **Setup prompt** → paste it into the agent (e.g. Grok, a Claude project, a custom GPT with actions). The prompt includes:
- who the intern is, its teammates, and both businesses
- the base URL and the intern's **own token**. Tokens are derived from `WEBHOOK_SECRET`, scoped to that intern, and rotate when the secret does
- every agent endpoint, the hands-free working loop ("check in" → briefing → tasks → claim → complete/delegate → report), and the ground rules (one business per task, brand rules, drafts only, no invented facts)

For agents that **can't make HTTP calls**, use **Offline pack**: the shared context and the current inbox, pasted in. The agent answers with `=== RESULT <id> === … === END ===` blocks, which you paste into **Agents → Paste results**, and they're written to Notion like any other result.

---

## Endpoints

### Public / integrations
| Method | Path | Auth | |
|---|---|---|---|
| `GET` | `/health` | — | Health + config check |
| `GET` | `/panel` | sign-in in the browser | Management panel |
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
| `GET` | `/api/agents` · `/api/onboarding/:owner?variant=connected\|offline` | Tokens, inbox counts · setup prompts |
| `GET` | `/api/setup` | Secrets status, bindings, per-business webhook URLs, endpoint list |

### Agents (Bearer agent token, `/agent/v1`)
| Method | Path | |
|---|---|---|
| `GET` | `/me` | Identity, businesses, teammates, task kinds |
| `GET` | `/briefing?business=<id>&format=json` | Shared context (Markdown by default) |
| `GET` | `/tasks` · `/tasks/:id` | Inbox · one task with a ready-made prompt (system + user) |
| `POST` | `/tasks/:id/claim` · `/complete` · `/fail` | `complete`: `{summary?, output}` · `fail`: `{reason}` |
| `POST` | `/delegate` | `{task, owner?, kind?, business?, notes?, parent_task_id?}`. Hand off to a teammate (max chain depth 3, not to yourself) |
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
- Claude calls stream, cache the system prompt, use adaptive thinking with `CLAUDE_EFFORT`, and enable server-side refusal fallbacks.
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
  routes/             webhooks (notion, github, slack), dispatch, context, jobs, admin, agent API, panel
  dispatch/           job types, start (api/inbox), queue consumer, run pipeline, job records
  agents/             registry + task kinds, prompt builder, brand safety, onboarding prompts, Claude/Grok clients
  notion/             HQ fetch + cache, heading parser, Markdown→blocks, write-back
  panel/panel.html    management panel (single file, no build step)
  lib/                signatures, agent tokens, errors, logging, Slack, idempotency, time
test/                 vitest unit tests
```
