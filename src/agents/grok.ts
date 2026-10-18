import type { Env } from "../env";
import { DispatchError } from "../lib/errors";
import type { AgentCall, AgentOutput } from "./types";

const XAI_URL = "https://api.x.ai/v1/chat/completions";
const TIMEOUT_MS = 5 * 60_000;

interface XaiResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

/** xAI's chat completions API (OpenAI-compatible wire format). */
export async function callGrok(env: Env, call: AgentCall): Promise<AgentOutput> {
  if (!env.XAI_API_KEY) {
    throw new DispatchError("XAI_API_KEY is not configured — cannot dispatch to Grok.", false);
  }
  const model = env.GROK_MODEL || "grok-4";

  let res: Response;
  try {
    res = await fetch(XAI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.XAI_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new DispatchError(`Could not reach xAI: ${err instanceof Error ? err.message : String(err)}`, true, {
      cause: err,
    });
  }

  const raw = await res.text();
  let body: XaiResponse = {};
  try {
    body = JSON.parse(raw) as XaiResponse;
  } catch {
    // Non-JSON error page; handled below.
  }

  if (!res.ok) {
    const detail = typeof body.error === "string" ? body.error : (body.error?.message ?? raw.slice(0, 300));
    const retryable = res.status === 429 || res.status >= 500;
    throw new DispatchError(`xAI API error ${res.status}: ${detail}`, retryable);
  }

  const choice = body.choices?.[0];
  const text = choice?.message?.content?.trim();
  if (!text) throw new DispatchError("Grok returned an empty response.", true);

  const warnings: string[] = [];
  if (choice?.finish_reason === "length") warnings.push("Output hit the token limit and may be cut off.");

  return {
    text,
    provider: "xai",
    model: body.model ?? model,
    warnings,
    usage: { inputTokens: body.usage?.prompt_tokens, outputTokens: body.usage?.completion_tokens },
  };
}
