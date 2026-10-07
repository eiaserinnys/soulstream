/**
 * Session Slice
 *
 * 활성 세션 코어.
 * 세션 전환·해제 시 cross-slice 상태(트리, UI 탭 등)를 함께 리셋하는 책임은
 * `_session-reset.ts`의 `getSessionResetState()` 헬퍼를 통해 한 set() 호출로 묶어 처리한다.
 *
 * 본 슬라이스가 담당하지 않는 영역:
 *   - SSE 이벤트 처리 / 트리 갱신 → event-processing-slice
 *   - 낙관적 세션 prepend            → optimistic-session-slice
 */

import type { StateCreator } from "zustand";
import type { DashboardState, DashboardActions } from "../dashboard-store-types";
import type { InputRequestNodeDef, SessionDetail } from "@shared/types";
import { clearFlattenTreeCache } from "../../lib/flatten-tree";
import { getSessionResetState } from "./_session-reset";
import { getEventProcessingInitialState } from "./event-processing-slice";

export type SessionSlice = Pick<
  DashboardState,
  | "activeSessionKey"
  | "activeSession"
    | "activeSessionSummary"
    | "persistentSessionDisplaySettings"
> &
  Pick<
    DashboardActions,
    | "setActiveSession"
    | "setActiveSessionSummary"
    | "setPersistentSessionDisplaySettings"
    | "clearTree"
    | "expireInputRequest"
    | "clearActiveSession"
  >;

/**
 * session-slice가 소유하는 활성 세션 상태의 초기값.
 * 슬라이스 초기 state와 세션 리셋(_session-reset)이 같은 정본을 공유한다 (§3 정본 하나).
 *
 * NOTE: `activeSessionSummary`는 세션 리셋 spread에 포함되지 *않는* 의도된 누락이다.
 *       caller가 setActiveSessionSummary로 별도 갱신하기 때문 (기존 동작 보존).
 *       따라서 slice 초기값과 reset 정본을 분리한다.
 */
export function getSessionSliceInitialState(): Pick<
  DashboardState,
  | "activeSessionKey"
  | "activeSession"
  | "activeSessionSummary"
  | "persistentSessionDisplaySettings"
> {
  return {
    activeSessionKey: null as string | null,
    activeSession: null as SessionDetail | null,
    activeSessionSummary: null,
    persistentSessionDisplaySettings: null,
  };
}

export function createSessionSlice(
  clearMessageCache: () => void = clearFlattenTreeCache,
): StateCreator<DashboardState & DashboardActions, [], [], SessionSlice> {
  return (set, get) => ({
  ...getSessionSliceInitialState(),

  // --- 활성 세션 ---

  setActiveSession: (key, detail) => {
    // Folder navigation is owned by catalog/ui flows. Session selection must not
    // rewrite selectedFolderId from a possibly stale catalog assignment.
    // 같은 세션이면 아무것도 하지 않음 (resume 등에서 불필요한 리셋 방지).
    // 이 경로에서는 clearFlattenTreeCache를 호출하지 않음 — 같은 세션의 ChatMessage
    // identity reference를 그대로 재사용하여 React.memo 효과 유지.
    if (key !== null && key === get().activeSessionKey) {
      const { activeBoardDocumentId, activeCustomViewId } = get();
      if (activeBoardDocumentId !== null || activeCustomViewId !== null) {
        set({
          activeBoardDocumentId: null,
          activeCustomViewId: null,
          activeRightTab: "chat",
        });
      }
      return;
    }

    // 세션 전환 시 ChatMessage identity 캐시를 비워 이전 세션 항목이 누설되지 않도록 한다.
    clearMessageCache();
    set({
      ...getSessionResetState(),
      activeSessionKey: key,
      activeSession: detail ?? null,
      activeBoardDocumentId: null,
      activeCustomViewId: null,
    });
  },

  setActiveSessionSummary: (summary) => set({ activeSessionSummary: summary }),
  setPersistentSessionDisplaySettings: (sessionId, settings) => {
    if (get().activeSessionKey !== sessionId) return;
    set({ persistentSessionDisplaySettings: settings ? {
      sessionId,
      showGenerationSeparator: settings.show_generation_separator,
      showJevCandidates: settings.show_jev_candidates,
      showCharacter: settings.show_character,
      animateCharacter: settings.animate_character,
      showTurnUsage: settings.show_turn_usage,
    } : null });
  },

  // --- 트리 초기화 ---
  // event-processing-slice의 초기 상태를 같은 set() 호출로 되돌린다.
  clearTree: () => {
    clearMessageCache();
    const {
      pendingNotifications: _keepBrowserNotices,
      historyResetVersion: _keepHistoryResetVersion,
      ...eventState
    } = getEventProcessingInitialState();
    set({ ...eventState });
  },

  // --- input_request 타임아웃 만료 처리 ---
  // 타임아웃 경과 시 트리 노드의 expired 상태를 갱신
  expireInputRequest: (nodeId) => {
    const ctx = get().processingCtx;
    const node = ctx.nodeMap.get(nodeId);
    if (node && node.type === "input_request") {
      (node as InputRequestNodeDef).expired = true;
      set((state) => ({ treeVersion: state.treeVersion + 1 }));
    }
  },

  clearActiveSession: () => {
    // selectedFolderId를 유지하면서 세션 관련 상태만 초기화
    const { selectedFolderId } = get();
    // 세션 해제 시 ChatMessage identity 캐시도 비운다.
    clearMessageCache();
    set({
      ...getSessionResetState(),
      activeSessionKey: null,
      activeSession: null,
      activeSessionSummary: null,
      activeBoardDocumentId: null,
      activeCustomViewId: null,
      selectedFolderId,
    });
  },
  });
}
