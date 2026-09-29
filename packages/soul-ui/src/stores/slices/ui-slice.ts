/**
 * UI Slice
 *
 * 대시보드 UI 표시 모드, 모달, 탭 등 화면 표시 관련 상태와 액션.
 */

import type { StateCreator } from "zustand";
import type { DashboardState, DashboardActions } from "../dashboard-store-types";

export type UISlice = Pick<
  DashboardState,
  | "viewMode"
  | "feedScrollOffset"
  | "isNewSessionModalOpen"
  | "newSessionSource"
  | "newSessionDefaults"
  | "activeRightTab"
  | "activeBoardDocumentId"
  | "activeCustomViewId"
  | "activeTab"
  | "leftNavigationMode"
> &
  Pick<
    DashboardActions,
    | "openNewSessionModal"
    | "closeNewSessionModal"
    | "setActiveRightTab"
    | "setActiveBoardDocument"
    | "setActiveCustomView"
    | "openFolderWorkspace"
    | "setViewMode"
    | "setFeedScrollOffset"
    | "setActiveTab"
    | "setLeftNavigationMode"
  >;

export const createUISlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  UISlice
> = (set) => ({
  viewMode: "feed",
  feedScrollOffset: 0,
  isNewSessionModalOpen: false,
  newSessionSource: "folder",
  newSessionDefaults: null,
  activeRightTab: "chat",
  activeBoardDocumentId: null,
  activeCustomViewId: null,
  activeTab: "feed",
  leftNavigationMode: "folders",

  openNewSessionModal: (source = "folder", defaults = null) =>
    set({
      isNewSessionModalOpen: true,
      newSessionSource: source,
      newSessionDefaults: defaults,
    }),
  closeNewSessionModal: () =>
    set({ isNewSessionModalOpen: false, newSessionDefaults: null }),

  setActiveRightTab: (activeRightTab) => set({ activeRightTab }),

  setActiveBoardDocument: (activeBoardDocumentId) =>
    set({ activeBoardDocumentId, activeCustomViewId: null, activeRightTab: "chat" }),

  setActiveCustomView: (activeCustomViewId) =>
    set({ activeCustomViewId, activeBoardDocumentId: null, activeRightTab: "chat" }),

  openFolderWorkspace: (folderId) =>
    set({
      activeBoardContainer: { kind: "folder", id: folderId },
      selectedFolderId: folderId,
      viewMode: "folder",
      leftNavigationMode: "folders",
      activeTab: "folder",
    }),

  setViewMode: (mode) =>
    set((state) => ({
      viewMode: mode,
      leftNavigationMode:
        mode === "feed" ? "feed" : mode === "folder" ? "folders" : state.leftNavigationMode,
    })),

  setFeedScrollOffset: (offset) => set({ feedScrollOffset: offset }),

  setActiveTab: (activeTab) => set({ activeTab }),

  setLeftNavigationMode: (leftNavigationMode) => set({ leftNavigationMode }),
});
