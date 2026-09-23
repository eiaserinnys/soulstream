export type StarredTaskDropBoundary =
  | { kind: "before"; pageId: string }
  | { kind: "next-page" }
  | { kind: "end" }
  | { kind: "invalid" };

export function resolveStarredTaskDropBoundary(
  orderedPageIds: readonly string[],
  movedPageId: string,
  hasMore: boolean,
): StarredTaskDropBoundary {
  const movedIndex = orderedPageIds.indexOf(movedPageId);
  if (movedIndex < 0) return { kind: "invalid" };
  const nextPageId = orderedPageIds[movedIndex + 1];
  if (nextPageId) return { kind: "before", pageId: nextPageId };
  return hasMore ? { kind: "next-page" } : { kind: "end" };
}

export function resolveStarredTaskBoundaryPageId(
  loadedPageIds: readonly string[],
  cursor: string,
  nextPageIds: readonly string[],
  nextCursor: string | null,
): string | null {
  if (nextPageIds.length === 0 || nextCursor === cursor) return null;
  const seen = new Set(loadedPageIds);
  for (const pageId of nextPageIds) {
    if (!pageId || seen.has(pageId)) return null;
    seen.add(pageId);
  }
  return nextPageIds[0] ?? null;
}

export function isStarredTaskBoundaryCurrent(input: {
  expectedRefreshKey: number;
  currentRefreshKey: number;
  expectedCursor: string | null;
  currentCursor: string | null;
  expectedPageIds: readonly string[];
  currentPageIds: readonly string[];
}): boolean {
  return input.expectedRefreshKey === input.currentRefreshKey
    && input.expectedCursor === input.currentCursor
    && input.expectedPageIds.length === input.currentPageIds.length
    && input.expectedPageIds.every((pageId, index) => pageId === input.currentPageIds[index]);
}

export function disableStarredTaskPaginationAfterRefreshFailure<T extends { nextCursor: string | null }>(
  page: T,
): T {
  return { ...page, nextCursor: null };
}

export async function resolveStarredTaskBeforePageId(input: {
  orderedPageIds: readonly string[];
  movedPageId: string;
  nextCursor: string | null;
  fetchBoundaryPage(cursor: string): Promise<{ pageIds: readonly string[]; nextCursor: string | null }>;
}): Promise<string | null> {
  const boundary = resolveStarredTaskDropBoundary(
    input.orderedPageIds,
    input.movedPageId,
    Boolean(input.nextCursor),
  );
  if (boundary.kind === "invalid") throw new Error("이동할 별표 업무를 찾을 수 없습니다.");
  if (boundary.kind === "before") return boundary.pageId;
  if (boundary.kind === "end") return null;
  if (!input.nextCursor) throw new Error("별표 목록 cursor가 없습니다.");

  const next = await input.fetchBoundaryPage(input.nextCursor);
  const pageId = resolveStarredTaskBoundaryPageId(
    input.orderedPageIds,
    input.nextCursor,
    next.pageIds,
    next.nextCursor,
  );
  if (!pageId) throw new Error("다음 별표 페이지 경계를 확인하지 못했습니다.");
  return pageId;
}

export async function saveStarredTaskOrderAndReload<T>(input: {
  save(): Promise<void>;
  reload(): Promise<T>;
}): Promise<{
  saved: boolean;
  reloaded?: T;
  saveError?: unknown;
  reloadError?: unknown;
}> {
  try {
    await input.save();
  } catch (saveError) {
    try {
      return { saved: false, reloaded: await input.reload(), saveError };
    } catch (reloadError) {
      return { saved: false, saveError, reloadError };
    }
  }
  try {
    return { saved: true, reloaded: await input.reload() };
  } catch (reloadError) {
    return { saved: true, reloadError };
  }
}
