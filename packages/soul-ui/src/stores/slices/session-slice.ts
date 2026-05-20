/**
 * Session Slice
 *
 * 활성 세션 / 카드·이벤트노드 선택 코어.
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
  | "selectedCardId"
  | "selectedNodeId"
  | "selectedEventNodeData"
> &
  Pick<
    DashboardActions,
    | "setActiveSession"
    | "setActiveSessionSummary"
    | "selectCard"
    | "selectEventNode"
    | "clearTree"
    | "expireInputRequest"
    | "clearActiveSession"
  >;

/**
 * session-slice가 소유하는 활성 세션·선택 상태의 초기값.
 * 슬라이스 초기 state와 세션 리셋(_session-reset)이 같은 정본을 공유한다 (§3 정본 하나).
 *
 * NOTE: `activeSessionSummary`는 세션 리셋 spread에 포함되지 *않는* 의도된 누락이다.
 *       caller가 setActiveSessionSummary로 별도 갱신하기 때문 (기존 동작 보존).
 *       따라서 slice 초기값과 reset 정본을 분리한다 — slice 초기값은 6개 필드,
 *       reset 정본은 5개 필드(activeSessionSummary 제외).
 */
export function getSessionSliceInitialState(): Pick<
  DashboardState,
  | "activeSessionKey"
  | "activeSession"
  | "activeSessionSummary"
  | "selectedCardId"
  | "selectedNodeId"
  | "selectedEventNodeData"
> {
  return {
    activeSessionKey: null as string | null,
    activeSession: null as SessionDetail | null,
    activeSessionSummary: null,
    selectedCardId: null as string | null,
    selectedNodeId: null as string | null,
    selectedEventNodeData: null as DashboardState["selectedEventNodeData"],
  };
}

export const createSessionSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  SessionSlice
> = (set, get) => ({
  ...getSessionSliceInitialState(),

  // --- 활성 세션 ---

  setActiveSession: (key, detail) => {
    // Folder navigation is owned by catalog/ui flows. Session selection must not
    // rewrite selectedFolderId from a possibly stale catalog assignment.
    // 같은 세션이면 아무것도 하지 않음 (resume 등에서 불필요한 리셋 방지).
    // 이 경로에서는 clearFlattenTreeCache를 호출하지 않음 — 같은 세션의 ChatMessage
    // identity reference를 그대로 재사용하여 React.memo 효과 유지.
    if (key !== null && key === get().activeSessionKey) return;

    // 세션 전환 시 ChatMessage identity 캐시를 비워 이전 세션 항목이 누설되지 않도록 한다.
    clearFlattenTreeCache();
    set({
      ...getSessionResetState(),
      activeSessionKey: key,
      activeSession: detail ?? null,
    });
  },

  setActiveSessionSummary: (summary) => set({ activeSessionSummary: summary }),

  // --- 카드 선택 ---

  selectCard: (cardId, nodeId, switchTab = true) => {
    const current = get().activeRightTab;
    const shouldSwitch = switchTab && current === "chat";
    set({
      selectedCardId: cardId,
      selectedNodeId: nodeId ?? null,
      selectedEventNodeData: null,
      ...(shouldSwitch ? { activeRightTab: "detail" as const } : {}),
    });
  },

  // --- 이벤트 노드 선택 ---

  selectEventNode: (data, nodeId, switchTab = true) => {
    const current = get().activeRightTab;
    const shouldSwitch = switchTab && current === "chat";
    set({
      selectedEventNodeData: data,
      selectedCardId: null,
      selectedNodeId: nodeId ?? null,
      ...(shouldSwitch ? { activeRightTab: "detail" as const } : {}),
    });
  },

  // --- 트리 초기화 ---
  // event-processing-slice 소유 필드 + 본 슬라이스의 선택 상태를 함께 리셋한다.
  // 각 슬라이스의 initial-state factory를 spread하여 정본 일원화 (§3).
  // 합성 후 full store에서 cross-slice set 가능 (Zustand 합성 패턴 표준).
  clearTree: () => {
    clearFlattenTreeCache();
    set({
      ...getEventProcessingInitialState(),
      selectedCardId: null,
      selectedNodeId: null,
      selectedEventNodeData: null,
    });
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
    clearFlattenTreeCache();
    set({
      ...getSessionResetState(),
      activeSessionKey: null,
      activeSession: null,
      activeSessionSummary: null,
      selectedFolderId,
    });
  },
});
