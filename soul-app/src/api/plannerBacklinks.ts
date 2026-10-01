import type { PageBacklink } from './pageEndpoints';

export interface PlannerBacklinkReader {
  getPageBacklinks(
    pageId: string,
    cursor?: string,
  ): Promise<{ items: PageBacklink[]; nextCursor: string | null }>;
}

export async function loadAllPlannerBacklinks(
  api: PlannerBacklinkReader,
  pageId: string,
): Promise<PageBacklink[]> {
  const items: PageBacklink[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.getPageBacklinks(pageId, cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

export function pageMountBlockIds(
  backlinks: readonly PageBacklink[],
  sourcePageId: string,
  targetPageId: string,
): string[] {
  return [...new Set(backlinks.flatMap((item) => (
    item.linkKind === 'mount'
      && item.sourcePageId === sourcePageId
      && item.targetPageId === targetPageId
      ? [item.sourceBlockId]
      : []
  )))];
}
