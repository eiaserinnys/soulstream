/**
 * 카탈로그(폴더/세션 매핑) 상태 변경 헬퍼
 *
 * Zustand store의 catalog 관련 action에서 사용하는 순수 함수.
 * 각 함수는 현재 CatalogState를 받아 새 CatalogState를 반환한다.
 */

import type { CatalogState, CatalogFolder, CatalogFolderReorderItem } from "@shared/types";

export function moveSessionsInCatalog(
  catalog: CatalogState,
  sessionIds: string[],
  folderId: string | null,
): CatalogState {
  const updatedSessions = { ...catalog.sessions };
  for (const id of sessionIds) {
    if (updatedSessions[id]) {
      updatedSessions[id] = { ...updatedSessions[id], folderId };
    }
  }
  return { ...catalog, sessions: updatedSessions };
}

export function renameSessionInCatalog(
  catalog: CatalogState,
  sessionId: string,
  displayName: string | null,
): CatalogState {
  if (!catalog.sessions[sessionId]) return catalog;
  return {
    ...catalog,
    sessions: {
      ...catalog.sessions,
      [sessionId]: { ...catalog.sessions[sessionId], displayName },
    },
  };
}

export function addFolderToCatalog(
  catalog: CatalogState,
  folder: CatalogFolder,
): CatalogState {
  if (catalog.folders.some((f) => f.id === folder.id)) return catalog;
  return { ...catalog, folders: [...catalog.folders, folder] };
}

export function updateFolderNameInCatalog(
  catalog: CatalogState,
  folderId: string,
  name: string,
): CatalogState {
  return {
    ...catalog,
    folders: catalog.folders.map((f) =>
      f.id === folderId ? { ...f, name } : f,
    ),
  };
}

export function updateFolderSettingsInCatalog(
  catalog: CatalogState,
  folderId: string,
  settings: CatalogFolder["settings"],
): CatalogState {
  return {
    ...catalog,
    folders: catalog.folders.map((f) =>
      f.id === folderId ? { ...f, settings } : f,
    ),
  };
}

export function removeFolderFromCatalog(
  catalog: CatalogState,
  folderId: string,
): CatalogState {
  const updatedSessions = { ...catalog.sessions };
  for (const [id, assignment] of Object.entries(updatedSessions)) {
    if (assignment.folderId === folderId) {
      updatedSessions[id] = { ...assignment, folderId: null };
    }
  }
  return {
    ...catalog,
    folders: catalog.folders
      .filter((f) => f.id !== folderId)
      .map((f) => (f.parentFolderId === folderId ? { ...f, parentFolderId: null } : f)),
    sessions: updatedSessions,
  };
}

export function reorderFoldersInCatalog(
  catalog: CatalogState,
  items: CatalogFolderReorderItem[],
): CatalogState {
  const itemById = new Map(items.map((item) => [item.id, item]));
  return {
    ...catalog,
    folders: catalog.folders.map((folder) => {
      const item = itemById.get(folder.id);
      if (!item) return folder;
      return {
        ...folder,
        sortOrder: item.sortOrder,
        ...(Object.prototype.hasOwnProperty.call(item, "parentFolderId")
          ? { parentFolderId: item.parentFolderId }
          : {}),
      };
    }),
  };
}
