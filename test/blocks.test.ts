import { describe, expect, it } from "vitest";
import { formatLogTimestamp } from "../src/lib/time";
import { normalizeNotionId } from "../src/notion/client";
import { markdownToBlocks, richText } from "../src/notion/blocks";
import { formatLogLine } from "../src/notion/writeback";

describe("markdownToBlocks", () => {
  it("converts common Markdown structures", () => {
    const blocks = markdownToBlocks("# Title\n\nPara one\nstill para\n\n- a\n1. b\n> quote\n---\n```ts\nconst x = 1;\n```");
    expect(blocks.map((b) => b.type)).toEqual([
      "heading_1",
      "paragraph",
      "bulleted_list_item",
      "numbered_list_item",
      "quote",
      "divider",
      "code",
    ]);
  });

  it("splits long text into 2000-char rich text items", () => {
    const items = richText("x".repeat(4500));
    expect(items.map((i) => i.text.content.length)).toEqual([2000, 2000, 500]);
  });
});

describe("misc", () => {
  it("normalizes Notion ids and URLs", () => {
    const id = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
    const dashed = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
    expect(normalizeNotionId(id)).toBe(dashed);
    expect(normalizeNotionId(dashed)).toBe(dashed);
    expect(normalizeNotionId(`https://www.notion.so/team/AI-Interns-HQ-${id}?pvs=4`)).toBe(dashed);
    expect(() => normalizeNotionId("nope")).toThrow();
  });

  it("formats IST log timestamps", () => {
    expect(formatLogTimestamp(new Date("2026-10-18T08:32:00Z"), 330)).toBe("2026-10-18 14:02 IST");
    expect(formatLogTimestamp(new Date("2026-10-18T08:32:00Z"), 0)).toBe("2026-10-18 08:32 UTC+00:00");
  });

  it("formats audit log lines", () => {
    expect(
      formatLogLine({ timestamp: "2026-10-18 14:02 IST", agent: "Muse", task: "Launch tweet", outcome: "done", summary: "3 drafts" }),
    ).toBe("2026-10-18 14:02 IST · Muse · Launch tweet · ✅ 3 drafts");
  });

});
