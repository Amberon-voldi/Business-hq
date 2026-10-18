const encoder = new TextEncoder();

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** GitHub: `X-Hub-Signature-256: sha256=<hex>` over the raw body. */
export async function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  header: string | null | undefined,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const expected = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
  return timingSafeEqual(expected, header);
}

export const SLACK_MAX_SKEW_SECONDS = 60 * 5;

/** Slack: `X-Slack-Signature: v0=<hex>` over `v0:{timestamp}:{body}`, with replay window. */
export async function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestamp: string | null | undefined,
  header: string | null | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!timestamp || !header?.startsWith("v0=")) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > SLACK_MAX_SKEW_SECONDS) return false;
  const expected = `v0=${await hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`)}`;
  return timingSafeEqual(expected, header);
}

/** Notion API webhooks: `X-Notion-Signature: sha256=<hex>` keyed with the verification token. */
export async function verifyNotionSignature(
  verificationToken: string,
  rawBody: string,
  header: string | null | undefined,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const expected = `sha256=${await hmacSha256Hex(verificationToken, rawBody)}`;
  return timingSafeEqual(expected, header);
}

/** Bearer token or `X-Webhook-Secret` header matching WEBHOOK_SECRET. */
export function verifySharedSecret(secret: string, headers: Headers): boolean {
  const auth = headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const provided = bearer ?? headers.get("x-webhook-secret");
  return !!provided && timingSafeEqual(provided, secret);
}
