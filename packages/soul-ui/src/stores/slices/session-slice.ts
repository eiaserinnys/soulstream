/**
 * Session Slice
 *
 * 활성 세션, 카드/노드 선택, SSE 이벤트 트리, 알림 큐, 접기/펼치기, processingCtx 관리.
 * SSE 이벤트가 트리에 in-place 적용되고 treeVersion++ 으로 리렌더 트리거.
 *
 * addOptimisticSession은 catalog와 viewMode를 함께 갱신하므로 full store 타입 필요.
 */

import type { StateCreator } from "zustand";
import type { QueryClient, InfiniteData } from "@tanstack/react-query";
import type { SessionPage } from "../../hooks/session-stream-helpers";
import type {
  SessionSummary,
  SessionDetail,
  SoulSSEEvent,
  EventTreeNode,
  InputRequestNodeDef,
} from "@shared/types";
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
import { diag } from "../../lib/diag";

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

export type SessionSlice = Pick<
  DashboardState,
  | "activeSessionKey"
  | "activeSession"
  | "activeSessionSummary"
  | "selectedCardId"
  | "selectedNodeId"
  | "selectedEventNodeData"
  | "tree"
  | "treeVersion"
  | "treeChangeInfo"
  | "lastEventId"
  | "totalSubtreeHeight"
  | "pendingNotifications"
  | "collapsedNodeIds"
  | "processingCtx"
> &
  Pick<
    DashboardActions,
    | "setActiveSession"
    | "setActiveSessionSummary"
    | "selectCard"
    | "selectEventNode"
    | "processEvent"
    | "processEvents"
    | "processHistoryEvents"
    | "setTotalSubtreeHeight"
    | "addOptimisticSession"
    | "clearTree"
    | "clearCards"
    | "toggleNodeCollapse"
    | "setNodeCollapsed"
    | "clearCollapsedNodes"
    | "expireInputRequest"
    | "clearActiveSession"
  >;

/** 세션 전환 시 초기화할 상태를 매번 새 인스턴스로 생성 (Set 공유 방지) */
function getSessionResetState() {
  return {
    activeSessionKey: null as string | null,
    activeSession: null as SessionDetail | null,
    selectedCardId: null as string | null,
    selectedNodeId: null as string | null,
    selectedEventNodeData: null as DashboardState["selectedEventNodeData"],
    tree: null as EventTreeNode | null,
    treeVersion: 0,
    treeChangeInfo: null as TreeChangeInfo | null,
    lastEventId: 0,
    totalSubtreeHeight: 0,
    pendingNotifications: [] as SoulSSEEvent[],
    collapsedNodeIds: new Set<string>(),
    activeRightTab: "chat" as const,
    processingCtx: createProcessingContext(),
  };
}

export const createSessionSlice: StateCreator<
  DashboardState & DashboardActions,
  [],
  [],
  SessionSlice
> = (set, get) => ({
  activeSessionKey: null,
  activeSession: null,
  activeSessionSummary: null,
  selectedCardId: null,
  selectedNodeId: null,
  selectedEventNodeData: null,
  tree: null,
  treeVersion: 0,
  treeChangeInfo: null,
  lastEventId: 0,
  totalSubtreeHeight: 0,
  pendingNotifications: [],
  collapsedNodeIds: new Set<string>(),
  processingCtx: createProcessingContext(),

  // --- 활성 세션 ---

  setActiveSession: (key, detail) => {
    // 같은 세션이면 아무것도 하지 않음 (resume 등에서 불필요한 리셋 방지)
    if (key !== null && key === get().activeSessionKey) return;

    // 세션이 속한 폴더를 찾아 selectedFolderId도 갱신
    let folderId: string | null = null;
    const { catalog } = get();
    if (key && catalog?.sessions) {
      const entry = catalog.sessions[key];
      folderId = entry?.folderId ?? null; // 미등록 세션이면 null(미분류)
    }

    set({
      ...getSessionResetState(),
      activeSessionKey: key,
      activeSession: detail ?? null,
      selectedFolderId: folderId,
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
  // 반환: addedCount (flattenTree 차분) — virtuoso prependedCount 갱신용.
  // (eventId dedup은 processEventsBatch 내부에서 처리되므로 차분이 페이지 크기와 다를 수 있음)
  processHistoryEvents: (events) => {
    if (events.length === 0) return { addedCount: 0 };

    const state = get();
    const beforeCount = flattenTree(state.tree).length;

    // historyMode + activeTextTarget을 try/finally로 격리한다.
    //
    // historyMode: 부모 부재 자식을 orphan으로 분기 (tree-placer.ts:resolveParent).
    // activeTextTarget: 라이브 SSE의 진행 중 text 스트림 노드를 prepend 페이지의
    //   handleTextStart가 덮어쓰지 않도록 격리. 격리 없으면 prepend 처리 후 라이브
    //   text_delta가 과거 text 노드에 잘못 누적되어 메시지가 오염된다.
    state.processingCtx.historyMode = true;
    const savedActiveTextTarget = state.processingCtx.activeTextTarget;
    state.processingCtx.activeTextTarget = null;
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

      set({
        ...(result.updated
          ? { tree: result.root, treeVersion: state.treeVersion + 1, treeChangeInfo: null }
          : {}),
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

    const afterCount = flattenTree(get().tree).length;
    return { addedCount: afterCount - beforeCount };
  },

  // --- 뷰포트 API: totalSubtreeHeight 덮어쓰기 ---
  //
  // 뷰포트 응답의 total_subtree_height를 정본으로 반영한다.
  // 같은 값이면 set을 건너뛰어 불필요한 리렌더를 방지한다.
  setTotalSubtreeHeight: (total) => {
    if (get().totalSubtreeHeight === total) return;
    set({ totalSubtreeHeight: total });
  },

  // --- 낙관적 세션 추가 ---

  addOptimisticSession: (
    queryClient: QueryClient,
    agentSessionId,
    prompt,
    folderId,
    nodeId,
    agentId,
    agentName,
    agentPortraitUrl,
  ) => {
    let catalog = get().catalog;
    const newSession: SessionSummary = {
      agentSessionId,
      status: "running",
      eventCount: 0,
      createdAt: new Date().toISOString(),
      prompt,
      lastEventId: 0,
      lastReadEventId: 0,
      ...(nodeId ? { nodeId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(agentName ? { agentName } : {}),
      ...(agentPortraitUrl ? { agentPortraitUrl } : {}),
    };

    // TanStack Query 캐시에 낙관적 prepend
    queryClient.setQueriesData<InfiniteData<SessionPage>>(
      { queryKey: ["sessions"], exact: false },
      (old) => {
        if (!old) return old;
        // 이미 존재하면 중복 삽입 방지
        const exists = old.pages.some((page) =>
          page.sessions.some((s) => s.agentSessionId === agentSessionId),
        );
        if (exists) return old;
        return {
          ...old,
          pages: old.pages.map((page, i) =>
            i === 0
              ? {
                  ...page,
                  sessions: [newSession, ...page.sessions],
                  total: page.total + 1,
                }
              : page,
          ),
        };
      },
    );

    // catalog.sessions에도 낙관적으로 폴더 할당 추가
    if (catalog && folderId) {
      catalog = {
        ...catalog,
        sessions: {
          ...catalog.sessions,
          [agentSessionId]: { folderId, displayName: null },
        },
      };
    }

    set({
      ...getSessionResetState(),
      catalog,
      activeSessionKey: agentSessionId,
      activeSession: null,
      selectedSessionIds: new Set([agentSessionId]),
      // 새 세션이 생성된 폴더로 뷰를 이동한다.
      // folderId가 undefined이면 호출자가 폴더를 지정하지 않은 것이므로 현재 선택을 유지한다.
      ...(folderId !== undefined
        ? { selectedFolderId: folderId, viewMode: "folder" as const }
        : {}),
    });

    get().setActiveSessionSummary(newSession);
  },

  // --- 초기화 ---

  clearTree: () => {
    set({
      tree: null,
      treeVersion: 0,
      treeChangeInfo: null,
      lastEventId: 0,
      totalSubtreeHeight: 0,
      pendingNotifications: [],
      selectedCardId: null,
      selectedNodeId: null,
      selectedEventNodeData: null,
      collapsedNodeIds: new Set<string>(),
      processingCtx: createProcessingContext(),
    });
  },

  // 하위 호환 alias
  clearCards() {
    get().clearTree();
  },

  // --- 접기/펼치기 ---

  toggleNodeCollapse: (nodeId) => {
    const currentCollapsed = get().collapsedNodeIds;
    const newCollapsed = new Set(currentCollapsed);
    if (newCollapsed.has(nodeId)) {
      newCollapsed.delete(nodeId);
    } else {
      newCollapsed.add(nodeId);
    }
    set({
      collapsedNodeIds: newCollapsed,
      treeVersion: get().treeVersion + 1,
      treeChangeInfo: { type: "collapse-toggle" },
    });
  },

  setNodeCollapsed: (nodeId, collapsed) => {
    const currentCollapsed = get().collapsedNodeIds;
    const newCollapsed = new Set(currentCollapsed);
    if (collapsed) {
      newCollapsed.add(nodeId);
    } else {
      newCollapsed.delete(nodeId);
    }
    set({
      collapsedNodeIds: newCollapsed,
      treeVersion: get().treeVersion + 1,
      treeChangeInfo: { type: "collapse-toggle" },
    });
  },

  clearCollapsedNodes: () => {
    set({
      collapsedNodeIds: new Set<string>(),
      treeVersion: get().treeVersion + 1,
      treeChangeInfo: { type: "collapse-toggle" },
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
    set({
      ...getSessionResetState(),
      activeSessionKey: null,
      activeSession: null,
      activeSessionSummary: null,
      selectedFolderId,
    });
  },
});
