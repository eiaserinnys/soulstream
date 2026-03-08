/**
 * Soul Dashboard - Zustand Store
 *
 * 대시보드 전역 상태 관리.
 * 세션 목록, 활성 세션, 선택된 노드, SSE 이벤트 처리를 담당합니다.
 *
 * 핵심 원칙: EventTreeNode 트리가 소스 오브 트루스.
 * SSE 이벤트가 도착하면 트리에 삽입. 레이아웃 엔진은 트리를 DFS 순회하여 렌더링.
 *
 * Mutable tree + version counter 전략:
 * - 트리 노드는 in-place 변경 (text_delta가 가장 빈번, O(1) 필요)
 * - 변경 후 treeVersion++로 리렌더 트리거
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  SessionSummary,
  SessionDetail,
  SessionStatus,
  SoulSSEEvent,
  EventTreeNode,
  TextStartEvent,
  HistorySyncEvent,
} from "@shared/types";
import type { StorageMode } from "../providers/types";
import {
  type ProcessingContext,
  createProcessingContext,
  ensureRoot,
} from "./processing-context";
import { createNodeFromEvent, applyUpdate } from "./node-factory";
import { placeInTree, handleTextStart } from "./tree-placer";
import { shouldNotify, deriveSessionStatus } from "./session-updater";

// === Selected Event Node Data ===

/** selectEventNode로 선택된 이벤트 노드의 데이터 (user, intervention, system, result) */
export interface SelectedEventNodeData {
  nodeType: "user" | "intervention" | "system" | "result";
  label: string;
  content: string;
  durationMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
  totalCostUsd?: number;
  isError?: boolean;
}

// === State Interface ===

export interface DashboardState {
  /** 스토리지 모드 */
  storageMode: StorageMode;

  /** 세션 목록 */
  sessions: SessionSummary[];
  sessionsLoading: boolean;
  sessionsError: string | null;

  /** 활성 세션 (현재 보고 있는 세션) */
  activeSessionKey: string | null;
  activeSession: SessionDetail | null;

  /** 선택된 카드 (상세 뷰에 표시) */
  selectedCardId: string | null;

  /** 선택된 React Flow 노드 ID */
  selectedNodeId: string | null;

  /** 선택된 이벤트 노드 데이터 (user/intervention/system/result 노드용) */
  selectedEventNodeData: SelectedEventNodeData | null;

  /** 이벤트 트리 루트 (소스 오브 트루스) */
  tree: EventTreeNode | null;

  /** 트리 변경 감지용 카운터 (mutable tree이므로 참조 비교 불가) */
  treeVersion: number;

  /** 마지막으로 수신한 이벤트 ID (SSE 재연결용) */
  lastEventId: number;

  /** 알림 대상 이벤트 큐 (complete, error, intervention_sent) */
  pendingNotifications: SoulSSEEvent[];

  /** 세션 생성 모드 (프롬프트 입력 화면 표시) */
  isComposing: boolean;

  /** 세션 재개 대상 키 (완료된 세션에서 이어서 대화) */
  resumeTargetKey: string | null;

  /** 접힌 노드 ID 집합 (접기/펼치기 기능) */
  collapsedNodeIds: Set<string>;

  /** 세렌디피티 모드 사용 가능 여부 (서버 설정 기반) */
  serendipityAvailable: boolean;

  /** 오른쪽 패널 활성 탭 */
  activeRightTab: "detail" | "chat";

  /** 이벤트 처리 컨텍스트 (nodeMap, activeTextTarget 등) */
  processingCtx: ProcessingContext;
}

// === Actions Interface ===

export interface DashboardActions {
  // 스토리지 모드
  setStorageMode: (mode: StorageMode) => void;

  // 세션 목록
  setSessions: (sessions: SessionSummary[]) => void;
  addSession: (session: SessionSummary) => void;
  updateSession: (
    agentSessionId: string,
    updates: Partial<Pick<SessionSummary, "status" | "completedAt" | "eventCount" | "lastEventType">>
  ) => void;
  removeSession: (agentSessionId: string) => void;
  setSessionsLoading: (loading: boolean) => void;
  setSessionsError: (error: string | null) => void;

  // 활성 세션
  setActiveSession: (key: string | null, detail?: SessionDetail) => void;

  // 카드 선택 (nodeId: React Flow 노드의 고유 ID, switchTab: detail 탭 전환 여부)
  selectCard: (cardId: string | null, nodeId?: string | null, switchTab?: boolean) => void;

  // 이벤트 노드 선택 (user/intervention/system/result 등 카드가 아닌 노드)
  selectEventNode: (data: SelectedEventNodeData | null, nodeId?: string | null, switchTab?: boolean) => void;

  // SSE 이벤트 처리
  processEvent: (event: SoulSSEEvent, eventId: number) => void;

  // SSE 이벤트 배치 처리 (히스토리 리플레이 최적화: N개 이벤트를 트리에 적용 후 set() 1회)
  processEvents: (events: Array<{ event: SoulSSEEvent; eventId: number }>) => void;

  // 낙관적 세션 추가 (세션 생성 직후 즉시 목록 반영)
  addOptimisticSession: (agentSessionId: string, prompt: string) => void;

  // 세션 생성 완료 (낙관적 추가 + compose 종료 + 세션 활성화를 단일 set으로 처리)
  completeCompose: (agentSessionId: string, prompt: string) => void;

  // 세션 생성/재개
  startCompose: () => void;
  startResume: (sessionKey: string) => void;
  cancelCompose: () => void;

  // 상태 초기화
  clearTree: () => void;
  reset: () => void;

  // 하위 호환 alias
  clearCards: () => void;

  // 접기/펼치기
  toggleNodeCollapse: (nodeId: string) => void;
  setNodeCollapsed: (nodeId: string, collapsed: boolean) => void;
  clearCollapsedNodes: () => void;

  // 세렌디피티 가용 여부
  setSerendipityAvailable: (available: boolean) => void;

  // 오른쪽 패널 탭
  setActiveRightTab: (tab: "detail" | "chat") => void;
}

// === Internal Processing Context ===
// Phase 6: ProcessingContext를 store state 내부로 이동.
// nodeMap이 store 관할이 되어, 세션 전환/리셋 시 store.set()으로 완전 격리.

/** ensureRoot가 필요한 이벤트 타입 (text_delta, text_end, tool_result, subagent_stop 제외) */
const NEEDS_ROOT = new Set([
  "user_message", "session", "intervention_sent", "thinking",
  "text_start", "subagent_start", "tool_start",
  "complete", "error", "result",
]);

// === Initial State ===

const initialState: DashboardState = {
  storageMode: "sse",
  sessions: [],
  sessionsLoading: true,
  sessionsError: null,
  activeSessionKey: null,
  activeSession: null,
  selectedCardId: null,
  selectedNodeId: null,
  selectedEventNodeData: null,
  tree: null,
  treeVersion: 0,
  lastEventId: 0,
  pendingNotifications: [],
  isComposing: true,
  resumeTargetKey: null,
  collapsedNodeIds: new Set<string>(),
  serendipityAvailable: false,
  activeRightTab: "detail",
  processingCtx: createProcessingContext(),
};

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
    lastEventId: 0,
    pendingNotifications: [] as SoulSSEEvent[],
    collapsedNodeIds: new Set<string>(),
    processingCtx: createProcessingContext(),
  };
}

// === Store ===

export const useDashboardStore = create<DashboardState & DashboardActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      // --- 스토리지 모드 ---

      setStorageMode: (storageMode) => {
        set({
          storageMode,
          sessions: [],
          sessionsLoading: true,
          sessionsError: null,
          activeSessionKey: null,
          activeSession: null,
          tree: null,
          treeVersion: 0,
          lastEventId: 0,
          pendingNotifications: [],
          selectedCardId: null,
          selectedNodeId: null,
          selectedEventNodeData: null,
          collapsedNodeIds: new Set<string>(),
          activeRightTab: "detail",
          processingCtx: createProcessingContext(),
        });
      },

      // --- 세션 목록 ---

      setSessions: (sessions) => set({ sessions, sessionsError: null }),

      addSession: (session) => {
        const sessions = get().sessions;
        // 중복 체크 (이미 존재하면 추가하지 않음)
        if (sessions.some((s) => s.agentSessionId === session.agentSessionId)) {
          return;
        }
        // 최신 세션이 앞에 오도록 추가
        set({ sessions: [session, ...sessions], sessionsError: null });
      },

      updateSession: (agentSessionId, updates) => {
        const sessions = get().sessions;
        const idx = sessions.findIndex((s) => s.agentSessionId === agentSessionId);
        if (idx < 0) return;

        const updatedSessions = [...sessions];
        updatedSessions[idx] = { ...updatedSessions[idx], ...updates };
        set({ sessions: updatedSessions });
      },

      removeSession: (agentSessionId) => {
        const sessions = get().sessions;
        set({ sessions: sessions.filter((s) => s.agentSessionId !== agentSessionId) });
      },

      setSessionsLoading: (sessionsLoading) => set({ sessionsLoading }),

      setSessionsError: (sessionsError) =>
        set({ sessionsError, sessionsLoading: false }),

      // --- 활성 세션 ---

      setActiveSession: (key, detail) => {
        // 같은 세션이면 아무것도 하지 않음 (resume 등에서 불필요한 리셋 방지)
        if (key !== null && key === get().activeSessionKey) return;

        set({
          ...getSessionResetState(),
          activeSessionKey: key,
          activeSession: detail ?? null,
          isComposing: false,
          resumeTargetKey: null,
        });
      },

      // --- 카드 선택 ---

      selectCard: (cardId, nodeId, switchTab = true) =>
        set({
          selectedCardId: cardId,
          selectedNodeId: nodeId ?? null,
          selectedEventNodeData: null,
          ...(switchTab ? { activeRightTab: "detail" as const } : {}),
        }),

      // --- 이벤트 노드 선택 ---

      selectEventNode: (data, nodeId, switchTab = true) =>
        set({
          selectedEventNodeData: data,
          selectedCardId: null,
          selectedNodeId: nodeId ?? null,
          ...(switchTab ? { activeRightTab: "detail" as const } : {}),
        }),

      // --- SSE 이벤트 처리 ---
      // createNodeFromEvent + placeInTree + applyUpdate + updateSessionStatus + enqueueNotification
      // 트리에 in-place 변경 후 treeVersion++ 으로 리렌더 트리거

      processEvent: (event, eventId) => {
        const state = get();
        const ctx = state.processingCtx;
        let root = state.tree;

        // history_sync 이벤트: 히스토리 리플레이 완료 → 서버의 정본 상태 적용
        if (event.type === "history_sync") {
          ctx.historySynced = true;
          const syncEvent = event as HistorySyncEvent;

          // 서버가 보내준 status를 세션 목록에 즉시 반영 (정본)
          let sessionsUpdate: { sessions: SessionSummary[] } | Record<string, never> = {};
          if (syncEvent.status && state.activeSessionKey) {
            const idx = state.sessions.findIndex(
              (s) => s.agentSessionId === state.activeSessionKey,
            );
            if (idx >= 0 && state.sessions[idx].status !== syncEvent.status) {
              const updatedSessions = [...state.sessions];
              updatedSessions[idx] = {
                ...updatedSessions[idx],
                status: syncEvent.status as SessionStatus,
              };
              sessionsUpdate = { sessions: updatedSessions };
            }
          }

          set({ lastEventId: eventId, ...sessionsUpdate });
          return;
        }

        // root가 필요한 이벤트에 대해 보장
        if (NEEDS_ROOT.has(event.type)) {
          root = ensureRoot(root, ctx);
        }

        // 1. 노드 생성 시도 (생성형 이벤트만 노드 반환)
        const node = createNodeFromEvent(event, eventId);
        let updated: boolean;

        if (node) {
          // 2a. 생성된 노드를 트리에 배치 + Map 등록
          placeInTree(node, event, eventId, ctx, root!);
          updated = true;
        } else if (event.type === "text_start") {
          // 2b. text_start: 조건부 노드 생성 + 트리 배치 (tree-placer 책임)
          updated = handleTextStart(event as TextStartEvent, eventId, ctx, root!);
        } else {
          // 2c. 업데이트 이벤트 처리 (session, text_delta/end, tool_result, subagent_stop)
          updated = applyUpdate(event, eventId, ctx, root);
        }

        // 3. 세션 상태 갱신 — 히스토리 리플레이 중에는 억제
        // history_sync 수신 전에는 저장된 이벤트를 리플레이하는 단계이므로
        // 이벤트별로 status를 갱신하면 running → completed 깜빡임이 발생한다.
        let sessionsUpdate: { sessions: SessionSummary[] } | Record<string, never> = {};
        if (ctx.historySynced) {
          const derivedStatus = deriveSessionStatus(event);
          if (derivedStatus && state.activeSessionKey) {
            const idx = state.sessions.findIndex(
              (s) => s.agentSessionId === state.activeSessionKey,
            );
            if (idx >= 0 && state.sessions[idx].status !== derivedStatus) {
              const updatedSessions = [...state.sessions];
              updatedSessions[idx] = {
                ...updatedSessions[idx],
                status: derivedStatus,
              };
              sessionsUpdate = { sessions: updatedSessions };
            }
          }
        }

        // 4. 알림 큐 + store 갱신
        // 히스토리 리플레이 중에는 알림도 억제 (과거 이벤트로 알림이 뜨면 안 됨)
        const notify = ctx.historySynced && shouldNotify(event);
        if (updated) {
          set({
            tree: root,
            treeVersion: state.treeVersion + 1,
            lastEventId: eventId,
            ...sessionsUpdate,
            ...(notify
              ? { pendingNotifications: [...state.pendingNotifications, event] }
              : {}),
          });
        } else {
          set({
            lastEventId: eventId,
            ...sessionsUpdate,
            ...(notify
              ? { pendingNotifications: [...state.pendingNotifications, event] }
              : {}),
          });
        }
      },

      // --- SSE 이벤트 배치 처리 ---
      // 히스토리 리플레이 최적화: N개 이벤트의 트리 변경을 수행 후 set() 1회만 호출.
      // 개별 processEvent가 매번 set()을 호출하는 것과 달리,
      // 972개 이벤트 → set() 1회로 렌더 비용을 O(N)에서 O(1)로 줄입니다.

      processEvents: (events) => {
        if (events.length === 0) return;

        const state = get();
        const ctx = state.processingCtx;
        let root = state.tree;
        let updated = false;
        let maxEventId = state.lastEventId;
        let sessionsUpdate: { sessions: SessionSummary[] } | Record<string, never> = {};
        const notifications: SoulSSEEvent[] = [];

        for (const { event, eventId } of events) {
          if (eventId > maxEventId) maxEventId = eventId;

          // history_sync 이벤트
          if (event.type === "history_sync") {
            ctx.historySynced = true;
            const syncEvent = event as HistorySyncEvent;

            if (syncEvent.status && state.activeSessionKey) {
              const sessions = sessionsUpdate.sessions ?? state.sessions;
              const idx = sessions.findIndex(
                (s) => s.agentSessionId === state.activeSessionKey,
              );
              if (idx >= 0 && sessions[idx].status !== syncEvent.status) {
                const updatedSessions = [...sessions];
                updatedSessions[idx] = {
                  ...updatedSessions[idx],
                  status: syncEvent.status as SessionStatus,
                };
                sessionsUpdate = { sessions: updatedSessions };
              }
            }
            continue;
          }

          // root 보장
          if (NEEDS_ROOT.has(event.type)) {
            root = ensureRoot(root, ctx);
          }

          // 노드 생성/배치/업데이트
          const node = createNodeFromEvent(event, eventId);
          if (node) {
            placeInTree(node, event, eventId, ctx, root!);
            updated = true;
          } else if (event.type === "text_start") {
            if (handleTextStart(event as TextStartEvent, eventId, ctx, root!)) {
              updated = true;
            }
          } else {
            if (applyUpdate(event, eventId, ctx, root)) {
              updated = true;
            }
          }

          // 세션 상태 갱신 (히스토리 리플레이 중에는 억제)
          if (ctx.historySynced) {
            const derivedStatus = deriveSessionStatus(event);
            if (derivedStatus && state.activeSessionKey) {
              const sessions = sessionsUpdate.sessions ?? state.sessions;
              const idx = sessions.findIndex(
                (s) => s.agentSessionId === state.activeSessionKey,
              );
              if (idx >= 0 && sessions[idx].status !== derivedStatus) {
                const updatedSessions = [...sessions];
                updatedSessions[idx] = {
                  ...updatedSessions[idx],
                  status: derivedStatus,
                };
                sessionsUpdate = { sessions: updatedSessions };
              }
            }

            if (shouldNotify(event)) {
              notifications.push(event);
            }
          }
        }

        // 배치 전체에 대해 set() 1회만 호출
        set({
          ...(updated ? { tree: root, treeVersion: state.treeVersion + 1 } : {}),
          lastEventId: maxEventId,
          ...sessionsUpdate,
          ...(notifications.length > 0
            ? { pendingNotifications: [...state.pendingNotifications, ...notifications] }
            : {}),
        });
      },

      // --- 낙관적 세션 추가 ---

      addOptimisticSession: (agentSessionId, prompt) => {
        const sessions = get().sessions;
        if (sessions.some((s) => s.agentSessionId === agentSessionId)) return;
        const newSession: SessionSummary = {
          agentSessionId,
          status: "running",
          eventCount: 0,
          createdAt: new Date().toISOString(),
          prompt,
        };
        set({ sessions: [newSession, ...sessions] });
      },

      // --- 세션 생성 완료 (atomic) ---

      completeCompose: (agentSessionId, prompt) => {
        const sessions = get().sessions;
        const newSession: SessionSummary = {
          agentSessionId,
          status: "running",
          eventCount: 0,
          createdAt: new Date().toISOString(),
          prompt,
        };
        const updatedSessions = sessions.some(
          (s) => s.agentSessionId === agentSessionId,
        )
          ? sessions
          : [newSession, ...sessions];

        set({
          ...getSessionResetState(),
          sessions: updatedSessions,
          activeSessionKey: agentSessionId,
          activeSession: null,
          isComposing: false,
          resumeTargetKey: null,
        });
      },

      // --- 세션 생성/재개 ---

      startCompose: () => {
        set({
          ...getSessionResetState(),
          isComposing: true,
          resumeTargetKey: null,
        });
      },

      // Resume: 기존 세션 상태를 유지하면서 compose 모드 진입
      startResume: (sessionKey) =>
        set({
          isComposing: true,
          resumeTargetKey: sessionKey,
        }),

      cancelCompose: () =>
        set({
          isComposing: false,
          resumeTargetKey: null,
        }),

      // --- 초기화 ---

      clearTree: () => {
        set({
          tree: null,
          treeVersion: 0,
          lastEventId: 0,
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

      reset: () => {
        set({
          ...initialState,
          collapsedNodeIds: new Set<string>(),
          processingCtx: createProcessingContext(),
        });
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
        set({ collapsedNodeIds: newCollapsed, treeVersion: get().treeVersion + 1 });
      },

      setNodeCollapsed: (nodeId, collapsed) => {
        const currentCollapsed = get().collapsedNodeIds;
        const newCollapsed = new Set(currentCollapsed);
        if (collapsed) {
          newCollapsed.add(nodeId);
        } else {
          newCollapsed.delete(nodeId);
        }
        set({ collapsedNodeIds: newCollapsed, treeVersion: get().treeVersion + 1 });
      },

      clearCollapsedNodes: () => {
        set({ collapsedNodeIds: new Set<string>(), treeVersion: get().treeVersion + 1 });
      },

      // --- 세렌디피티 가용 여부 ---

      setSerendipityAvailable: (serendipityAvailable) => set({ serendipityAvailable }),

      // --- 오른쪽 패널 탭 ---

      setActiveRightTab: (activeRightTab) => set({ activeRightTab }),
    }),
    {
      name: "soul-dashboard-storage",
      // 스토리지 모드만 영속화 (세션 데이터는 제외)
      partialize: (state) => ({ storageMode: state.storageMode }),
    },
  ),
);

// === Tree Utility Functions (외부에서 사용) ===

/** 트리의 전체 노드 수를 카운트합니다. */
export function countTreeNodes(node: EventTreeNode | null): number {
  if (!node) return 0;
  let count = 1;
  for (const child of node.children) {
    count += countTreeNodes(child);
  }
  return count;
}

/** 트리에서 미완료 노드 수를 카운트합니다. */
export function countStreamingNodes(node: EventTreeNode | null): number {
  if (!node) return 0;
  let count = node.completed ? 0 : 1;
  for (const child of node.children) {
    count += countStreamingNodes(child);
  }
  return count;
}

/** 트리에서 ID로 노드를 찾습니다. */
export function findTreeNode(
  root: EventTreeNode | null,
  id: string,
): EventTreeNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findTreeNode(child, id);
    if (found) return found;
  }
  return null;
}

