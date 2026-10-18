import { describe, expect, it } from "vitest";
import { matchSection, parseSections, tasksFromTable } from "../src/notion/parse";
import { childDb, h2, h3, li, node, p, table } from "./helpers";

const PAGE = "page-id";

describe("matchSection", () => {
  it("matches headings with emoji, case and suffix noise", () => {
    expect(matchSection("🎨 Brand Rules")).toBe("brand_rules");
    expect(matchSection("TECH STACK")).toBe("tech_stack");
    expect(matchSection("Roadmap (Q4 2026)")).toBe("roadmap");
    expect(matchSection("Task Board — Sprint 3")).toBe("task_board");
    expect(matchSection("🤖 AI Interns")).toBe("ai_interns");
    expect(matchSection("Log")).toBe("log");
    expect(matchSection("Random notes")).toBeNull();
  });
});

describe("parseSections", () => {
  const brand = table([
    ["Rule", "Do", "Don't"],
    ["Product name", ".fit ID", "Fitness ID"],
  ]);
  const tree = [
    p("Intro text before any section is ignored"),
    node(h2("📄 Product Brief")),
    node(p("noida.fit is a city-first fitness discovery platform.")),
    node(h3("MVP")),
    node(li("Event directory")),
    node(h2("Brand Rules")),
    brand,
    node(h2("Task Board")),
    node(childDb("Tasks")),
    node(h2("Log")),
    node(li("2026-10-01 · Muse · tweet · ✅ done")),
  ].map((x) => ("block" in x ? x : node(x)));

  const { sections, taskDatabaseIds } = parseSections(PAGE, tree);

  it("splits content by known headings, keeping sub-headings", () => {
    expect(Object.keys(sections).sort()).toEqual(["brand_rules", "log", "product_brief", "task_board"]);
    expect(sections.product_brief?.markdown).toContain("city-first");
    expect(sections.product_brief?.markdown).toContain("#### MVP");
    expect(sections.product_brief?.markdown).toContain("- Event directory");
    expect(sections.product_brief?.markdown).not.toContain("Intro text");
  });

  it("extracts tables with headers", () => {
    expect(sections.brand_rules?.tables).toEqual([{ headers: ["Rule", "Do", "Don't"], rows: [["Product name", ".fit ID", "Fitness ID"]] }]);
    expect(sections.brand_rules?.markdown).toContain("| Rule | Do | Don't |");
  });

  it("finds inline databases in the Task Board", () => {
    expect(taskDatabaseIds).toHaveLength(1);
  });

  it("sets the append target after the section's last block", () => {
    const last = tree.at(-1)?.block.id;
    expect(sections.log?.appendTarget).toEqual({ parentId: PAGE, afterBlockId: last });
  });

  it("uses toggle headings as the append parent", () => {
    const toggle = node(h2("Log", true), [node(li("entry"))]);
    const parsed = parseSections(PAGE, [toggle]);
    expect(parsed.sections.log?.appendTarget).toEqual({ parentId: toggle.block.id });
    expect(parsed.sections.log?.markdown).toContain("entry");
  });
});

describe("tasksFromTable", () => {
  it("maps Task/Owner/Status columns", () => {
    const tasks = tasksFromTable({
      headers: ["Task", "Owner", "Status"],
      rows: [
        ["Launch tweet", "Grok", "To do"],
        ["", "Code", "Done"],
      ],
    });
    expect(tasks).toEqual([
      { id: "table-row-1", title: "Launch tweet", owner: "Grok", status: "To do", url: null, writable: false },
    ]);
  });
});
