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
  | "sessionTypeFilter"
  | "isNewSessionModalOpen"
  | "newSessionSource"
  | "newSessionParentTask"
  | "newSessionDefaults"
  | "activeRightTab"
  | "activeBoardDocumentId"
  | "focusedBoardItem"
  | "dashboardConfig"
  | "activeTab"
  | "leftNavigationMode"
> &
  Pick<
    DashboardActions,
    | "setSessionTypeFilter"
    | "openNewSessionModal"
    | "closeNewSessionModal"
    | "setActiveRightTab"
    | "setActiveBoardDocument"
    | "focusBoardItem"
    | "clearFocusedBoardItem"
    | "setDashboardConfig"
    | "setViewMode"
    | "selectFeed"
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
  sessionTypeFilter: "all",
  isNewSessionModalOpen: false,
  newSessionSource: "folder",
  newSessionParentTask: null,
  newSessionDefaults: null,
  activeRightTab: "chat",
  activeBoardDocumentId: null,
  focusedBoardItem: null,
  dashboardConfig: null,
  activeTab: "feed",
  leftNavigationMode: "folders",

  setSessionTypeFilter: (sessionTypeFilter) => set({ sessionTypeFilter }),

  openNewSessionModal: (source = "folder", parentTask = null, defaults = null) =>
    set({
      isNewSessionModalOpen: true,
      newSessionSource: source,
      newSessionParentTask: parentTask,
      newSessionDefaults: defaults,
    }),
  closeNewSessionModal: () =>
    set({ isNewSessionModalOpen: false, newSessionParentTask: null, newSessionDefaults: null }),

  setActiveRightTab: (activeRightTab) => set({ activeRightTab }),

  setActiveBoardDocument: (activeBoardDocumentId) =>
    set({ activeBoardDocumentId, activeRightTab: "chat" }),

  focusBoardItem: (boardItemId, folderId) =>
    set((state) => ({
      focusedBoardItem: {
        boardItemId,
        folderId,
        requestId: (state.focusedBoardItem?.requestId ?? 0) + 1,
      },
      selectedFolderId: folderId,
      viewMode: "folder",
      leftNavigationMode: "folders",
      activeTab: "folder",
    })),

  clearFocusedBoardItem: (requestId) =>
    set((state) => (
      state.focusedBoardItem?.requestId === requestId
        ? { focusedBoardItem: null }
        : {}
    )),

  setDashboardConfig: (dashboardConfig) => set({ dashboardConfig }),

  setViewMode: (mode) =>
    set((state) => ({
      viewMode: mode,
      leftNavigationMode:
        mode === "feed" ? "feed" : mode === "folder" ? "folders" : state.leftNavigationMode,
    })),

  selectFeed: () => {
    set({ viewMode: "feed", leftNavigationMode: "feed" });
    // URL은 useUrlSync의 effect가 viewMode 변경을 감지하여 자동 반영
  },

  setFeedScrollOffset: (offset) => set({ feedScrollOffset: offset }),

  setActiveTab: (activeTab) => set({ activeTab }),

  setLeftNavigationMode: (leftNavigationMode) => set({ leftNavigationMode }),
});
