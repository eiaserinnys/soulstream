/**
 * Prompt Suggestion Slice
 *
 * SDK가 turn 직후 emit하는 prompt_suggestion을 세션별로 보관한다.
 * 정본은 서버 EventStore — partialize에 포함하지 않으며 새로고침 시 history_sync baseline으로 복원된다.
 * drafts와 동일한 정책: _session-reset에 포함하지 않아 세션 전환 시 보존된다.
 *
 * setPromptSuggestion(sessionId, text):
 *   - text === null이면 해당 세션 entry 제거 (clearPromptSuggestion과 동등)
 *   - 그 외엔 lastPromptSuggestions[sessionId] = text
 * clearPromptSuggestion(sessionId):
 *   - entry가 이미 없으면 set을 건너뛰어 불필요한 리렌더 방지
 */

import type { StateCreator } from "zustand";
import type { DashboardState, DashboardActions } from "../dashboard-store-types";

export function getPromptSuggestionInitialState(): Pick<
  DashboardState,
  "lastPromptSuggestions"
> {
  return { lastPromptSuggestions: {} };
}

export type PromptSuggestionSlice = Pick<DashboardState, "lastPromptSuggestions"> &
  Pick<DashboardActions, "setPromptSuggestion" | "clearPromptSuggestion">;

export const createPromptSuggestionSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  PromptSuggestionSlice
> = (set) => ({
  ...getPromptSuggestionInitialState(),

  setPromptSuggestion: (sessionId, text) =>
    set((state) => {
      if (text === null) {
        if (state.lastPromptSuggestions[sessionId] == null) return state;
        const next = { ...state.lastPromptSuggestions };
        delete next[sessionId];
        return { lastPromptSuggestions: next };
      }
      if (state.lastPromptSuggestions[sessionId] === text) return state;
      return {
        lastPromptSuggestions: { ...state.lastPromptSuggestions, [sessionId]: text },
      };
    }),

  clearPromptSuggestion: (sessionId) =>
    set((state) => {
      if (state.lastPromptSuggestions[sessionId] == null) return state;
      const next = { ...state.lastPromptSuggestions };
      delete next[sessionId];
      return { lastPromptSuggestions: next };
    }),
});
