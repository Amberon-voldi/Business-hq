import type { DispatchJob } from "./dispatch/types";

export interface Env {
  // Secrets (wrangler secret put)
  NOTION_TOKEN: string;
  NOTION_HQ_PAGE_ID: string;
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SECRET: string;
  XAI_API_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  NOTION_WEBHOOK_VERIFICATION_TOKEN?: string;

  // Vars (wrangler.jsonc)
  CLAUDE_MODEL: string;
  CLAUDE_EFFORT: string;
  GROK_MODEL: string;
  CONTEXT_CACHE_TTL_SECONDS: string;
  LOG_TIMEZONE_OFFSET_MINUTES: string;

  // Bindings
  HQ_CACHE: KVNamespace;
  DISPATCH_QUEUE: Queue<DispatchJob>;
}

export type AppBindings = { Bindings: Env; Variables: { requestId: string } };

const REQUIRED_SECRETS = ["NOTION_TOKEN", "NOTION_HQ_PAGE_ID", "ANTHROPIC_API_KEY", "WEBHOOK_SECRET"] as const;

export function missingRequiredSecrets(env: Env): string[] {
  return REQUIRED_SECRETS.filter((k) => !env[k]);
}
