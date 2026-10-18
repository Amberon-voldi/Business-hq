# AI Interns HQ — Cloudflare Worker

The central webhook and dispatch server for the **noida.fit** AI Interns team. It runs on one always-on URL and does four things:

1. **Receives webhooks** from Notion, GitHub and Slack, plus manual triggers.
2. **Reads context** from the Notion doc **"AI Interns — HQ"**: Product Brief, Brand Rules, Tech Stack, Roadmap, AI Interns, Task Board.
3. **Dispatches tasks** to AI agents (Claude for Code/Pro/Muse, Grok for Grok). Each agent gets only the context sections it needs.
4. **Writes results back to Notion**: task status, the deliverable on the task page, and an audit line in the **Log** section.

```
Notion automation ─┐                          ┌─> Claude (Code · Pro · Muse)
GitHub webhook ────┤   Worker (Hono)          │
Slack command ─────┼─> verify ─> enqueue ─> Queue consumer ─┼─> Grok (Grok)
POST /dispatch ────┘        │                   │           │
                            │      HQ context (KV, 5-min TTL) <── Notion API
                            ▼                   ▼
                    202 in < 1s        Notion: status · deliverable · Log
                                       Slack: reply in channel/thread
```

LLM calls can take minutes, but Slack wants a reply within 3 s and Notion and GitHub retry slow webhooks. So every webhook is **verified, enqueued and acknowledged right away**. A **Cloudflare Queue** consumer does the actual work, with up to 15 minutes per job, retries with backoff, and a dead-letter queue.

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/webhook/notion` | `X-Webhook-Secret` header **or** `X-Notion-Signature` | Task moved to **In progress** → dispatch to its Owner |
| `POST` | `/webhook/github` | `X-Hub-Signature-256` | `issues`/`pull_request` labelled `ai:<intern>` → dispatch; pushes to default branch → Log |
| `POST` | `/webhook/slack` | `X-Slack-Signature` | `/intern <intern> <task>` slash command, or `@AI Interns muse …` mentions |
| `POST` | `/dispatch` | `Bearer WEBHOOK_SECRET` | Manual dispatch |
| `GET` | `/context` | `Bearer WEBHOOK_SECRET` | HQ context as JSON (or Markdown) |
| `GET` | `/health` | none | Health/config check (503 if required secrets are missing) |

### `POST /dispatch`

```bash
curl -X POST https://ai-interns-hq.<account>.workers.dev/dispatch \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Write 3 launch tweets for .fit ID",
    "owner": "Muse",
    "context_sections": ["product_brief", "brand_rules"],
    "notion_task_id": "https://www.notion.so/…-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "async": true
  }'
# → 202 {"id":"…","status":"queued","owner":"Muse"}
```

| Field | Required | Notes |
|---|---|---|
| `task` | yes | Up to 20k chars |
| `owner` | yes | `Code` · `Pro` · `Grok` · `Muse` (case-insensitive) |
| `context_sections` | no | Any of `product_brief`, `brand_rules`, `tech_stack`, `roadmap`, `ai_interns`, `task_board`. Defaults per intern (below) |
| `notion_task_id` | no | Task Board row (id or URL). Gets set to In progress → Done/Blocked, and receives the deliverable |
| `async` | no | Default `true`. With `false`, the worker runs inline and returns the full result (can take minutes) |

When there's no `notion_task_id`, the full output is nested under the Log entry in the HQ doc.

### `GET /context`

```bash
curl -H "Authorization: Bearer $WEBHOOK_SECRET" "$URL/context?sections=brand_rules,tech_stack"
curl -H "Authorization: Bearer $WEBHOOK_SECRET" "$URL/context?format=markdown"   # paste into any agent
curl -H "Authorization: Bearer $WEBHOOK_SECRET" "$URL/context?refresh=1"         # bypass cache
```

The response includes `sections` (title, markdown, parsed `tables`), `tasks` (from the Task Board), `fetchedAt`, `warnings` (e.g. a section heading not found), and an `X-Cache: HIT|MISS|STALE|REFRESH` header.

---

## Behaviour

### Context caching
The parsed HQ doc is cached in Workers KV for `CONTEXT_CACHE_TTL_SECONDS` (default 300 s). If Notion is down, the worker serves the **last good copy** (kept up to 24 h) rather than failing. Notion webhooks for the HQ page or any task row clear the cache automatically.

### Scoped context
Each intern gets only what it needs (`src/agents/registry.ts`):

| Intern | Model | Default sections |
|---|---|---|
| **Code** | Claude (`CLAUDE_MODEL`) | Product Brief, Tech Stack, Roadmap |
| **Pro** | Claude | Product Brief, Roadmap, Task Board |
| **Grok** | xAI Grok (`GROK_MODEL`) | Product Brief, Brand Rules |
| **Muse** | Claude | Product Brief, Brand Rules, Roadmap |

If a row in the HQ doc's **AI Interns** table names the intern, that row's description becomes the intern's role in the prompt.

### Brand safety
- **Brand Rules are always attached** to Grok and Muse tasks, and to any task that reads like marketing (tweet, caption, landing page, campaign, email, launch…). This applies even when the caller passes `context_sections` without it.
- If the Brand Rules section can't be read, a built-in baseline is used instead (noida.fit naming, ".fit ID", no specific localities, colours).
- Output from copy tasks is **linted** for known violations ("Fitness ID", "Fit ID" without the dot, "Greater Noida", "NoidaFit"). Hits show up as ⚠️ callouts on the deliverable and in Slack. They're advisory and don't block the task.

### Audit log
Every dispatch, whether it succeeds or fails, appends a line to the HQ doc's **Log** section:

```
2026-10-18 14:02 IST · Muse · Write 3 launch tweets for .fit ID · ✅ Three tweet drafts for the .fit ID launch ↗
```

The worker finds the Log section fresh on each write and inserts at its end, even if other sections come after it. If the doc has no Log heading, one is created. Toggle headings are supported.

### Reliability
- **Idempotent retries**: the LLM result and each write-back step are checkpointed in KV. A retried job never calls the model twice or writes duplicate deliverables.
- **Retry policy**: rate limits, 5xx errors and network errors retry with exponential backoff (30 s → 60 s → 120 s). Bad requests, auth errors and refusals fail fast. A failed job sets the task to **Blocked**, logs ❌ with the reason, and replies in Slack.
- **Duplicate protection**: a task that's already running ignores further "In progress" webhooks. GitHub deliveries and Slack events are de-duplicated by delivery/event id, and Slack retries are dropped.
- **Claude** calls use streaming, prompt caching on the system prompt (persona + HQ context), adaptive thinking with `CLAUDE_EFFORT`, and server-side refusal fallbacks (`fallbacks: "default"`).

---

## Notion setup

### 1. The HQ doc
Create a page titled **AI Interns — HQ** with these headings (H1/H2/H3; emoji and suffixes like "Roadmap (Q4)" are fine; toggle headings work):

- **Product Brief** – what noida.fit is, MVP features, current state
- **Brand Rules** – table recommended (e.g. `Rule | Do | Don't`)
- **Tech Stack** – table
- **Roadmap** – shipped + next
- **AI Interns** – table, e.g. `Intern | Tool | Handles` with rows for Code, Pro, Grok, Muse
- **Task Board** – an **inline database** with:
  - a title property (the task)
  - **Owner** – Select: `Code`, `Pro`, `Grok`, `Muse`, `Human`
  - **Status** – Status or Select: `To do`, `In progress`, `Done`, `Blocked`
  - any other properties (Due, Notes…), plus the task page body, are passed to the intern as extra detail
- **Log** – can start empty

A plain table also works for the Task Board, but then it's read-only: tasks can't be triggered from Notion or have their status updated.

### 2. Integration
1. Go to <https://www.notion.so/profile/integrations> → **New integration** (internal). Copy the secret (`ntn_…`) → `NOTION_TOKEN`.
2. Give it **Read content, Update content, Insert content** capabilities.
3. On the HQ page: **••• → Connections → add your integration**. This also covers the inline Task Board.
4. Copy the page ID (the 32-hex string at the end of the page URL) → `NOTION_HQ_PAGE_ID`. A full URL also works.

### 3. Trigger: task → In progress
**Option A: Database automation (simplest).** On the Task Board database: **⚡ Automations → New** →
*Trigger:* `Status` is set to `In progress` → *Action:* **Send webhook**
- URL: `https://<worker>/webhook/notion`
- Custom header: `X-Webhook-Secret: <WEBHOOK_SECRET>`

**Option B: Integration webhooks (signed).** In the integration settings → **Webhooks** → subscription URL `https://<worker>/webhook/notion`, events `page.properties_updated` (and optionally `page.content_updated` to bust the context cache on HQ edits). Notion sends a verification token. The worker logs it (run `npx wrangler tail` and look for `notion_webhook_verification_token_received`). Paste it into Notion to verify, then:
```bash
npx wrangler secret put NOTION_WEBHOOK_VERIFICATION_TOKEN
```

Either way, the worker re-reads the page and only dispatches when **Status = In progress** and **Owner** is an AI intern on the HQ Task Board.

---

## GitHub setup
Repo → **Settings → Webhooks → Add webhook**
- Payload URL: `https://<worker>/webhook/github`, content type `application/json`
- Secret: `GITHUB_WEBHOOK_SECRET` (or `WEBHOOK_SECRET` if you don't set a separate one)
- Events: **Issues**, **Pull requests**, **Pushes**

Then:
- Label an issue or PR `ai:code` / `ai:pro` / `ai:grok` / `ai:muse` and it's dispatched to that intern. The result goes to the HQ Log.
- Pushes to the default branch are recorded in the Log ("3 commit(s) by …").

## Slack setup
At <https://api.slack.com/apps> → **Create app**
- **Basic Information → Signing Secret** → `SLACK_SIGNING_SECRET`
- **Slash Commands** → `/intern`, Request URL `https://<worker>/webhook/slack`
- *(Optional)* **Event Subscriptions** → Request URL the same, bot event `app_mention`. Add the `chat:write` scope, install, and set **Bot User OAuth Token** → `SLACK_BOT_TOKEN` so the bot can reply in threads.

Usage: `/intern muse write 3 taglines for the .fit ID launch` or `@AI Interns code: outline the check-in API`. You get an ephemeral ack right away and the result posts in the channel when ready.

---

## Deploy

Prerequisites: Node 20+, a Cloudflare account on the **Workers Paid** plan (Queues require it), and `npx wrangler login`.

```bash
npm install

# 1. KV namespace for the context cache: paste the printed id into wrangler.jsonc (HQ_CACHE)
npx wrangler kv namespace create HQ_CACHE

# 2. Queues
npx wrangler queues create ai-interns-dispatch
npx wrangler queues create ai-interns-dispatch-dlq

# 3. Secrets (required)
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_HQ_PAGE_ID
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put WEBHOOK_SECRET          # e.g. `openssl rand -hex 32`

# 4. Secrets (optional; enable the matching features)
npx wrangler secret put XAI_API_KEY             # Grok intern
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put NOTION_WEBHOOK_VERIFICATION_TOKEN

# 5. Ship it
npm run check     # typecheck + tests + bundle
npm run deploy

curl https://ai-interns-hq.<account>.workers.dev/health
```

Watch it live with `npm run tail`. Failed jobs that exhaust retries land in `ai-interns-dispatch-dlq`. They've already been marked Blocked and logged in Notion.

### Configuration (`wrangler.jsonc` → `vars`)

| Var | Default | Notes |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model for Code / Pro / Muse |
| `CLAUDE_EFFORT` | `medium` | `low` · `medium` · `high` · `xhigh` · `max` |
| `GROK_MODEL` | `grok-4` | Check xAI's current model list |
| `CONTEXT_CACHE_TTL_SECONDS` | `300` | HQ context cache freshness |
| `LOG_TIMEZONE_OFFSET_MINUTES` | `330` | Log timestamps (330 = IST) |

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev                      # http://localhost:8787 (local KV + Queue simulators)
npm test
```

## Project layout

```
src/
  index.ts              Hono app, middleware, error handling, queue export
  env.ts                Bindings/secrets types
  routes/               notion · github · slack webhooks, /dispatch, /context, auth
  dispatch/             job types, queue consumer, the run pipeline (generate → write back → notify)
  agents/               intern registry, prompt + scoped context, brand safety, Claude + Grok clients
  notion/               HQ fetch + KV cache, heading parser, Markdown→blocks, write-back
  lib/                  signatures, errors, logging, Slack, idempotency, time
test/                   vitest unit tests (signatures, parsing, scoping, brand lint, blocks)
```
