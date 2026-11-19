import type { FolderRecord } from "./folder_route_access.js";

export type ProjectPageState = {
  pageId: string;
  starred: boolean;
  version: number | null;
};

export type ProjectPageStateLoader = (
  pageIds: readonly string[],
) => Promise<readonly ProjectPageState[]> | readonly ProjectPageState[];

/**
 * 폴더 행에 실을 프로젝트 페이지 상태(별표와 페이지 version)를 폴더가 가리키는
 * 페이지들에서 한 번에 모아 읽는다. 페이지가 없으면 상태도 없다(별표 false, version null).
 */
export async function loadProjectPageStates(
  loader: ProjectPageStateLoader | undefined,
  folders: readonly FolderRecord[],
): Promise<ReadonlyMap<string, ProjectPageState>> {
  if (loader === undefined) return new Map();
  const pageIds = [...new Set(folders.flatMap((folder) => {
    const pageId = folder.projectPageId;
    return typeof pageId === "string" && pageId.length > 0 ? [pageId] : [];
  }))];
  if (pageIds.length === 0) return new Map();
  return new Map((await loader(pageIds)).map((state) => [state.pageId, state]));
}

export function folderStarred(
  folder: FolderRecord,
  states: ReadonlyMap<string, ProjectPageState>,
): boolean {
  const pageId = folder.projectPageId;
  return typeof pageId === "string" && states.get(pageId)?.starred === true;
}

/** PATCH /api/pages/:pageId/starred의 expected_version으로 쓰는 페이지 version. */
export function folderProjectPageVersion(
  folder: FolderRecord,
  states: ReadonlyMap<string, ProjectPageState>,
): number | null {
  const pageId = folder.projectPageId;
  if (typeof pageId !== "string") return null;
  return states.get(pageId)?.version ?? null;
}
