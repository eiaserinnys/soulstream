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
  | "dashboardConfig"
  | "activeTab"
> &
  Pick<
    DashboardActions,
    | "setSessionTypeFilter"
    | "openNewSessionModal"
    | "closeNewSessionModal"
    | "setActiveRightTab"
    | "setActiveBoardDocument"
    | "setDashboardConfig"
    | "setViewMode"
    | "selectFeed"
    | "setFeedScrollOffset"
    | "setActiveTab"
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
  dashboardConfig: null,
  activeTab: "feed",

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

  setDashboardConfig: (dashboardConfig) => set({ dashboardConfig }),

  setViewMode: (mode) => set({ viewMode: mode }),

  selectFeed: () => {
    set({ viewMode: "feed" });
    // URL은 useUrlSync의 effect가 viewMode 변경을 감지하여 자동 반영
  },

  setFeedScrollOffset: (offset) => set({ feedScrollOffset: offset }),

  setActiveTab: (activeTab) => set({ activeTab }),
});
