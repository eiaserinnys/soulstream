import { Buffer } from "node:buffer";

import type {
  BacklinkDto,
  BrowserBacklinkDto,
  BrowserBacklinkPageDto,
  BrowserBlockDto,
  BrowserBlockSearchDto,
  BrowserPageSearchDto,
  PageDto,
  PageLinkKind,
  PageListDto,
} from "@soulstream/page-model";

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

export class PageBrowserBacklinkCursorError extends Error {
  readonly code = "PAGE_BROWSER_BACKLINK_CURSOR_INVALID";
}

interface BrowserBlockRow extends Record<string, unknown> {
  id: string;
  page_id: string;
  page_title: string;
  parent_id: string | null;
  position_key: string;
  block_type: string;
  text_plain: string;
  properties: Record<string, unknown>;
  collapsed: boolean;
}

interface BrowserBacklinkRow extends Record<string, unknown> {
  id: string;
  source_page_id: string;
  source_page_title: string;
  source_block_id: string;
  source_text_plain: string;
  link_kind: PageLinkKind;
  target_page_id: string | null;
  target_block_id: string | null;
  source_start: number;
  source_end: number;
  created_at: Date;
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

export async function searchBrowserPages(
  sql: PageReadQuerySql,
  input: { query: string; limit: number },
): Promise<BrowserPageSearchDto> {
  const prefix = escapeLikeQuery(input.query);
  const rows = await sql<readonly { page_id: string; title: string }[]>`
    SELECT id AS page_id, title
    FROM pages
    WHERE archived = FALSE
      AND title_key LIKE (lower(${prefix}) || '%') ESCAPE '\\'
    ORDER BY title_key ASC, id ASC
    LIMIT ${input.limit}
  `;
  return { items: rows.map((row) => ({ pageId: row.page_id, title: row.title })) };
}

export async function searchBrowserBlocks(
  sql: PageReadQuerySql,
  input: { query: string; limit: number },
): Promise<BrowserBlockSearchDto> {
  const prefix = escapeLikeQuery(input.query);
  const rows = await sql<readonly {
    block_id: string;
    page_id: string;
    page_title: string;
    text_plain: string;
  }[]>`
    SELECT block.id AS block_id, block.page_id,
           page.title AS page_title, block.text_plain
    FROM blocks block
    JOIN pages page ON page.id = block.page_id
    WHERE page.archived = FALSE
      AND lower(block.text_plain) LIKE (lower(${prefix}) || '%') ESCAPE '\\'
    ORDER BY lower(block.text_plain) ASC, block.id ASC
    LIMIT ${input.limit}
  `;
  return {
    items: rows.map((row) => ({
      blockId: row.block_id,
      pageId: row.page_id,
      pageTitle: row.page_title,
      textPreview: preview(row.text_plain),
    })),
  };
}

export async function getBrowserBlock(
  sql: PageReadQuerySql,
  blockId: string,
): Promise<BrowserBlockDto | null> {
  const rows = await sql<readonly BrowserBlockRow[]>`
    SELECT block.id, block.page_id, page.title AS page_title,
           block.parent_id, block.position_key, block.block_type,
           block.text_plain, block.properties, block.collapsed
    FROM blocks block
    JOIN pages page ON page.id = block.page_id
    WHERE block.id = ${blockId}
    LIMIT 1
  `;
  const row = rows[0];
  return row ? browserBlockDto(row) : null;
}

export async function getBrowserBacklinks(
  sql: PageReadQuerySql,
  input: {
    pageId: string;
    kinds: readonly PageLinkKind[];
    cursor?: string;
    limit: number;
  },
): Promise<BrowserBacklinkPageDto> {
  const kinds = canonicalKinds(input.kinds);
  const cursor = input.cursor
    ? decodeBrowserBacklinkCursor(input.cursor, input.pageId, kinds)
    : null;
  const cursorDate = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? "";
  const rows = await sql<readonly BrowserBacklinkRow[]>`
    SELECT link.id, source.page_id AS source_page_id,
           source_page.title AS source_page_title,
           link.source_block_id, source.text_plain AS source_text_plain,
           link.link_kind, link.target_page_id, link.target_block_id,
           link.source_start, link.source_end, link.created_at
    FROM block_links link
    JOIN blocks source ON source.id = link.source_block_id
    JOIN pages source_page ON source_page.id = source.page_id
    LEFT JOIN blocks target ON target.id = link.target_block_id
    WHERE (link.target_page_id = ${input.pageId} OR target.page_id = ${input.pageId})
      AND link.link_kind = ANY(${sql.array(kinds)}::text[])
      AND (
        ${cursorDate}::timestamptz IS NULL
        OR (link.created_at, link.id) > (${cursorDate}::timestamptz, ${cursorId})
      )
    ORDER BY link.created_at ASC, link.id ASC
    LIMIT ${input.limit + 1}
  `;
  const visible = rows.slice(0, input.limit);
  const last = visible.at(-1);
  return {
    items: visible.map(browserBacklinkDto),
    nextCursor: rows.length > input.limit && last
      ? encodeBrowserBacklinkCursor(last.created_at, last.id, input.pageId, kinds)
      : null,
  };
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

function escapeLikeQuery(query: string): string {
  return query.replace(/[\\%_]/g, "\\$&");
}

function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

function browserBlockDto(row: BrowserBlockRow): BrowserBlockDto {
  return {
    id: row.id,
    pageId: row.page_id,
    pageTitle: row.page_title,
    parentId: row.parent_id,
    positionKey: row.position_key,
    blockType: row.block_type,
    text: row.text_plain,
    properties: row.properties,
    collapsed: row.collapsed,
  };
}

function browserBacklinkDto(row: BrowserBacklinkRow): BrowserBacklinkDto {
  return {
    id: row.id,
    sourcePageId: row.source_page_id,
    sourcePageTitle: row.source_page_title,
    sourceBlockId: row.source_block_id,
    sourceTextPreview: preview(row.source_text_plain),
    linkKind: row.link_kind,
    targetPageId: row.target_page_id,
    targetBlockId: row.target_block_id,
    sourceStart: row.source_start,
    sourceEnd: row.source_end,
  };
}

const LINK_KIND_ORDER: readonly PageLinkKind[] = ["mount", "inline_page", "block_ref"];

function canonicalKinds(kinds: readonly PageLinkKind[]): PageLinkKind[] {
  const selected = new Set(kinds);
  return LINK_KIND_ORDER.filter((kind) => selected.has(kind));
}

function encodeBrowserBacklinkCursor(
  createdAt: Date,
  id: string,
  pageId: string,
  kinds: readonly PageLinkKind[],
): string {
  return Buffer.from(JSON.stringify([
    1,
    createdAt.toISOString(),
    id,
    pageId,
    canonicalKinds(kinds).join(","),
  ]), "utf8").toString("base64url");
}

function decodeBrowserBacklinkCursor(
  cursor: string,
  pageId: string,
  kinds: readonly PageLinkKind[],
): { createdAt: string; id: string } {
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (!bytes.length || bytes.toString("base64url") !== cursor) throw new Error("encoding");
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (
      !Array.isArray(parsed) || parsed.length !== 5 || parsed[0] !== 1 ||
      typeof parsed[1] !== "string" || new Date(parsed[1]).toISOString() !== parsed[1] ||
      typeof parsed[2] !== "string" || parsed[2].length === 0 ||
      parsed[3] !== pageId ||
      parsed[4] !== canonicalKinds(kinds).join(",")
    ) throw new Error("shape");
    return { createdAt: parsed[1], id: parsed[2] };
  } catch {
    throw new PageBrowserBacklinkCursorError("invalid browser backlink cursor");
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
