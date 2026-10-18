/// <reference types="node" />
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  timingSafeEqual,
  verifyGitHubSignature,
  verifyNotionSignature,
  verifySharedSecret,
  verifySlackSignature,
} from "../src/lib/crypto";

const hmac = (secret: string, msg: string) => createHmac("sha256", secret).update(msg).digest("hex");
const body = JSON.stringify({ hello: "world" });

describe("GitHub signatures", () => {
  it("accepts a valid X-Hub-Signature-256", async () => {
    expect(await verifyGitHubSignature("s3cret", body, `sha256=${hmac("s3cret", body)}`)).toBe(true);
  });
  it("rejects wrong secret, tampered body, and missing header", async () => {
    expect(await verifyGitHubSignature("other", body, `sha256=${hmac("s3cret", body)}`)).toBe(false);
    expect(await verifyGitHubSignature("s3cret", `${body} `, `sha256=${hmac("s3cret", body)}`)).toBe(false);
    expect(await verifyGitHubSignature("s3cret", body, null)).toBe(false);
    expect(await verifyGitHubSignature("s3cret", body, hmac("s3cret", body))).toBe(false);
  });
});

describe("Slack signatures", () => {
  const now = 1_760_000_000;
  const sign = (ts: number) => `v0=${hmac("slack", `v0:${ts}:${body}`)}`;
  it("accepts a fresh, valid signature", async () => {
    expect(await verifySlackSignature("slack", body, String(now), sign(now), now)).toBe(true);
  });
  it("rejects replays older than 5 minutes", async () => {
    const old = now - 301;
    expect(await verifySlackSignature("slack", body, String(old), sign(old), now)).toBe(false);
  });
  it("rejects bad signatures", async () => {
    expect(await verifySlackSignature("slack", body, String(now), sign(now - 1), now)).toBe(false);
    expect(await verifySlackSignature("slack", body, null, sign(now), now)).toBe(false);
  });
});

describe("Notion signatures", () => {
  it("verifies X-Notion-Signature", async () => {
    expect(await verifyNotionSignature("tok", body, `sha256=${hmac("tok", body)}`)).toBe(true);
    expect(await verifyNotionSignature("tok", body, `sha256=${hmac("nope", body)}`)).toBe(false);
  });
});

describe("shared secret", () => {
  it("accepts Bearer or X-Webhook-Secret", () => {
    expect(verifySharedSecret("abc", new Headers({ authorization: "Bearer abc" }))).toBe(true);
    expect(verifySharedSecret("abc", new Headers({ "x-webhook-secret": "abc" }))).toBe(true);
    expect(verifySharedSecret("abc", new Headers({ authorization: "Bearer abd" }))).toBe(false);
    expect(verifySharedSecret("abc", new Headers())).toBe(false);
  });
  it("timingSafeEqual handles different lengths", () => {
    expect(timingSafeEqual("a", "ab")).toBe(false);
    expect(timingSafeEqual("ab", "ab")).toBe(true);
  });
});
