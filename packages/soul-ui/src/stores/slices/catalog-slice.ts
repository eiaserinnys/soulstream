/**
 * Catalog Slice
 *
 * 폴더 카탈로그, 선택된 폴더, 정렬 모드 관련 상태와 액션.
 * selectFolder/clearSelectedFolder는 viewMode를 함께 변경하므로 full store 타입 필요.
 */

import type { StateCreator } from "zustand";
import type { DashboardState, DashboardActions } from "../dashboard-store-types";
import {
  moveSessionsInCatalog,
  renameSessionInCatalog,
  addFolderToCatalog,
  updateFolderNameInCatalog,
  updateFolderSettingsInCatalog,
  removeFolderFromCatalog,
  reorderFoldersInCatalog,
  addBoardItemToCatalog,
  setBoardItemsForFolderInCatalog,
  updateBoardItemPositionInCatalog,
  removeBoardItemFromCatalog,
} from "../catalog-actions";

export type CatalogSlice = Pick<
  DashboardState,
  "catalog" | "selectedFolderId" | "catalogVersion" | "folderSortMode"
> &
  Pick<
    DashboardActions,
    | "setCatalog"
    | "selectFolder"
    | "clearSelectedFolder"
    | "moveSessionsToFolder"
    | "renameSession"
    | "addFolder"
    | "setBoardItemsForFolder"
    | "addBoardItem"
    | "updateBoardItemPosition"
    | "removeBoardItem"
    | "updateFolderName"
    | "updateFolderSettings"
    | "removeFolder"
    | "reorderFolders"
    | "setFolderSortMode"
  >;

export const createCatalogSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  CatalogSlice
> = (set, get) => ({
  catalog: null,
  selectedFolderId: null,
  catalogVersion: 0,
  folderSortMode: "custom",

  setCatalog: (catalog) => {
    set((state) => ({ catalog, catalogVersion: state.catalogVersion + 1 }));
  },

  moveSessionsToFolder: (sessionIds, folderId) => {
    if (sessionIds.length === 0) return;
    const { catalog } = get();
    if (!catalog) return;
    set((state) => ({
      catalog: moveSessionsInCatalog(catalog, sessionIds, folderId),
      catalogVersion: state.catalogVersion + 1,
    }));
  },

  renameSession: (sessionId, displayName) => {
    const { catalog } = get();
    if (!catalog || !catalog.sessions[sessionId]) return;
    set((state) => ({
      catalog: renameSessionInCatalog(catalog, sessionId, displayName),
      catalogVersion: state.catalogVersion + 1,
    }));
  },

  addFolder: (folder) => {
    const { catalog } = get();
    if (!catalog) return;
    const updated = addFolderToCatalog(catalog, folder);
    if (updated === catalog) return; // 이미 존재
    set((state) => ({ catalog: updated, catalogVersion: state.catalogVersion + 1 }));
  },

  addBoardItem: (boardItem) => {
    const { catalog } = get();
    if (!catalog) return;
    const updated = addBoardItemToCatalog(catalog, boardItem);
    if (updated === catalog) return;
    set((state) => ({ catalog: updated, catalogVersion: state.catalogVersion + 1 }));
  },

  setBoardItemsForFolder: (folderId, boardItems) => {
    const { catalog } = get();
    if (!catalog) return;
    set((state) => ({
      catalog: setBoardItemsForFolderInCatalog(catalog, folderId, boardItems),
      catalogVersion: state.catalogVersion + 1,
    }));
  },

  updateBoardItemPosition: (boardItemId, x, y) => {
    const { catalog } = get();
    if (!catalog) return;
    set((state) => ({
      catalog: updateBoardItemPositionInCatalog(catalog, boardItemId, x, y),
      catalogVersion: state.catalogVersion + 1,
    }));
  },

  removeBoardItem: (boardItemId) => {
    const { catalog } = get();
    if (!catalog) return;
    set((state) => ({
      catalog: removeBoardItemFromCatalog(catalog, boardItemId),
      catalogVersion: state.catalogVersion + 1,
    }));
  },

  updateFolderName: (folderId, name) => {
    const { catalog } = get();
    if (!catalog) return;
    set((state) => ({
      catalog: updateFolderNameInCatalog(catalog, folderId, name),
      catalogVersion: state.catalogVersion + 1,
    }));
  },

  updateFolderSettings: (folderId, settings) => {
    const { catalog } = get();
    if (!catalog) return;
    set((state) => ({
      catalog: updateFolderSettingsInCatalog(catalog, folderId, settings),
      catalogVersion: state.catalogVersion + 1,
    }));
  },

  removeFolder: (folderId) => {
    const { catalog } = get();
    if (!catalog) return;
    set((state) => ({
      catalog: removeFolderFromCatalog(catalog, folderId),
      catalogVersion: state.catalogVersion + 1,
    }));
  },

  reorderFolders: (items) => {
    const { catalog } = get();
    if (!catalog) return;
    set((state) => ({
      catalog: reorderFoldersInCatalog(catalog, items),
      catalogVersion: state.catalogVersion + 1,
    }));
  },

  setFolderSortMode: (mode) => {
    set({ folderSortMode: mode });
  },

  selectFolder: (folderId) => {
    set({ selectedFolderId: folderId, viewMode: "folder" });
  },

  clearSelectedFolder: () => set({ selectedFolderId: null, viewMode: "feed" }),
});
