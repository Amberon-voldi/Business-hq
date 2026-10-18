import type { BlockObjectResponse } from "@notionhq/client";
import type { BlockNode } from "../src/notion/parse";

let n = 0;
const rt = (text: string) => [
  {
    type: "text",
    plain_text: text,
    href: null,
    text: { content: text, link: null },
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
  },
];

function block(type: string, payload: Record<string, unknown>, hasChildren = false): BlockObjectResponse {
  return { object: "block", id: `block-${++n}`, type, [type]: payload, has_children: hasChildren } as unknown as BlockObjectResponse;
}

export const node = (b: BlockObjectResponse, children: BlockNode[] = []): BlockNode => ({ block: b, children });
export const h2 = (text: string, toggleable = false) =>
  block("heading_2", { rich_text: rt(text), is_toggleable: toggleable, color: "default" });
export const h3 = (text: string) => block("heading_3", { rich_text: rt(text), is_toggleable: false, color: "default" });
export const p = (text: string) => block("paragraph", { rich_text: rt(text), color: "default" });
export const li = (text: string) => block("bulleted_list_item", { rich_text: rt(text), color: "default" });
export const childDb = (title: string) => block("child_database", { title });
export function table(rows: string[][], header = true): BlockNode {
  const t = block("table", { table_width: rows[0]?.length ?? 0, has_column_header: header, has_row_header: false }, true);
  return node(
    t,
    rows.map((r) => node(block("table_row", { cells: r.map((c) => rt(c)) }))),
  );
}
