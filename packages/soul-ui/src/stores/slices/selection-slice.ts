/**
 * Selection Slice
 *
 * 세션 다중 선택과 인라인 편집 상태/액션.
 * toggleSessionSelection은 setActiveSession을 호출하므로 full store 타입 필요.
 */

import type { StateCreator } from "zustand";
import type { DashboardState, DashboardActions } from "../dashboard-store-types";

export type SelectionSlice = Pick<
  DashboardState,
  "selectedSessionIds" | "lastSelectedSessionId" | "editingSessionId"
> &
  Pick<
    DashboardActions,
    "toggleSessionSelection" | "clearSelection" | "setEditingSession"
  >;

export const createSelectionSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  SelectionSlice
> = (set, get) => ({
  selectedSessionIds: new Set<string>(),
  lastSelectedSessionId: null,
  editingSessionId: null,

  toggleSessionSelection: (id, ctrlKey, shiftKey, folderSessions) => {
    const state = get();
    if (!ctrlKey && !shiftKey) {
      // 일반 클릭: 선택 초기화 + activeSession 설정
      set({
        selectedSessionIds: new Set([id]),
        lastSelectedSessionId: id,
      });
      state.setActiveSession(id);
      return;
    }
    if (ctrlKey) {
      const next = new Set(state.selectedSessionIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      set({ selectedSessionIds: next, lastSelectedSessionId: id });
      return;
    }
    if (shiftKey && state.lastSelectedSessionId) {
      const folder = folderSessions ?? [];
      const lastIdx = folder.findIndex(
        (s) => s.agentSessionId === state.lastSelectedSessionId,
      );
      const curIdx = folder.findIndex((s) => s.agentSessionId === id);
      if (lastIdx >= 0 && curIdx >= 0) {
        const [from, to] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
        const next = new Set(state.selectedSessionIds);
        for (let i = from; i <= to; i++) next.add(folder[i].agentSessionId);
        set({ selectedSessionIds: next });
      }
    }
  },

  clearSelection: () => set({ selectedSessionIds: new Set() }),

  setEditingSession: (id) => set({ editingSessionId: id }),
});
