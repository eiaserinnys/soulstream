/**
 * Event Processing Slice
 *
 * SSE 이벤트 트리에 대한 처리 책임을 모은 슬라이스.
 * - 트리 상태(tree, treeVersion, totalSubtreeHeight 등)와 이벤트 처리 컨텍스트(processingCtx) 소유.
 * - processEvent / processEvents / processHistoryEvents / setTotalSubtreeHeight 액션을 제공.
 *
 * 핵심 invariants:
 * - tree, treeVersion, chatPrependedCount, chatLastPrependAtMs는 한 set({}) 호출 안에 묶여야
 *   Zustand subscribe가 1회만 발화하여 React 한 렌더 사이클에서 정합 (atom 816060d2).
 * - processHistoryEvents의 chatLastPrependAtMs 갱신은 result.updated 분기 *밖*에 둔다 —
 *   dedup-only / subtree-only 같은 updated=false 코너 케이스에서도 settle 가드가
 *   stale로 남지 않도록 한다 (atom c3047ee9).
 * - chatPrependedCount는 grouped 차분(messages 차분 아님)으로 갱신해야 Virtuoso
 *   firstItemIndex 변화량과 data 추가량이 정합 (atom 3eb91fad).
 */

import type { StateCreator } from "zustand";
import type { SoulSSEEvent, EventTreeNode } from "@shared/types";
import type { DashboardState, DashboardActions } from "../dashboard-store-types";
import {
  type TreeChangeInfo,
  type ProcessingContext,
  createProcessingContext,
} from "../processing-context";
import {
  processEventSingle,
  processEventsBatch,
  type SubtreeHeightUpdate,
} from "../event-processor";
import { flattenTree } from "../../lib/flatten-tree";
import { groupMessages } from "../../lib/grouping";
import { diag } from "../../lib/diag";

/**
 * event-processing-slice가 소유하는 필드들의 초기값을 매번 새 인스턴스로 생성한다.
 * 슬라이스의 초기 state와 세션 전환 시 리셋(`_session-reset.getSessionResetState`) 양쪽에서
 * 같은 정본을 사용하도록 factory로 분리한다 (design-principles §3 정본 하나).
 *
 * 매 호출마다 새 객체/Set/processingCtx를 반환하므로 인스턴스 공유로 인한
 * mutation cross-talk이 발생하지 않는다.
 */
export function getEventProcessingInitialState(): Pick<
  DashboardState,
  | "tree"
  | "treeVersion"
  | "chatPrependedCount"
  | "chatLastPrependAtMs"
  | "treeChangeInfo"
  | "lastEventId"
  | "totalSubtreeHeight"
  | "pendingNotifications"
  | "processingCtx"
> {
  return {
    tree: null as EventTreeNode | null,
    treeVersion: 0,
    chatPrependedCount: 0,
    chatLastPrependAtMs: null as number | null,
    treeChangeInfo: null as TreeChangeInfo | null,
    lastEventId: 0,
    totalSubtreeHeight: 0,
    pendingNotifications: [] as SoulSSEEvent[],
    processingCtx: createProcessingContext(),
  };
}

/**
 * subtree_update 결과를 nodeMap에 증분 적용한다.
 *
 * nodeMap은 `_event_id`(String(eventId))로 노드를 등록해두므로,
 * 서버 deltas key(JSON 직렬화로 string)를 그대로 조회에 사용한다.
 * 매칭되지 않는 id는 아직 클라이언트에 배치되지 않은 원격 조상이므로 무시한다.
 */
function applySubtreeHeightUpdate(
  ctx: ProcessingContext,
  update: SubtreeHeightUpdate,
): void {
  for (const [idStr, delta] of Object.entries(update.deltas)) {
    const node = ctx.nodeMap.get(idStr);
    if (!node) continue;
    node.subtreeHeight = (node.subtreeHeight ?? 1) + delta;
  }
}

export type EventProcessingSlice = Pick<
  DashboardState,
  | "tree"
  | "treeVersion"
  | "chatPrependedCount"
  | "chatLastPrependAtMs"
  | "treeChangeInfo"
  | "lastEventId"
  | "totalSubtreeHeight"
  | "pendingNotifications"
  | "processingCtx"
> &
  Pick<
    DashboardActions,
    | "processEvent"
    | "processEvents"
    | "processHistoryEvents"
    | "setTotalSubtreeHeight"
  >;

export const createEventProcessingSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  EventProcessingSlice
> = (set, get) => ({
  ...getEventProcessingInitialState(),

  // --- SSE 이벤트 처리 ---
  // createNodeFromEvent + placeInTree + applyUpdate + updateSessionStatus + enqueueNotification
  // 트리에 in-place 변경 후 treeVersion++ 으로 리렌더 트리거

  processEvent: (event, eventId) => {
    const state = get();
    const result = processEventSingle(
      event,
      eventId,
      state.processingCtx,
      state.tree,
      state.activeSessionKey,
      state.activeSessionSummary,
      state.lastEventId,
    );

    // prompt_suggestion: clear → set 순서. 같은 호출에 둘 다 있을 일은 없지만 일관성 유지.
    if (result.clearPromptSuggestionFor) {
      get().clearPromptSuggestion(result.clearPromptSuggestionFor);
    }
    if (result.promptSuggestion) {
      get().setPromptSuggestion(
        result.promptSuggestion.sessionId,
        result.promptSuggestion.text,
      );
    }

    if (result.isHistorySync) {
      set({
        ...(result.newLastEventId > state.lastEventId
          ? { lastEventId: result.newLastEventId }
          : {}),
      });
      return result.statusUpdate;
    }

    // subtree_update 증분 적용 — nodeMap 변경 후 totalSubtreeHeight 갱신
    if (result.subtreeHeightUpdate) {
      applySubtreeHeightUpdate(state.processingCtx, result.subtreeHeightUpdate);
      set({
        totalSubtreeHeight: result.subtreeHeightUpdate.newTotal,
        lastEventId: result.newLastEventId,
        treeVersion: state.treeVersion + 1,
      });
      return result.statusUpdate;
    }

    if (result.updated) {
      set({
        tree: result.root,
        treeVersion: state.treeVersion + 1,
        treeChangeInfo: result.treeChangeInfo,
        lastEventId: result.newLastEventId,
        ...(result.notify
          ? { pendingNotifications: [...state.pendingNotifications, event] }
          : {}),
      });
    } else {
      set({
        lastEventId: result.newLastEventId,
        ...(result.notify
          ? { pendingNotifications: [...state.pendingNotifications, event] }
          : {}),
      });
    }

    return result.statusUpdate;
  },

  // --- SSE 이벤트 배치 처리 ---

  processEvents: (events) => {
    if (events.length === 0) return { statusUpdates: [] };

    const state = get();
    const result = processEventsBatch(
      events,
      state.processingCtx,
      state.tree,
      state.activeSessionKey,
      state.activeSessionSummary,
      state.lastEventId,
    );

    // subtree_update 배치 집계가 있으면 nodeMap에 증분 적용
    if (result.subtreeHeightUpdate) {
      applySubtreeHeightUpdate(state.processingCtx, result.subtreeHeightUpdate);
    }

    // prompt_suggestion: clear → set 순서. 같은 배치에 둘 다 있을 때 새 값이 정본이 됨.
    if (result.clearPromptSuggestionFor) {
      get().clearPromptSuggestion(result.clearPromptSuggestionFor);
    }
    if (result.promptSuggestion) {
      get().setPromptSuggestion(
        result.promptSuggestion.sessionId,
        result.promptSuggestion.text,
      );
    }

    set({
      ...(result.updated
        ? { tree: result.root, treeVersion: state.treeVersion + 1, treeChangeInfo: null }
        : {}),
      ...(result.subtreeHeightUpdate
        ? {
            totalSubtreeHeight: result.subtreeHeightUpdate.newTotal,
            ...(result.updated
              ? {}
              : { treeVersion: state.treeVersion + 1 }),
          }
        : {}),
      lastEventId: result.maxEventId,
      ...(result.notifications.length > 0
        ? { pendingNotifications: [...state.pendingNotifications, ...result.notifications] }
        : {}),
    });

    return { statusUpdates: result.statusUpdates };
  },

  // --- 히스토리 prepend 처리 ---
  //
  // messages API에서 받은 raw 이벤트들을 라이브 SSE와 동일한 event-processor 파이프라인을
  // 거쳐 store.tree에 통합한다. processingCtx.historyMode를 try/finally로 토글하여
  // 부모 부재 자식을 orphan 큐로 분기시킨다 (tree-placer.ts:resolveParent).
  //
  // 반환: addedCount (grouped 차분 — store.chatPrependedCount도 같은 set()에서 갱신).
  // grouped 차분으로 통일하는 이유: virtuoso `data={grouped}`이고 firstItemIndex
  // 변화량은 data 추가량과 정확히 일치해야 위치 보존이 정확하다. messages 차분(flattenTree)을
  // 쓰면 연속 tool 그룹 병합 시 grouped는 0개 늘었는데 firstItemIndex는 N만큼 줄어
  // 좌표가 어긋난다 (flashing + 끝 도달 실패의 원인).
  // (eventId dedup은 processEventsBatch 내부에서 처리되므로 차분이 페이지 크기와 다를 수 있음)
  processHistoryEvents: (events) => {
    if (events.length === 0) return { addedCount: 0 };

    const state = get();
    const beforeGrouped = groupMessages(flattenTree(state.tree)).length;

    // historyMode + activeTextTarget을 try/finally로 격리한다.
    //
    // historyMode: 부모 부재 자식을 orphan으로 분기 (tree-placer.ts:resolveParent).
    // activeTextTarget: 라이브 SSE의 진행 중 text 스트림 노드를 prepend 페이지의
    //   handleTextStart가 덮어쓰지 않도록 격리. 격리 없으면 prepend 처리 후 라이브
    //   text_delta가 과거 text 노드에 잘못 누적되어 메시지가 오염된다.
    state.processingCtx.historyMode = true;
    const savedActiveTextTarget = state.processingCtx.activeTextTarget;
    state.processingCtx.activeTextTarget = null;

    let addedGrouped = 0;
    try {
      const result = processEventsBatch(
        events,
        state.processingCtx,
        state.tree,
        state.activeSessionKey,
        state.activeSessionSummary,
        state.lastEventId,
      );

      if (result.subtreeHeightUpdate) {
        applySubtreeHeightUpdate(state.processingCtx, result.subtreeHeightUpdate);
      }

      // prompt_suggestion: clear → set 순서. 히스토리 prepend 경로에서도 동일하게 처리.
      if (result.clearPromptSuggestionFor) {
        get().clearPromptSuggestion(result.clearPromptSuggestionFor);
      }
      if (result.promptSuggestion) {
        get().setPromptSuggestion(
          result.promptSuggestion.sessionId,
          result.promptSuggestion.text,
        );
      }

      const afterGrouped = result.updated
        ? groupMessages(flattenTree(result.root)).length
        : beforeGrouped;
      addedGrouped = afterGrouped - beforeGrouped;

      set({
        ...(result.updated
          ? {
              tree: result.root,
              treeVersion: state.treeVersion + 1,
              treeChangeInfo: null,
              // tree와 같은 set() 안에서 atomic 갱신 — Zustand subscribe 1회로
              // ChatView 1렌더 사이클 정합 보장 (async batching 무의존).
              chatPrependedCount: state.chatPrependedCount + addedGrouped,
            }
          : {}),
        // chatLastPrependAtMs는 "마지막 prepend 시도 시각" — settle 가드용.
        // result.updated와 무관하게 항상 갱신한다 (events.length===0 early-return으로
        // 빈 호출은 위에서 이미 차단됨). 사용자가 startReached로 fetch를 일으킨
        // 모든 응답이 settle 가드의 시각 기준이 되어야 dedup-only/subtree-only 같은
        // updated=false 코너 케이스에서도 stale 가드 무력화가 발생하지 않는다.
        chatLastPrependAtMs: performance.now(),
        lastEventId: result.maxEventId,
      });
    } finally {
      // 라이브 SSE 동작 보존을 위해 항상 복원
      state.processingCtx.historyMode = false;
      state.processingCtx.activeTextTarget = savedActiveTextTarget;

      // 미해소 orphan 진단 — 데이터 손상 또는 ancestor 누락 시 감지
      if (state.processingCtx.orphans.size > 0) {
        const orphanSummary = Array.from(state.processingCtx.orphans.entries()).map(
          ([parentKey, children]) => ({ parentKey, count: children.length }),
        );
        diag("history", "unresolved orphans after history batch", { orphans: orphanSummary });
      }
    }

    return { addedCount: addedGrouped };
  },

  // --- 뷰포트 API: totalSubtreeHeight 덮어쓰기 ---
  //
  // 뷰포트 응답의 total_subtree_height를 정본으로 반영한다.
  // 같은 값이면 set을 건너뛰어 불필요한 리렌더를 방지한다.
  setTotalSubtreeHeight: (total) => {
    if (get().totalSubtreeHeight === total) return;
    set({ totalSubtreeHeight: total });
  },
});
