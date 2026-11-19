import type { FolderRecord } from "./folder_route_access.js";

export type StarredProjectPageLoader = (
  pageIds: readonly string[],
) => Promise<readonly string[]> | readonly string[];

/**
 * 폴더 행에 실을 별표 값을 폴더가 가리키는 프로젝트 페이지에서 한 번에 모아 읽는다.
 * 페이지가 없거나 별표가 아니면 false다.
 */
export async function loadStarredProjectPageIds(
  loader: StarredProjectPageLoader | undefined,
  folders: readonly FolderRecord[],
): Promise<ReadonlySet<string>> {
  if (loader === undefined) return new Set();
  const pageIds = [...new Set(folders.flatMap((folder) => {
    const pageId = folder.projectPageId;
    return typeof pageId === "string" && pageId.length > 0 ? [pageId] : [];
  }))];
  if (pageIds.length === 0) return new Set();
  return new Set(await loader(pageIds));
}

export function folderStarred(
  folder: FolderRecord,
  starredPageIds: ReadonlySet<string>,
): boolean {
  const pageId = folder.projectPageId;
  return typeof pageId === "string" && starredPageIds.has(pageId);
}
