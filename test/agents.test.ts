import { describe, expect, it } from "vitest";
import { connectedPrompt, offlinePrompt } from "../src/agents/onboarding";
import { ConfigSchema, defaultConfig, findBusiness } from "../src/config/store";
import type { Env } from "../src/env";
import { agentToken, ownerFromAgentToken } from "../src/lib/agentTokens";
import { parseSlackCommand } from "../src/routes/slack";

const config = defaultConfig({ NOTION_HQ_PAGE_ID: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d" } as unknown as Env);

describe("agent tokens", () => {
  it("round-trips and is scoped per intern", async () => {
    const token = await agentToken("s3cret", "Muse");
    expect(token).toMatch(/^aih_muse_[0-9a-f]{40}$/);
    expect(await ownerFromAgentToken("s3cret", token)).toBe("Muse");
    expect(await ownerFromAgentToken("other-secret", token)).toBeNull();
    expect(await ownerFromAgentToken("s3cret", token.replace("aih_muse_", "aih_code_"))).toBeNull();
    expect(await ownerFromAgentToken("s3cret", "garbage")).toBeNull();
  });
});

describe("config & directory", () => {
  it("seeds noida.fit and SP International, all interns on inbox delivery", () => {
    expect(ConfigSchema.safeParse(config).success).toBe(true);
    expect(Object.values(config.interns).every((i) => i.delivery === "inbox")).toBe(true);
    expect(config.businesses.map((b) => b.id)).toEqual(["noidafit", "spinternational"]);
  });

  it("finds businesses by id, name or domain", () => {
    expect(findBusiness(config, "spinternational")?.id).toBe("spinternational");
    expect(findBusiness(config, "spinternationalpvtltd.com")?.id).toBe("spinternational");
    expect(findBusiness(config, "noida.fit")?.id).toBe("noidafit");
    expect(findBusiness(config, "spi")?.id).toBe("spinternational");
    expect(findBusiness(config, "NF")?.id).toBe("noidafit");
    expect(findBusiness(config, null)?.id).toBe("noidafit");
    expect(findBusiness(config, "nope")).toBeNull();
  });

  it("rejects duplicate ids and aliases", () => {
    const bad = { ...config, businesses: [...config.businesses, config.businesses[0]] };
    expect(ConfigSchema.safeParse(bad).success).toBe(false);
    const clash = { ...config, businesses: config.businesses.map((b) => ({ ...b, aliases: ["x"] })) };
    expect(ConfigSchema.safeParse(clash).success).toBe(false);
  });
});

describe("Slack command parsing", () => {
  it("parses intern, business prefix and task-type shortcuts", () => {
    expect(parseSlackCommand("muse write 3 taglines", config)).toEqual({ business: null, owner: "Muse", kind: "general", task: "write 3 taglines" });
    expect(parseSlackCommand("spinternational email: chase invoice 42", config)).toEqual({
      business: "spinternational",
      owner: "Pro",
      kind: "email",
      task: "chase invoice 42",
    });
    expect(parseSlackCommand("noida.fit Code: fix the build", config)).toMatchObject({ business: "noidafit", owner: "Code" });
    expect(parseSlackCommand("spi research freight rates to Dubai", config)).toMatchObject({ business: "spinternational", owner: "Pro", kind: "research" });
    expect(parseSlackCommand("bob do a thing", config)).toBeNull();
    expect(parseSlackCommand("help", config)).toBeNull();
  });
});

describe("onboarding prompts", () => {
  it("connected prompt carries connector URL, key, endpoints, hooks, routine and rules", () => {
    const p = connectedPrompt({ owner: "Grok", config, origin: "https://hq.example.dev", token: "aih_grok_x" });
    expect(p).toContain('you are "Grok"');
    expect(p).toContain("https://hq.example.dev/mcp/aih_grok_x");
    expect(p).toContain("claude mcp add --transport http business-hq");
    expect(p).toContain("https://hq.example.dev/agent/v1");
    expect(p).toContain("Authorization: Bearer aih_grok_x");
    expect(p).toContain("| `delegate` |");
    expect(p).toContain("send_message");
    expect(p).toContain("/webhook/notion?business=spinternational");
    expect(p).toContain("curl -fsSL https://hq.example.dev/agent/hq -o ~/.local/bin/hq");
    expect(p).toContain("hq setup --url https://hq.example.dev --key aih_grok_x");
    expect(p).toContain("wss://hq.example.dev/agent/v1/listen");
    expect(p).toContain("POST https://hq.example.dev/agent/v1/send");
    expect(p).toContain('"type":"task"');
    expect(p).toContain("hq listen --once");
    expect(p).not.toContain('"api" delivery'); // inbox is the default
    expect(p).toContain("spinternationalpvtltd.com");
    expect(p).toContain("drafts");
    expect(p).toContain('"Fitness ID"');
  });

  it("offline pack inlines context and the RESULT hand-back format", () => {
    const p = offlinePrompt({ owner: "Muse", config, contexts: [{ business: config.businesses[0]!, context: null, error: "x" }], tasks: [] });
    expect(p).toContain("=== RESULT <task id> ===");
    expect(p).toContain("=== MESSAGE <Code|Pro|Grok|Muse|Human|team> ===");
    expect(p).toContain("inbox is empty");
    expect(p).not.toContain("Bearer");
  });
});
