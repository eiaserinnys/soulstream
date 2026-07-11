import { parseInlineRefs } from "@soulstream/page-model";

import type {
  PageYjsBlockReplica,
  PageYjsReplica,
  PageYjsTextDelta,
} from "./page_yjs_model.js";

export type PageLinkKind = "mount" | "inline_page" | "block_ref";

export interface ProjectedPageLink {
  id: string;
  sourceBlockId: string;
  ordinal: number;
  linkKind: PageLinkKind;
  sourceStart: number;
  sourceEnd: number;
  attributeTargetPageId: string | null;
  targetTitle: string | null;
  targetTitleKey: string | null;
  targetBlockRef: string | null;
}

interface PageLinkProjectionSql {
  <T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  readonly array: (values: readonly unknown[]) => unknown;
}

interface ExistingLinkRow extends Record<string, unknown> {
  source_block_id: string;
  ordinal: number;
  link_kind: PageLinkKind;
  target_page_id: string | null;
  target_title_key: string | null;
}

interface PageTargetRow extends Record<string, unknown> {
  id: string;
  title_key: string;
}

interface BlockTargetRow extends Record<string, unknown> {
  id: string;
}

export function projectPageLinks(replica: PageYjsReplica): ProjectedPageLink[] {
  return replica.blocks.flatMap(projectBlockLinks);
}

export async function reconcilePageLinks(
  sql: PageLinkProjectionSql,
  replica: PageYjsReplica,
): Promise<void> {
  const projected = projectPageLinks(replica);
  const sourceBlockIds = replica.blocks.map((block) => block.id);
  const existingRows = sourceBlockIds.length === 0
    ? []
    : await sql<readonly ExistingLinkRow[]>`
        SELECT source_block_id, ordinal, link_kind, target_page_id, target_title_key
        FROM block_links
        WHERE source_block_id = ANY(${sql.array(sourceBlockIds)}::text[])
      `;
  const existingByKey = new Map(
    existingRows.map((row) => [projectionKey(row.source_block_id, row.ordinal), row]),
  );

  const attributePageIds = unique(projected.flatMap((link) =>
    link.attributeTargetPageId ? [link.attributeTargetPageId] : []));
  const titleKeys = unique(projected.flatMap((link) =>
    link.targetTitleKey !== null ? [link.targetTitleKey] : []));
  const pageRows = attributePageIds.length === 0 && titleKeys.length === 0
    ? []
    : await sql<readonly PageTargetRow[]>`
        SELECT id, title_key
        FROM pages
        WHERE id = ANY(${sql.array(attributePageIds)}::text[])
           OR title_key = ANY(${sql.array(titleKeys)}::text[])
      `;
  const pageIds = new Set(pageRows.map((row) => row.id));
  const pageIdByTitleKey = new Map(pageRows.map((row) => [row.title_key, row.id]));

  const blockRefs = unique(projected.flatMap((link) =>
    link.targetBlockRef !== null ? [link.targetBlockRef] : []));
  const blockRows = blockRefs.length === 0
    ? []
    : await sql<readonly BlockTargetRow[]>`
        SELECT id FROM blocks WHERE id = ANY(${sql.array(blockRefs)}::text[])
      `;
  const blockIds = new Set(blockRows.map((row) => row.id));

  const desiredIds = projected.map((link) => link.id);
  if (sourceBlockIds.length > 0) {
    if (desiredIds.length === 0) {
      await sql`
        DELETE FROM block_links
        WHERE source_block_id = ANY(${sql.array(sourceBlockIds)}::text[])
      `;
    } else {
      await sql`
        DELETE FROM block_links
        WHERE source_block_id = ANY(${sql.array(sourceBlockIds)}::text[])
          AND id <> ALL(${sql.array(desiredIds)}::text[])
      `;
    }
  }

  for (const link of projected) {
    const existing = existingByKey.get(projectionKey(link.sourceBlockId, link.ordinal));
    const targetPageId = resolveTargetPageId(
      link,
      existing,
      pageIds,
      pageIdByTitleKey,
    );
    const targetBlockId = link.targetBlockRef !== null && blockIds.has(link.targetBlockRef)
      ? link.targetBlockRef
      : null;
    await sql`
      INSERT INTO block_links (
        id, source_block_id, link_kind, ordinal, source_start, source_end,
        target_page_id, target_title, target_title_key,
        target_block_id, target_block_ref
      ) VALUES (
        ${link.id}, ${link.sourceBlockId}, ${link.linkKind}, ${link.ordinal},
        ${link.sourceStart}, ${link.sourceEnd}, ${targetPageId},
        ${link.targetTitle}, ${link.targetTitleKey}, ${targetBlockId},
        ${link.targetBlockRef}
      )
      ON CONFLICT (source_block_id, ordinal) DO UPDATE
      SET id = EXCLUDED.id,
          link_kind = EXCLUDED.link_kind,
          source_start = EXCLUDED.source_start,
          source_end = EXCLUDED.source_end,
          target_page_id = EXCLUDED.target_page_id,
          target_title = EXCLUDED.target_title,
          target_title_key = EXCLUDED.target_title_key,
          target_block_id = EXCLUDED.target_block_id,
          target_block_ref = EXCLUDED.target_block_ref
      WHERE (
        block_links.id, block_links.link_kind,
        block_links.source_start, block_links.source_end,
        block_links.target_page_id, block_links.target_title,
        block_links.target_title_key, block_links.target_block_id,
        block_links.target_block_ref
      ) IS DISTINCT FROM (
        EXCLUDED.id, EXCLUDED.link_kind,
        EXCLUDED.source_start, EXCLUDED.source_end,
        EXCLUDED.target_page_id, EXCLUDED.target_title,
        EXCLUDED.target_title_key, EXCLUDED.target_block_id,
        EXCLUDED.target_block_ref
      )
    `;
  }

  await sql`
    UPDATE block_links
    SET target_page_id = ${replica.page.id}
    WHERE target_page_id IS NULL
      AND target_title_key = ${normalizeTitleKey(replica.page.title)}
  `;
}

export async function traverseResolvedMountPages(
  startPageId: string,
  loadTargetPageIds: (pageId: string) => Promise<readonly string[]>,
): Promise<string[]> {
  const visited = new Set<string>();
  const queue = [startPageId];
  const ordered: string[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const pageId = queue[index]!;
    if (visited.has(pageId)) continue;
    visited.add(pageId);
    ordered.push(pageId);
    for (const targetPageId of await loadTargetPageIds(pageId)) {
      if (!visited.has(targetPageId)) queue.push(targetPageId);
    }
  }
  return ordered;
}

function projectBlockLinks(block: PageYjsBlockReplica): ProjectedPageLink[] {
  const trimStart = block.text.length - block.text.trimStart().length;
  const trimmed = block.text.trim();
  const segments = parseInlineRefs(trimmed);
  const mount = block.type === "paragraph" && segments.length === 1 &&
    segments[0]?.kind === "pageRef" && segments[0].range?.start === 0 &&
    segments[0].range.end === trimmed.length;
  const links: ProjectedPageLink[] = [];
  for (const segment of segments) {
    if (segment.kind === "text" || !segment.range) continue;
    const ordinal = links.length;
    const sourceStart = trimStart + segment.range.start;
    const sourceEnd = trimStart + segment.range.end;
    if (segment.kind === "pageRef") {
      links.push({
        id: `block-link:${block.id}:${ordinal}`,
        sourceBlockId: block.id,
        ordinal,
        linkKind: mount ? "mount" : "inline_page",
        sourceStart,
        sourceEnd,
        attributeTargetPageId: pageRefAttributeTarget(
          block.textDelta,
          sourceStart,
          sourceEnd,
        ),
        targetTitle: segment.pageTitle,
        targetTitleKey: normalizeTitleKey(segment.pageTitle),
        targetBlockRef: null,
      });
    } else {
      links.push({
        id: `block-link:${block.id}:${ordinal}`,
        sourceBlockId: block.id,
        ordinal,
        linkKind: "block_ref",
        sourceStart,
        sourceEnd,
        attributeTargetPageId: null,
        targetTitle: null,
        targetTitleKey: null,
        targetBlockRef: segment.blockId,
      });
    }
  }
  return links;
}

function pageRefAttributeTarget(
  delta: readonly PageYjsTextDelta[],
  sourceStart: number,
  sourceEnd: number,
): string | null {
  let offset = 0;
  let coveredUntil = sourceStart;
  let targetId: string | null = null;
  for (const part of delta) {
    const partStart = offset;
    const partEnd = offset + part.insert.length;
    offset = partEnd;
    if (partEnd <= sourceStart || partStart >= sourceEnd) continue;
    if (partStart > coveredUntil) return null;
    const current = parsePageRefAttribute(part.attributes?.ref);
    if (current === null || (targetId !== null && current !== targetId)) return null;
    targetId = current;
    coveredUntil = Math.max(coveredUntil, Math.min(partEnd, sourceEnd));
  }
  return coveredUntil === sourceEnd ? targetId : null;
}

function parsePageRefAttribute(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "page" || typeof record.targetId !== "string") return null;
  const targetId = record.targetId.trim();
  return targetId || null;
}

function resolveTargetPageId(
  link: ProjectedPageLink,
  existing: ExistingLinkRow | undefined,
  pageIds: ReadonlySet<string>,
  pageIdByTitleKey: ReadonlyMap<string, string>,
): string | null {
  if (link.targetTitleKey === null) return null;
  if (link.attributeTargetPageId !== null) {
    return pageIds.has(link.attributeTargetPageId) ? link.attributeTargetPageId : null;
  }
  const byTitle = pageIdByTitleKey.get(link.targetTitleKey);
  if (byTitle) return byTitle;
  if (
    existing?.target_page_id &&
    existing.link_kind !== "block_ref" &&
    existing.target_title_key === link.targetTitleKey
  ) {
    return existing.target_page_id;
  }
  return null;
}

function normalizeTitleKey(title: string): string {
  return title.trim().toLowerCase();
}

function projectionKey(sourceBlockId: string, ordinal: number): string {
  return `${sourceBlockId}\u0000${ordinal}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
