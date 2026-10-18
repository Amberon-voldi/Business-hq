import type { Provider } from "./registry";

export interface AgentCall {
  system: string;
  user: string;
}

export interface AgentOutput {
  text: string;
  provider: Provider;
  model: string;
  /** Non-fatal issues, e.g. the response hit max_tokens. */
  warnings: string[];
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
}
