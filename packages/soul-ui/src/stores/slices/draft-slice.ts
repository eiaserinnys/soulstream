/**
 * Draft Slice
 *
 * 입력창 임시 저장(drafts)과 세션에 묶인 검색 포커스 이벤트 관리.
 * drafts는 세션 전환 시 초기화하지 않으며, persist middleware에 의해 영속화된다.
 */

import type { StateCreator } from "zustand";
import type { DashboardState, DashboardActions } from "../dashboard-store-types";

export type DraftSlice = Pick<DashboardState,
  "drafts" | "focusEventId" | "focusEventSessionId" | "focusEventTarget" | "focusEventRequestId"
> &
  Pick<DashboardActions, "setDraft" | "clearDraft" | "setFocusEventId">;

export const createDraftSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  DraftSlice
> = (set, get) => ({
  drafts: {},
  focusEventId: null,
  focusEventSessionId: null,
  focusEventTarget: null,
  focusEventRequestId: 0,

  setDraft: (key, text) => {
    // 빈 문자열은 저장하지 않고 삭제 — localStorage 무한 누적 방지
    if (!text) {
      get().clearDraft(key);
      return;
    }
    const { drafts } = get();
    set({ drafts: { ...drafts, [key]: text } });
  },

  clearDraft: (key) => {
    const { drafts } = get();
    const { [key]: _, ...rest } = drafts;
    set({ drafts: rest });
  },

  setFocusEventId: (focusEventId, sessionId, target) => set((state) => ({
    focusEventId,
    focusEventSessionId: focusEventId === null
      ? null
      : sessionId ?? state.activeSessionKey,
    focusEventTarget: focusEventId === null ? null : target ?? "event",
    focusEventRequestId: state.focusEventRequestId + 1,
  })),
});
