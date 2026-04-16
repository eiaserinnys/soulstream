/**
 * UI Slice
 *
 * 대시보드 UI 표시 모드, 모달, 탭 등 화면 표시 관련 상태와 액션.
 * storageMode 변경 시 cross-slice 리셋이 발생하므로 StateCreator는 full store 타입을 사용한다.
 */

import type { StateCreator } from "zustand";
import type { DashboardState, DashboardActions } from "../dashboard-store-types";
import { createProcessingContext } from "../processing-context";

export type UISlice = Pick<
  DashboardState,
  | "storageMode"
  | "viewMode"
  | "feedScrollOffset"
  | "sessionTypeFilter"
  | "isNewSessionModalOpen"
  | "newSessionSource"
  | "serendipityAvailable"
  | "activeRightTab"
  | "dashboardConfig"
  | "activeTab"
> &
  Pick<
    DashboardActions,
    | "setStorageMode"
    | "setSessionTypeFilter"
    | "openNewSessionModal"
    | "closeNewSessionModal"
    | "setSerendipityAvailable"
    | "setActiveRightTab"
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
  storageMode: "sse",
  viewMode: "feed",
  feedScrollOffset: 0,
  sessionTypeFilter: "all",
  isNewSessionModalOpen: false,
  newSessionSource: "folder",
  serendipityAvailable: false,
  activeRightTab: "chat",
  dashboardConfig: null,
  activeTab: "feed",

  setStorageMode: (storageMode) => {
    set({
      storageMode,
      sessionTypeFilter: "all",
      activeSessionKey: null,
      activeSession: null,
      tree: null,
      treeVersion: 0,
      treeChangeInfo: null,
      lastEventId: 0,
      pendingNotifications: [],
      selectedCardId: null,
      selectedNodeId: null,
      selectedEventNodeData: null,
      collapsedNodeIds: new Set<string>(),
      activeRightTab: "chat",
      processingCtx: createProcessingContext(),
    });
  },

  setSessionTypeFilter: (sessionTypeFilter) => set({ sessionTypeFilter }),

  openNewSessionModal: (source = "folder") =>
    set({ isNewSessionModalOpen: true, newSessionSource: source }),
  closeNewSessionModal: () => set({ isNewSessionModalOpen: false }),

  setSerendipityAvailable: (serendipityAvailable) => set({ serendipityAvailable }),

  setActiveRightTab: (activeRightTab) => set({ activeRightTab }),

  setDashboardConfig: (dashboardConfig) => set({ dashboardConfig }),

  setViewMode: (mode) => set({ viewMode: mode }),

  selectFeed: () => {
    set({ viewMode: "feed" });
    // URL은 useUrlSync의 effect가 viewMode 변경을 감지하여 자동 반영
  },

  setFeedScrollOffset: (offset) => set({ feedScrollOffset: offset }),

  setActiveTab: (activeTab) => set({ activeTab }),
});
