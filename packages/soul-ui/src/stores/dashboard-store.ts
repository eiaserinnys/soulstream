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
  SessionNode,
  SoulSSEEvent,
  EventTreeNode,
  TextStartEvent,
  HistorySyncEvent,
  InputRequestNodeDef,
  CatalogState,
  CatalogFolder,
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

// === Dashboard Config ===

export interface ProfileConfig {
  name: string;
  id: string;
  hasPortrait: boolean;
}

export interface DashboardConfig {
  user: ProfileConfig;
  assistant: ProfileConfig;
}

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
  sessionsTotal: number;
  sessionsLoading: boolean;
  sessionsError: string | null;

  /** 세션 타입 필터 */
  sessionTypeFilter: "all" | "claude" | "llm";

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

  /** New Session 모달 열림 상태 */
  isNewSessionModalOpen: boolean;

  /** 접힌 노드 ID 집합 (접기/펼치기 기능) */
  collapsedNodeIds: Set<string>;

  /** 세렌디피티 모드 사용 가능 여부 (서버 설정 기반) */
  serendipityAvailable: boolean;

  /** 오른쪽 패널 활성 탭 */
  activeRightTab: "detail" | "chat";

  /** 대시보드 프로필 설정 */
  dashboardConfig: DashboardConfig | null;

  /** 이벤트 처리 컨텍스트 (nodeMap, activeTextTarget 등) */
  processingCtx: ProcessingContext;

  /** 입력창 임시 저장 (키: 세션ID / '__draft__{folderId}')
   * ⚠️ getSessionResetState()에 포함하지 않는 것이 이 기능의 핵심 — drafts는 세션 전환 시 초기화하지 않는다 */
  drafts: Record<string, string>;

  /** 검색 결과 클릭 시 스크롤할 이벤트 ID (ChatView가 감지하여 해당 메시지로 스크롤) */
  focusEventId: number | null;

  /** 세션 다중 선택 ID 집합 */
  selectedSessionIds: Set<string>;

  /** Shift+클릭 범위 기준점 */
  lastSelectedSessionId: string | null;

  /** 인라인 편집 중인 세션 */
  editingSessionId: string | null;

  /** 모바일 뷰 상태 ('sessions': 세션 리스트, 'chat': 채팅 뷰) */
  mobileView: "sessions" | "chat";

  /** 폴더 카탈로그 상태 */
  catalog: CatalogState | null;

  /** 선택된 폴더 ID (null = 미분류) */
  selectedFolderId: string | null;

  /** 카탈로그 변경 감지용 카운터 */
  catalogVersion: number;
}

// === Actions Interface ===

export interface DashboardActions {
  // 스토리지 모드
  setStorageMode: (mode: StorageMode) => void;

  // 세션 목록
  setSessions: (sessions: SessionSummary[], total?: number) => void;
  addSession: (session: SessionSummary) => void;
  updateSession: (
    agentSessionId: string,
    updates: Partial<Pick<SessionSummary, "status" | "updatedAt" | "completedAt" | "eventCount" | "lastEventType" | "lastMessage" | "metadata">>
  ) => void;
  removeSession: (agentSessionId: string) => void;
  setSessionsLoading: (loading: boolean) => void;
  setSessionsError: (error: string | null) => void;

  // 세션 타입 필터
  setSessionTypeFilter: (type: "all" | "claude" | "llm") => void;

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

  // 낙관적 세션 추가 + 활성 세션 설정 (세션 생성 직후 즉시 목록 반영)
  addOptimisticSession: (agentSessionId: string, prompt: string, folderId?: string | null) => void;

  // New Session 모달
  openNewSessionModal: () => void;
  closeNewSessionModal: () => void;

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

  // 대시보드 프로필 설정
  setDashboardConfig: (config: DashboardConfig) => void;

  // input_request 타임아웃 만료 처리
  expireInputRequest: (nodeId: string) => void;

  // draft 저장/삭제
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;

  // 검색 포커스 이벤트 ID
  setFocusEventId: (eventId: number | null) => void;

  // 카탈로그
  setCatalog: (catalog: CatalogState) => void;
  selectFolder: (folderId: string | null) => void;
  getSessionsInFolder: (folderId: string | null) => SessionSummary[];
  moveSessionsToFolder: (sessionIds: string[], folderId: string | null) => void;
  renameSession: (sessionId: string, displayName: string | null) => void;
  addFolder: (folder: CatalogFolder) => void;
  updateFolderName: (folderId: string, name: string) => void;
  removeFolder: (folderId: string) => void;

  // 모바일 뷰 전환
  setMobileView: (view: "sessions" | "chat") => void;

  // 활성 세션 해제 (selectedFolderId를 유지하면서 세션만 해제)
  clearActiveSession: () => void;

  // 다중 선택
  toggleSessionSelection: (id: string, ctrlKey: boolean, shiftKey: boolean) => void;
  clearSelection: () => void;
  setEditingSession: (id: string | null) => void;
}

// === Internal Processing Context ===
// Phase 6: ProcessingContext를 store state 내부로 이동.
// nodeMap이 store 관할이 되어, 세션 전환/리셋 시 store.set()으로 완전 격리.

/** ensureRoot가 필요한 이벤트 타입 (text_delta, text_end, tool_result, subagent_stop 제외) */
const NEEDS_ROOT = new Set([
  "user_message", "session", "intervention_sent", "thinking",
  "text_start", "subagent_start", "tool_start",
  "complete", "error", "result", "input_request",
  "assistant_message",
]);

/**
 * 세션 루트 노드에 LLM 메타데이터를 설정한다.
 * ensureRoot() 직후 호출하여 루트가 처음 생성될 때만 메타데이터를 반영한다.
 */
function applyLlmMetadata(
  root: EventTreeNode,
  sessions: SessionSummary[],
  activeSessionKey: string | null,
): void {
  if (!activeSessionKey || root.type !== "session") return;
  const sessionRoot = root as SessionNode;
  if (sessionRoot.sessionType != null) return; // 이미 설정됨

  const info = sessions.find((s) => s.agentSessionId === activeSessionKey);
  if (info?.sessionType === "llm") {
    sessionRoot.sessionType = info.sessionType;
    sessionRoot.llmProvider = info.llmProvider;
    sessionRoot.llmModel = info.llmModel;
  }
}

// === Initial State ===

const initialState: DashboardState = {
  storageMode: "sse",
  sessions: [],
  sessionsTotal: 0,
  sessionsLoading: true,
  sessionsError: null,
  sessionTypeFilter: "all",
  activeSessionKey: null,
  activeSession: null,
  selectedCardId: null,
  selectedNodeId: null,
  selectedEventNodeData: null,
  tree: null,
  treeVersion: 0,
  lastEventId: 0,
  pendingNotifications: [],
  isNewSessionModalOpen: false,
  collapsedNodeIds: new Set<string>(),
  serendipityAvailable: false,
  activeRightTab: "chat",
  dashboardConfig: null,
  processingCtx: createProcessingContext(),
  drafts: {},
  focusEventId: null,
  selectedSessionIds: new Set<string>(),
  lastSelectedSessionId: null,
  editingSessionId: null,
  mobileView: "sessions",
  catalog: null,
  selectedFolderId: null,
  catalogVersion: 0,
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
    activeRightTab: "chat" as const,
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
          sessionsTotal: 0,
          sessionsLoading: true,
          sessionsError: null,
          sessionTypeFilter: "all",
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
          activeRightTab: "chat",
          processingCtx: createProcessingContext(),
        });
      },

      // --- 세션 목록 ---

      setSessions: (sessions, total) => set({
        sessions,
        sessionsTotal: total ?? sessions.length,
        sessionsError: null,
      }),

      addSession: (session) => {
        const { sessions, sessionsTotal } = get();
        // 중복 체크 (이미 존재하면 추가하지 않음)
        if (sessions.some((s) => s.agentSessionId === session.agentSessionId)) {
          return;
        }
        const updated = [session, ...sessions];
        set({
          sessions: updated,
          sessionsTotal: sessionsTotal + 1,
          sessionsError: null,
        });
      },

      updateSession: (agentSessionId, updates) => {
        const sessions = get().sessions;
        const idx = sessions.findIndex((s) => s.agentSessionId === agentSessionId);
        if (idx < 0) return;

        const newSessions = sessions.map((s) =>
          s.agentSessionId === agentSessionId ? { ...s, ...updates } : s
        );
        newSessions.sort((a, b) => {
          const aTime = a.updatedAt ?? a.createdAt ?? "";
          const bTime = b.updatedAt ?? b.createdAt ?? "";
          return bTime.localeCompare(aTime);
        });
        set({ sessions: newSessions });
      },

      removeSession: (agentSessionId) => {
        const sessions = get().sessions;
        const filtered = sessions.filter((s) => s.agentSessionId !== agentSessionId);
        const removed = sessions.length - filtered.length;
        set({
          sessions: filtered,
          sessionsTotal: Math.max(0, get().sessionsTotal - removed),
        });
      },

      setSessionsLoading: (sessionsLoading) => set({ sessionsLoading }),

      setSessionsError: (sessionsError) =>
        set({ sessionsError, sessionsLoading: false }),

      // --- 세션 타입 필터 ---

      setSessionTypeFilter: (sessionTypeFilter) => set({ sessionTypeFilter }),

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

        // Dedup: 이미 처리한 이벤트 건너뛰기 (resume/reconnect 시 중복 방지)
        // history_sync는 eventId=0이므로 이 가드에 걸리지 않는다
        if (eventId > 0 && eventId <= state.lastEventId) {
          return;
        }

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

          set({ ...(eventId > 0 ? { lastEventId: eventId } : {}), ...sessionsUpdate });
          return;
        }

        // root가 필요한 이벤트에 대해 보장
        if (NEEDS_ROOT.has(event.type)) {
          root = ensureRoot(root, ctx);
          applyLlmMetadata(root, state.sessions, state.activeSessionKey);
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
          // Dedup: 이미 처리한 이벤트 건너뛰기 (resume/reconnect 시 중복 방지)
          if (eventId > 0 && eventId <= state.lastEventId) {
            continue;
          }
          if (eventId > maxEventId) maxEventId = eventId;

          // history_sync 이벤트
          if (event.type === "history_sync") {
            ctx.historySynced = true;
            const syncEvent = event as HistorySyncEvent;

            if (syncEvent.status && state.activeSessionKey) {
              const sessions: SessionSummary[] =
                "sessions" in sessionsUpdate ? sessionsUpdate.sessions : state.sessions;
              const idx = sessions.findIndex(
                (s) => s.agentSessionId === state.activeSessionKey,
              );
              if (idx >= 0 && sessions[idx].status !== syncEvent.status) {
                const updatedSessions: SessionSummary[] = [...sessions];
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
            applyLlmMetadata(root, state.sessions, state.activeSessionKey);
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

      addOptimisticSession: (agentSessionId, prompt, folderId) => {
        const sessions = get().sessions;
        let catalog = get().catalog;
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
          sessions: updatedSessions,
          catalog,
          activeSessionKey: agentSessionId,
          activeSession: null,
        });
      },

      // --- New Session 모달 ---

      openNewSessionModal: () => set({ isNewSessionModalOpen: true }),
      closeNewSessionModal: () => set({ isNewSessionModalOpen: false }),

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

      // --- draft 저장/삭제 ---

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

      // --- 검색 포커스 이벤트 ID ---

      setFocusEventId: (focusEventId) => set({ focusEventId }),

      // --- 대시보드 프로필 설정 ---

      setDashboardConfig: (dashboardConfig) => set({ dashboardConfig }),

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

      // --- 카탈로그 ---

      setCatalog: (catalog) =>
        set((state) => ({ catalog, catalogVersion: state.catalogVersion + 1 })),

      moveSessionsToFolder: (sessionIds, folderId) => {
        if (sessionIds.length === 0) return;
        const { catalog } = get();
        if (!catalog) return;
        const updatedSessions = { ...catalog.sessions };
        for (const id of sessionIds) {
          if (updatedSessions[id]) {
            updatedSessions[id] = { ...updatedSessions[id], folderId };
          }
        }
        set((state) => ({
          catalog: { ...catalog, sessions: updatedSessions },
          catalogVersion: state.catalogVersion + 1,
        }));
      },

      renameSession: (sessionId, displayName) => {
        const { catalog } = get();
        if (!catalog || !catalog.sessions[sessionId]) return;
        set((state) => ({
          catalog: {
            ...catalog,
            sessions: {
              ...catalog.sessions,
              [sessionId]: { ...catalog.sessions[sessionId], displayName },
            },
          },
          catalogVersion: state.catalogVersion + 1,
        }));
      },

      addFolder: (folder) => {
        const { catalog } = get();
        if (!catalog) return;
        set((state) => ({
          catalog: { ...catalog, folders: [...catalog.folders, folder] },
          catalogVersion: state.catalogVersion + 1,
        }));
      },

      updateFolderName: (folderId, name) => {
        const { catalog } = get();
        if (!catalog) return;
        set((state) => ({
          catalog: {
            ...catalog,
            folders: catalog.folders.map((f) =>
              f.id === folderId ? { ...f, name } : f,
            ),
          },
          catalogVersion: state.catalogVersion + 1,
        }));
      },

      removeFolder: (folderId) => {
        const { catalog } = get();
        if (!catalog) return;
        const updatedSessions = { ...catalog.sessions };
        for (const [id, assignment] of Object.entries(updatedSessions)) {
          if (assignment.folderId === folderId) {
            updatedSessions[id] = { ...assignment, folderId: null };
          }
        }
        set((state) => ({
          catalog: {
            ...catalog,
            folders: catalog.folders.filter((f) => f.id !== folderId),
            sessions: updatedSessions,
          },
          catalogVersion: state.catalogVersion + 1,
        }));
      },

      selectFolder: (folderId) => set({ selectedFolderId: folderId }),

      setMobileView: (mobileView) => set({ mobileView }),

      clearActiveSession: () => {
        // selectedFolderId를 유지하면서 세션 관련 상태만 초기화
        const { selectedFolderId } = get();
        set({
          ...getSessionResetState(),
          activeSessionKey: null,
          activeSession: null,
          selectedFolderId,
        });
      },

      toggleSessionSelection: (id, ctrlKey, shiftKey) => {
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
          const folder = state.getSessionsInFolder(state.selectedFolderId);
          const lastIdx = folder.findIndex((s) => s.agentSessionId === state.lastSelectedSessionId);
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

      getSessionsInFolder: (folderId) => {
        const { sessions, catalog } = get();
        if (!catalog?.sessions) return sessions;
        return sessions.filter((s) => {
          const assignment = catalog.sessions[s.agentSessionId];
          if (folderId === null) {
            // 미분류: 카탈로그에 없거나 folderId가 null인 세션
            return !assignment || assignment.folderId === null;
          }
          return assignment?.folderId === folderId;
        }).map((s) => {
          const assignment = catalog.sessions[s.agentSessionId];
          if (assignment?.displayName) {
            return { ...s, displayName: assignment.displayName };
          }
          return s;
        });
      },
    }),
    {
      name: "soul-dashboard-storage",
      // 스토리지 모드 + 입력창 draft 영속화 (세션 데이터는 제외)
      partialize: (state) => ({ storageMode: state.storageMode, drafts: state.drafts }),
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

