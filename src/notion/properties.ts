import type { PageObjectResponse } from "@notionhq/client";
import { richTextToPlain } from "./parse";
import type { HqTask } from "./types";

type Property = PageObjectResponse["properties"][string];

export function propertyToText(prop: Property | undefined): string | null {
  if (!prop) return null;
  switch (prop.type) {
    case "title":
      return richTextToPlain(prop.title) || null;
    case "rich_text":
      return richTextToPlain(prop.rich_text) || null;
    case "select":
      return prop.select?.name ?? null;
    case "status":
      return prop.status?.name ?? null;
    case "multi_select":
      return prop.multi_select.map((o) => o.name).join(", ") || null;
    case "people":
      return (
        prop.people
          .map((p) => ("name" in p ? p.name : null))
          .filter(Boolean)
          .join(", ") || null
      );
    default:
      return null;
  }
}

export function findProperty(
  page: PageObjectResponse,
  pattern: RegExp,
  types: Property["type"][],
): { name: string; prop: Property } | null {
  // Prefer an exact-ish name match, then any property of an allowed type whose name matches.
  for (const [name, prop] of Object.entries(page.properties)) {
    if (pattern.test(name) && types.includes(prop.type)) return { name, prop };
  }
  return null;
}

export function titleOf(page: PageObjectResponse): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title") return richTextToPlain(prop.title).trim();
  }
  return "(untitled)";
}

export const OWNER_PROPERTY = /^(owner|agent|intern|assignee)s?$/i;
export const STATUS_PROPERTY = /^status$/i;

export function pageToTask(page: PageObjectResponse): HqTask {
  const owner = findProperty(page, OWNER_PROPERTY, ["select", "status", "multi_select", "rich_text", "people"]);
  const status = findProperty(page, STATUS_PROPERTY, ["status", "select"]);
  return {
    id: page.id,
    title: titleOf(page),
    owner: propertyToText(owner?.prop),
    status: propertyToText(status?.prop),
    url: page.url,
    writable: true,
  };
}

/** Optional free-text properties that enrich the prompt if present on the task row. */
export function taskDetails(page: PageObjectResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, prop] of Object.entries(page.properties)) {
    if (prop.type === "title" || OWNER_PROPERTY.test(name) || STATUS_PROPERTY.test(name)) continue;
    const text = propertyToText(prop);
    if (text) out[name] = text;
  }
  return out;
}
