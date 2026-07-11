import { Buffer } from "node:buffer";

import type { BacklinkDto, PageDto, PageLinkKind, PageListDto } from "@soulstream/page-model";

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

interface PageRow extends Record<string, unknown> {
  id: string;
  title: string;
  daily_date: string | null;
  version: number;
  archived: boolean;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface PageBacklinkPage {
  items: BacklinkDto[];
  next_cursor: string | null;
}

export class PageListCursorError extends Error {
  readonly code = "PAGE_LIST_CURSOR_INVALID";
}

export async function listPages(
  sql: PageReadQuerySql,
  input: { starred?: boolean; cursor?: string; limit: number },
): Promise<PageListDto> {
  const cursor = input.cursor ? decodePageCursor(input.cursor) : null;
  const cursorDate = cursor?.updatedAt ?? null;
  const cursorId = cursor?.id ?? "";
  const starred = input.starred ?? null;
  const rows = await sql<readonly PageRow[]>`
    SELECT id, title, daily_date::text AS daily_date, version, archived,
           metadata, created_at, updated_at
    FROM pages
    WHERE archived = FALSE
      AND (
        ${starred}::boolean IS NULL OR
        CASE WHEN jsonb_typeof(metadata->'starred') = 'boolean'
          THEN (metadata->>'starred')::boolean ELSE FALSE END = ${starred}
      )
      AND (
        ${cursorDate}::timestamptz IS NULL
        OR (updated_at, id) < (${cursorDate}::timestamptz, ${cursorId})
      )
    ORDER BY updated_at DESC, id DESC
    LIMIT ${input.limit + 1}
  `;
  const visible = rows.slice(0, input.limit);
  const last = visible.at(-1);
  return {
    items: visible.map(pageDto),
    next_cursor: rows.length > input.limit && last
      ? encodePageCursor(last.updated_at, last.id)
      : null,
  };
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

function pageDto(row: PageRow): PageDto {
  return {
    id: row.id,
    title: row.title,
    daily_date: row.daily_date,
    version: row.version,
    archived: row.archived,
    metadata: row.metadata,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function encodePageCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([updatedAt.toISOString(), id]), "utf8").toString("base64url");
}

function decodePageCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed) || parsed.length !== 2 ||
      typeof parsed[0] !== "string" || Number.isNaN(Date.parse(parsed[0])) ||
      typeof parsed[1] !== "string" || parsed[1].length === 0
    ) throw new Error("shape");
    return { updatedAt: parsed[0], id: parsed[1] };
  } catch {
    throw new PageListCursorError("invalid page cursor");
  }
}
