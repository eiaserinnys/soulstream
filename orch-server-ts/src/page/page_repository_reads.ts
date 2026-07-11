import { Buffer } from "node:buffer";

import type { BacklinkDto, PageLinkKind } from "@soulstream/page-model";

export interface PageReadQuerySql {
  <T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  readonly array: (values: readonly unknown[]) => unknown;
}

interface BacklinkRow extends Record<string, unknown>, BacklinkDto {
  created_at: Date;
}

export interface PageBacklinkPage {
  items: BacklinkDto[];
  next_cursor: string | null;
}

export async function findPageIdByTitle(
  sql: PageReadQuerySql,
  title: string,
): Promise<string | null> {
  const rows = await sql<readonly { id: string }[]>`
    SELECT id FROM pages WHERE title_key = lower(btrim(${title})) LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

export async function findPageIdByDailyDate(
  sql: PageReadQuerySql,
  date: string,
): Promise<string | null> {
  const rows = await sql<readonly { id: string }[]>`
    SELECT id FROM pages WHERE daily_date = ${date}::date LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

export async function getPageBacklinks(
  sql: PageReadQuerySql,
  input: {
    pageId: string;
    kinds: readonly PageLinkKind[];
    cursor?: string;
    limit: number;
  },
): Promise<PageBacklinkPage> {
  const cursor = input.cursor ? decodeBacklinkCursor(input.cursor) : null;
  const cursorDate = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? "";
  const rows = await sql<readonly BacklinkRow[]>`
    SELECT link.id, source.page_id AS source_page_id,
           link.source_block_id, link.link_kind,
           link.target_page_id, link.target_block_id,
           link.source_start, link.source_end, link.created_at
    FROM block_links link
    JOIN blocks source ON source.id = link.source_block_id
    LEFT JOIN blocks target ON target.id = link.target_block_id
    WHERE (link.target_page_id = ${input.pageId} OR target.page_id = ${input.pageId})
      AND link.link_kind = ANY(${sql.array(input.kinds)}::text[])
      AND (
        ${cursorDate}::timestamptz IS NULL
        OR (link.created_at, link.id) > (${cursorDate}::timestamptz, ${cursorId})
      )
    ORDER BY link.created_at ASC, link.id ASC
    LIMIT ${input.limit + 1}
  `;
  const hasMore = rows.length > input.limit;
  const visible = rows.slice(0, input.limit);
  const items = visible.map(({ created_at: _createdAt, ...item }) => item);
  const last = visible.at(-1);
  return {
    items,
    next_cursor: hasMore && last
      ? encodeBacklinkCursor(last.created_at, last.id)
      : null,
  };
}

function encodeBacklinkCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id]), "utf8").toString("base64url");
}

function decodeBacklinkCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed) || parsed.length !== 2 ||
      typeof parsed[0] !== "string" || Number.isNaN(Date.parse(parsed[0])) ||
      typeof parsed[1] !== "string" || parsed[1].length === 0
    ) {
      throw new Error("shape");
    }
    return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    throw new Error("invalid backlink cursor");
  }
}
