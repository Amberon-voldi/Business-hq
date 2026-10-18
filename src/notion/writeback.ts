import {
  type BlockObjectRequest,
  type BlockObjectResponse,
  type Client,
  collectPaginatedAPI,
  isFullBlock,
  isFullPage,
} from "@notionhq/client";
import { normalizeNotionId } from "./client";
import { MAX_BLOCKS_PER_APPEND, chunk, clip, markdownToBlocks, richText } from "./blocks";
import { matchSection, richTextToPlain } from "./parse";
import { STATUS_PROPERTY, findProperty } from "./properties";
import type { TaskStatus } from "./types";

/** Sets the task row's Status, whether the property is a `status` or `select` type. */
export async function updateTaskStatus(notion: Client, pageId: string, status: TaskStatus): Promise<void> {
  const page = await notion.pages.retrieve({ page_id: pageId });
  if (!isFullPage(page)) throw new Error(`Task page ${pageId} is not accessible to the integration`);
  const found = findProperty(page, STATUS_PROPERTY, ["status", "select"]);
  if (!found) throw new Error(`Task page ${pageId} has no Status property`);
  const value = found.prop.type === "status" ? { status: { name: status } } : { select: { name: status } };
  await notion.pages.update({ page_id: pageId, properties: { [found.name]: value } });
}

/** Appends blocks under `parentId`, chunked to Notion's 100-blocks-per-request limit. */
export async function appendBlocks(
  notion: Client,
  parentId: string,
  blocks: BlockObjectRequest[],
  afterBlockId?: string,
): Promise<void> {
  let after = afterBlockId;
  for (const batch of chunk(blocks, MAX_BLOCKS_PER_APPEND)) {
    const res = await notion.blocks.children.append({
      block_id: parentId,
      children: batch,
      ...(after ? { position: { type: "after_block" as const, after_block: { id: after } } } : {}),
    });
    // Keep later batches in order when inserting mid-page.
    if (after) after = res.results.at(-1)?.id ?? after;
  }
}

export interface DeliverableInput {
  agent: string;
  timestamp: string;
  markdown: string;
  warnings: string[];
}

/** Writes the agent's output into the task page body. */
export async function appendDeliverable(notion: Client, pageId: string, d: DeliverableInput): Promise<void> {
  const blocks: BlockObjectRequest[] = [
    { type: "divider", divider: {} },
    { type: "heading_3", heading_3: { rich_text: richText(`Deliverable · ${d.agent} · ${d.timestamp}`) } },
  ];
  for (const w of d.warnings) {
    blocks.push({
      type: "callout",
      callout: { rich_text: richText(w), icon: { type: "emoji", emoji: "⚠️" }, color: "yellow_background" },
    });
  }
  blocks.push(...markdownToBlocks(d.markdown));
  await appendBlocks(notion, pageId, blocks);
}

export interface LogEntryInput {
  timestamp: string;
  agent: string;
  task: string;
  outcome: "done" | "failed" | "event";
  summary: string;
  taskUrl?: string | null;
  /** Full output to nest under the log line when there is no task page to hold it. */
  detailMarkdown?: string;
}

const OUTCOME_ICON: Record<LogEntryInput["outcome"], string> = { done: "✅", failed: "❌", event: "•" };

export function formatLogLine(entry: LogEntryInput): string {
  return `${entry.timestamp} · ${entry.agent} · ${clip(entry.task, 140)} · ${OUTCOME_ICON[entry.outcome]} ${clip(entry.summary, 400)}`;
}

/**
 * Appends a line to the HQ doc's "Log" section. The section is located fresh (not
 * from the 5-min cache) so entries land in order at the end of the section. Creates
 * a "Log" heading at the end of the page if none exists.
 */
export async function appendLogEntry(notion: Client, hqPageId: string, entry: LogEntryInput): Promise<void> {
  const pageId = normalizeNotionId(hqPageId);
  const target = await locateLogSection(notion, pageId);

  const rt = richText(formatLogLine(entry));
  if (entry.taskUrl) rt.push(...richText(" ↗", entry.taskUrl));

  // One level of nested children is allowed per append request; stay under 100 blocks.
  const children = entry.detailMarkdown
    ? [
        {
          type: "toggle",
          toggle: { rich_text: richText("Output"), children: markdownToBlocks(entry.detailMarkdown).slice(0, 95) },
        },
      ]
    : undefined;

  const block = {
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: rt, ...(children ? { children } : {}) },
  } as BlockObjectRequest;

  await appendBlocks(notion, target.parentId, [block], target.afterBlockId);
}

function headingOf(b: BlockObjectResponse): { text: string; toggleable: boolean } | null {
  if (b.type === "heading_1") return { text: richTextToPlain(b.heading_1.rich_text), toggleable: b.heading_1.is_toggleable };
  if (b.type === "heading_2") return { text: richTextToPlain(b.heading_2.rich_text), toggleable: b.heading_2.is_toggleable };
  if (b.type === "heading_3") return { text: richTextToPlain(b.heading_3.rich_text), toggleable: b.heading_3.is_toggleable };
  return null;
}

async function locateLogSection(notion: Client, pageId: string): Promise<{ parentId: string; afterBlockId?: string }> {
  const top = (await collectPaginatedAPI(notion.blocks.children.list, { block_id: pageId, page_size: 100 })).filter(
    isFullBlock,
  );

  let inLog = false;
  for (let i = 0; i < top.length; i++) {
    const b = top[i];
    const h = b ? headingOf(b) : null;
    if (!b || !h) continue;
    const key = matchSection(h.text);
    if (inLog && key) {
      // The next section starts here: insert after the Log section's last block.
      const prev = top[i - 1];
      return prev ? { parentId: pageId, afterBlockId: prev.id } : { parentId: pageId };
    }
    if (key === "log") {
      if (h.toggleable) return { parentId: b.id };
      inLog = true;
    }
  }
  if (inLog) return { parentId: pageId }; // Log is the last section: append at page end.

  await notion.blocks.children.append({
    block_id: pageId,
    children: [{ type: "heading_2", heading_2: { rich_text: richText("Log") } }],
  });
  return { parentId: pageId };
}
