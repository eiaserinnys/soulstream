/**
 * useSortedFolders — 폴더 정렬 훅
 *
 * folderSortMode에 따라 일반 폴더(시스템 폴더 제외) 목록을 정렬하고,
 * 시스템 폴더 목록과 정렬된 ID 배열을 함께 반환한다.
 */

import { useMemo } from "react";
import { useDashboardStore } from "../stores/dashboard-store";
import { SYSTEM_FOLDERS } from "../shared/constants";
import { getRootFolders } from "../board-workspace/board-workspace-helpers";

const SYSTEM_FOLDER_NAMES: Set<string> = new Set(Object.values(SYSTEM_FOLDERS));

/** 이름 정렬 키 — 앞쪽 이모지+공백 제거 후 텍스트 반환 */
function sortKey(name: string): string {
  return name.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, '').trim() || name;
}

export interface SortedFolder {
  id: string;
  name: string;
  sortOrder: number;
  parentFolderId?: string | null;
  createdAt?: string;
}

export interface UseSortedFoldersResult {
  /** 일반 폴더(시스템 폴더 제외)를 folderSortMode 기준으로 정렬한 배열 */
  sortedNormalFolders: SortedFolder[];
  /** sortedNormalFolders의 id 배열 (SortableContext.items 등에 사용) */
  sortedNormalFolderIds: string[];
  /** 시스템 폴더 목록 (정렬은 catalog 순서 유지) */
  systemFolders: SortedFolder[];
}

/**
 * 폴더 목록을 정렬한다.
 * @param folders catalog의 전체 folders 배열
 */
export function useSortedFolders(folders: readonly SortedFolder[]): UseSortedFoldersResult {
  const folderSortMode = useDashboardStore((s) => s.folderSortMode);
  const catalogVersion = useDashboardStore((s) => s.catalogVersion);

  const sortedNormalFolders = useMemo(() => {
    const normal = getRootFolders(folders).filter((f) => !SYSTEM_FOLDER_NAMES.has(f.name));
    switch (folderSortMode) {
      case "name-asc":
        return [...normal].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
      case "name-desc":
        return [...normal].sort((a, b) => sortKey(b.name).localeCompare(sortKey(a.name)));
      case "created-desc":
        return [...normal].sort((a, b) =>
          new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
        );
      case "created-asc":
        return [...normal].sort((a, b) =>
          new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
        );
      case "custom":
      default:
        return [...normal].sort((a, b) => a.sortOrder - b.sortOrder);
    }
    // catalogVersion은 catalog 변경을 감지하기 위한 의존성 (folders 참조가 안정적일 때 사용)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, folderSortMode, catalogVersion]);

  const sortedNormalFolderIds = useMemo(
    () => sortedNormalFolders.map((f) => f.id),
    [sortedNormalFolders],
  );

  const systemFolders = useMemo(
    () => getRootFolders(folders).filter((f) => SYSTEM_FOLDER_NAMES.has(f.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folders, catalogVersion],
  );

  return { sortedNormalFolders, sortedNormalFolderIds, systemFolders };
}
