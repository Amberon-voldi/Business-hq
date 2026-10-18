import { describe, expect, it } from "vitest";
import { BRAND_BASELINE, isCopyTask, lintBrand } from "../src/agents/brand";
import { buildPrompt, resolveSections, roleFromInternsTable, splitSummary } from "../src/agents/prompt";
import { parseOwner } from "../src/agents/registry";
import type { HqContext } from "../src/notion/types";

const ctx = (over: Partial<HqContext> = {}): HqContext => ({
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
    expect(sections).not.toContain("tech_stack");
  });

  it("respects explicitly requested sections", () => {
    expect(resolveSections("Code", "Add rate limiting to the API", ["tech_stack"]).sections).toEqual(["tech_stack"]);
  });

  it("always adds Brand Rules to copy tasks, even when not requested", () => {
    const r = resolveSections("Code", "Write the landing page headline", ["tech_stack"]);
    expect(r.brandSafety).toBe(true);
    expect(r.sections).toContain("brand_rules");
  });

  it("builds a prompt with only the scoped sections", () => {
    const prompt = buildPrompt({ owner: "Grok", task: "Draft a tweet", context: ctx() });
    expect(prompt.system).toContain("BRIEF");
    expect(prompt.system).toContain("BRAND");
    expect(prompt.system).not.toContain("STACK");
    expect(prompt.system).toContain("Tweets and trend takes");
    expect(prompt.user).toContain("Draft a tweet");
  });

  it("falls back to baseline brand rules when the section is missing", () => {
    const c = ctx();
    delete c.sections.brand_rules;
    const prompt = buildPrompt({ owner: "Muse", task: "Write a tagline", context: c });
    expect(prompt.system).toContain(BRAND_BASELINE.split("\n")[0]);
  });
});

describe("brand safety", () => {
  it("detects copy tasks", () => {
    expect(isCopyTask("Write an Instagram caption", "Code")).toBe(true);
    expect(isCopyTask("Fix the login bug", "Code")).toBe(false);
    expect(isCopyTask("anything", "Muse")).toBe(true);
  });

  it("flags forbidden names and locations", () => {
    expect(lintBrand("Get your Fitness ID today")).toHaveLength(1);
    expect(lintBrand("Join runners across Noida & Greater Noida")).toHaveLength(1);
    expect(lintBrand("Download NoidaFit now")).toHaveLength(1);
    expect(lintBrand("Get your FitID")).toHaveLength(1);
  });

  it("passes correct brand usage", () => {
    expect(lintBrand("Your .fit ID is live on noida.fit — fitness across the NCR.")).toEqual([]);
  });
});

describe("helpers", () => {
  it("parses owners case-insensitively and ignores Human", () => {
    expect(parseOwner("muse")).toBe("Muse");
    expect(parseOwner(" CODE ")).toBe("Code");
    expect(parseOwner("Human")).toBeNull();
    expect(parseOwner(null)).toBeNull();
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
