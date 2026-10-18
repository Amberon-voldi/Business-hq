import { describe, expect, it } from "vitest";
import { isCopyTask, lintBrand } from "../src/agents/brand";
import { buildPrompt, resolveSections, roleFromInternsTable, splitSummary } from "../src/agents/prompt";
import { parseKind, parseOwner } from "../src/agents/registry";
import { type Business, NOIDAFIT_BRAND_NOTES, defaultConfig } from "../src/config/store";
import type { Env } from "../src/env";
import type { HqContext } from "../src/notion/types";

const [noidafit, spi] = defaultConfig({ NOTION_HQ_PAGE_ID: "x" } as unknown as Env).businesses as [Business, Business];

const ctx = (over: Partial<HqContext> = {}): HqContext => ({
  businessId: "noidafit",
  pageId: "p",
  title: "AI Interns — HQ",
  fetchedAt: new Date().toISOString(),
  tasks: [],
  taskDataSourceId: null,
  warnings: [],
  sections: {
    product_brief: { key: "product_brief", title: "Product Brief", markdown: "BRIEF", tables: [], appendTarget: { parentId: "p" } },
    brand_rules: { key: "brand_rules", title: "Brand Rules", markdown: "BRAND", tables: [], appendTarget: { parentId: "p" } },
    tech_stack: { key: "tech_stack", title: "Tech Stack", markdown: "STACK", tables: [], appendTarget: { parentId: "p" } },
    roadmap: { key: "roadmap", title: "Roadmap", markdown: "ROADMAP", tables: [], appendTarget: { parentId: "p" } },
    ai_interns: {
      key: "ai_interns",
      title: "AI Interns",
      markdown: "",
      tables: [{ headers: ["Intern", "Tool", "Handles"], rows: [["Grok", "xAI Grok", "Tweets and trend takes"]] }],
      appendTarget: { parentId: "p" },
    },
  },
  ...over,
});

describe("scoped context", () => {
  it("does not send the tech stack to Grok for a tweet", () => {
    const { sections } = resolveSections("Grok", "Draft a tweet about the Sunday run club");
    expect(sections).toEqual(["product_brief", "brand_rules"]);
  });

  it("respects explicitly requested sections", () => {
    expect(resolveSections("Code", "Add rate limiting to the API", ["tech_stack"]).sections).toEqual(["tech_stack"]);
  });

  it("always adds Brand Rules to copy tasks and email kinds", () => {
    expect(resolveSections("Code", "Write the landing page headline", ["tech_stack"]).sections).toContain("brand_rules");
    expect(resolveSections("Pro", "Follow up with the supplier", ["product_brief"], "email").sections).toContain("brand_rules");
  });

  it("builds a business-specific prompt with only the scoped sections", () => {
    const prompt = buildPrompt({ owner: "Grok", task: "Draft a tweet", business: noidafit, context: ctx() });
    expect(prompt.system).toContain("working for noida.fit");
    expect(prompt.system).toContain("BRIEF");
    expect(prompt.system).toContain("BRAND");
    expect(prompt.system).not.toContain("STACK");
    expect(prompt.system).toContain("Tweets and trend takes");
    expect(prompt.system).toContain('"Fitness ID"');
  });

  it("adds task-kind instructions to the user turn", () => {
    const prompt = buildPrompt({ owner: "Pro", task: "Chase invoice 42", kind: "email", business: spi, context: ctx() });
    expect(prompt.user).toContain("Email draft");
    expect(prompt.user).toContain("never claim it has been sent");
    expect(prompt.system).toContain("SP International (spinternationalpvtltd.com)");
  });

  it("falls back to the business's brand notes when the section is missing", () => {
    const c = ctx();
    delete c.sections.brand_rules;
    const prompt = buildPrompt({ owner: "Muse", task: "Write a tagline", business: noidafit, context: c });
    expect(prompt.system).toContain(NOIDAFIT_BRAND_NOTES.split("\n")[0]);
  });
});

describe("brand safety", () => {
  it("detects copy tasks", () => {
    expect(isCopyTask("Write an Instagram caption", "Code")).toBe(true);
    expect(isCopyTask("Fix the login bug", "Code")).toBe(false);
    expect(isCopyTask("anything", "Muse")).toBe(true);
    expect(isCopyTask("Chase invoice 42", "Pro", "email")).toBe(true);
  });

  it("flags noida.fit's forbidden names and locations", () => {
    expect(lintBrand("Get your Fitness ID today", noidafit)).toHaveLength(1);
    expect(lintBrand("Join runners across Noida & Greater Noida", noidafit)).toHaveLength(1);
    expect(lintBrand("Download NoidaFit now", noidafit)).toHaveLength(1);
    expect(lintBrand("Get your FitID", noidafit)).toHaveLength(1);
  });

  it("passes correct brand usage, and doesn't apply noida.fit rules to other businesses", () => {
    expect(lintBrand("Your .fit ID is live on noida.fit — fitness across the NCR.", noidafit)).toEqual([]);
    expect(lintBrand("Greater Noida warehouse update", spi)).toEqual([]);
    expect(lintBrand("Our Acme Corp deal", { ...spi, forbiddenTerms: ["Acme Corp"] })).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("parses owners and kinds case-insensitively", () => {
    expect(parseOwner("muse")).toBe("Muse");
    expect(parseOwner("Human")).toBeNull();
    expect(parseKind("Email")).toBe("email");
    expect(parseKind("Email draft")).toBe("email");
    expect(parseKind("nope")).toBeNull();
  });

  it("reads roles from the AI Interns table", () => {
    expect(roleFromInternsTable(ctx(), "Grok")).toContain("Tweets and trend takes");
    expect(roleFromInternsTable(ctx(), "Code")).toBeNull();
  });

  it("splits the Summary line from the body", () => {
    expect(splitSummary("Summary: Three taglines.\n\n1. Move more")).toEqual({ summary: "Three taglines.", body: "1. Move more" });
    expect(splitSummary("**Summary:** Done.\nBody")).toEqual({ summary: "Done.", body: "Body" });
    expect(splitSummary("# Heading\nBody").summary).toBe("Heading");
  });
});
