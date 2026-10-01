export interface StarredFolderRowLayout {
  pageId: string;
  top: number;
  height: number;
}

export function reconcileStarredFolderLayouts(
  pageIds: readonly string[],
  measuredLayouts: Readonly<Record<string, StarredFolderRowLayout>>,
  listTop: number | null,
  rowGap: number,
): Record<string, StarredFolderRowLayout> {
  const currentLayouts: Record<string, StarredFolderRowLayout> = {};
  let expectedTop = listTop;
  for (const pageId of pageIds) {
    if (expectedTop === null) break;
    const layout = measuredLayouts[pageId];
    if (!layout) {
      expectedTop = null;
      continue;
    }
    if (Math.abs(layout.top - expectedTop) <= 0.5) currentLayouts[pageId] = layout;
    expectedTop += layout.height + rowGap;
  }
  return currentLayouts;
}

export class StaleStarredFolderCursorError extends Error {
  constructor() {
    super('별표 카드 목록이 변경되었습니다. 다시 불러온 뒤 순서를 바꿔 주세요.');
    this.name = 'StaleStarredFolderCursorError';
  }
}

export function getStarredFolderMoveTarget<T extends { page: { id: string } }>(
  folders: readonly T[],
  sourcePageId: string,
  rowLayouts: readonly StarredFolderRowLayout[],
  dropY: number,
): string | null {
  if (!folders.some((folder) => folder.page.id === sourcePageId)) {
    throw new StaleStarredFolderCursorError();
  }
  const layoutById = new Map(rowLayouts.map((layout) => [layout.pageId, layout]));
  for (const folder of folders) {
    if (folder.page.id === sourcePageId) continue;
    const layout = layoutById.get(folder.page.id);
    if (!layout) throw new StaleStarredFolderCursorError();
    if (dropY < layout.top + layout.height / 2) return folder.page.id;
  }
  return null;
}

export function moveStarredFolderBefore<T extends { page: { id: string } }>(
  folders: readonly T[],
  sourcePageId: string,
  beforePageId: string | null,
  allowExternalTarget = false,
): T[] {
  const sourceIndex = folders.findIndex((folder) => folder.page.id === sourcePageId);
  if (sourceIndex < 0) throw new StaleStarredFolderCursorError();
  if (beforePageId === sourcePageId) return [...folders];

  const next = [...folders];
  const [source] = next.splice(sourceIndex, 1);
  const targetIndex = beforePageId === null
    ? next.length
    : next.findIndex((folder) => folder.page.id === beforePageId);
  if (targetIndex < 0 && beforePageId !== null && !allowExternalTarget) {
    throw new StaleStarredFolderCursorError();
  }
  next.splice(targetIndex < 0 ? next.length : targetIndex, 0, source);
  return next;
}

export function resolveStarredFolderBoundaryTarget<T extends { page: { id: string } }>(
  loadedPageIds: readonly string[],
  sourcePageId: string,
  boundaryPage: { items: readonly T[]; nextCursor?: string | null },
): string {
  const nextIds = boundaryPage.items.map((folder) => folder.page.id);
  if (nextIds.length === 0) throw new StaleStarredFolderCursorError();
  const loaded = new Set(loadedPageIds);
  const seen = new Set<string>();
  for (const pageId of nextIds) {
    if (pageId === sourcePageId || loaded.has(pageId) || seen.has(pageId)) {
      throw new StaleStarredFolderCursorError();
    }
    seen.add(pageId);
  }
  return nextIds[0];
}
