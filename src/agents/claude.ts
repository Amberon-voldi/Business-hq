import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { DispatchError } from "../lib/errors";
import type { AgentCall, AgentOutput } from "./types";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

function effortFrom(env: Env): Effort {
  return (EFFORTS as readonly string[]).includes(env.CLAUDE_EFFORT) ? (env.CLAUDE_EFFORT as Effort) : "medium";
}

export async function callClaude(env: Env, call: AgentCall): Promise<AgentOutput> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new DispatchError("ANTHROPIC_API_KEY is not set. Switch this intern to inbox delivery or add the key.", false);
  }
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  const model = env.CLAUDE_MODEL || "claude-opus-5-5";

  let message: Anthropic.Beta.Messages.BetaMessage;
  try {
    // Streaming avoids HTTP timeouts on long generations; we only need the final message.
    const stream = client.beta.messages.stream({
      model,
      max_tokens: 32_000,
      // On a safety-classifier decline, the API re-runs the request on a recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: effortFrom(env) },
      // The system prompt (persona + HQ context) is stable for 5 min at a time — cache it.
      system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: call.user }],
    });
    message = await stream.finalMessage();
  } catch (err) {
    throw toDispatchError(err);
  }

  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category ?? "unspecified";
    throw new DispatchError(`Claude declined this task (refusal category: ${category}).`, false);
  }

  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  if (!text) throw new DispatchError(`Claude returned no text (stop_reason: ${message.stop_reason}).`, true);

  const warnings: string[] = [];
  if (message.stop_reason === "max_tokens") warnings.push("Output hit the token limit and may be cut off.");

  return {
    text,
    provider: "anthropic",
    model: message.model,
    warnings,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    },
  };
}

function toDispatchError(err: unknown): DispatchError {
  // Most specific first: retry on rate limits, overload, server and network errors only.
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new DispatchError(`Anthropic auth failed: ${err.message}`, false, { cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new DispatchError(`Anthropic rate limit: ${err.message}`, true, { cause: err });
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
    return new DispatchError(`Anthropic rejected the request: ${err.message}`, false, { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new DispatchError(`Could not reach Anthropic: ${err.message}`, true, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const retryable = err.status === undefined || err.status >= 500 || err.status === 408 || err.status === 409;
    return new DispatchError(`Anthropic API error ${err.status ?? ""}: ${err.message}`, retryable, { cause: err });
  }
  return new DispatchError(`Claude call failed: ${err instanceof Error ? err.message : String(err)}`, true, {
    cause: err,
  });
}
