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
  SessionStatus,
  SessionDetail,
  DashboardCard,
  SoulSSEEvent,
  EventTreeNode,
  SubagentStartEvent,
  SubagentStopEvent,
  ToolStartEvent,
  ToolResultEvent,
  TextStartEvent,
  ResultEvent,
  ThinkingEvent,
} from "@shared/types";
import type { StorageMode } from "../providers/types";

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

  /** 선택된 React Flow 노드 ID (tool_call/tool_result 구분용) */
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

  // 카드 선택 (nodeId: React Flow 노드의 고유 ID, tool_call/tool_result 구분에 사용)
  selectCard: (cardId: string | null, nodeId?: string | null) => void;

  // 이벤트 노드 선택 (user/intervention/system/result 등 카드가 아닌 노드)
  selectEventNode: (data: SelectedEventNodeData | null, nodeId?: string | null) => void;

  // SSE 이벤트 처리
  processEvent: (event: SoulSSEEvent, eventId: number) => void;

  // 낙관적 세션 추가 (세션 생성 직후 즉시 목록 반영)
  addOptimisticSession: (agentSessionId: string, prompt: string) => void;

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
}

// === Internal Maps (closure 변수, state 아님) ===

/** ID → 노드 (O(1) 탐색) */
let nodeMap = new Map<string, EventTreeNode>();
/** toolUseId → tool 노드 */
let toolUseMap = new Map<string, EventTreeNode>();
/** agent_id → subagent 노드 */
let subagentMap = new Map<string, EventTreeNode>();
/** SSE card_id → text 노드 */
let cardIdMap = new Map<string, EventTreeNode>();
/** 현재 활성 user_message/intervention 노드 ID */
let currentTurnNodeId: string | null = null;

/** processEvent에서 알림 대상 이벤트 타입 (모듈 스코프: 매 호출 재생성 방지) */
const NOTIFY_TYPES = new Set(["complete", "error", "intervention_sent"]);

function resetInternalMaps() {
  nodeMap = new Map();
  toolUseMap = new Map();
  subagentMap = new Map();
  cardIdMap = new Map();
  currentTurnNodeId = null;
}

/**
 * parent_tool_use_id로 부모 노드를 결정합니다.
 * - null/undefined → 현재 턴 루트 (없으면 session root)
 * - "toolu_X" → toolUseMap에서 tool 노드 → 그 자식 subagent 반환
 */
function resolveParent(parentToolUseId: string | null | undefined, root: EventTreeNode): EventTreeNode {
  if (!parentToolUseId) {
    // 루트 레벨 → 현재 턴 루트
    if (currentTurnNodeId) {
      const turn = nodeMap.get(currentTurnNodeId);
      if (turn) return turn;
    }
    return root;
  }

  // parent_tool_use_id → toolUseMap에서 해당 tool 노드 찾기
  const toolNode = toolUseMap.get(parentToolUseId);
  if (!toolNode) {
    insertOrphanError(root, "resolveParent", -1,
      `parent_tool_use_id="${parentToolUseId}" toolUseMap 매칭 실패`);
    return root;
  }

  // tool 노드의 subagent 자식 찾기 (1단계 탐색, 최대 1개)
  const subagent = toolNode.children.find(c => c.type === "subagent");
  if (subagent) return subagent;

  // subagent_start가 아직 안 왔을 수 있음 → tool 노드 자체 반환
  return toolNode;
}

// === Tree Helpers ===

/** 부모를 찾지 못한 이벤트에 대한 에러 노드를 root 상단에 삽입 */
function insertOrphanError(
  root: EventTreeNode,
  eventType: string,
  eventId: number,
  detail: string,
): void {
  const errorNode = createNode(
    `orphan-error-${eventId}`,
    "error",
    `[${eventType}] 부모 노드를 찾을 수 없음: ${detail}`,
    { completed: true, isError: true },
  );
  // root.children 맨 앞에 삽입 → flow 상단에 표시
  root.children.unshift(errorNode);
}

function createNode(
  id: string,
  type: EventTreeNode["type"],
  content: string,
  extra?: Partial<EventTreeNode>,
): EventTreeNode {
  const node: EventTreeNode = {
    id,
    type,
    children: [],
    content,
    completed: false,
    ...extra,
  };
  nodeMap.set(id, node);
  return node;
}

function ensureRoot(tree: EventTreeNode | null): EventTreeNode {
  if (tree) return tree;
  const root = createNode("root-session", "session", "");
  return root;
}

// === Initial State ===

const initialState: DashboardState = {
  storageMode: "sse",
  sessions: [],
  sessionsLoading: false,
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
  };
}

// === Store ===

export const useDashboardStore = create<DashboardState & DashboardActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      // --- 스토리지 모드 ---

      setStorageMode: (storageMode) => {
        resetInternalMaps();
        set({
          storageMode,
          sessions: [],
          sessionsLoading: false,
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

        resetInternalMaps();
        set({
          ...getSessionResetState(),
          activeSessionKey: key,
          activeSession: detail ?? null,
          isComposing: false,
          resumeTargetKey: null,
        });
      },

      // --- 카드 선택 ---

      selectCard: (cardId, nodeId) =>
        set({
          selectedCardId: cardId,
          selectedNodeId: nodeId ?? null,
          selectedEventNodeData: null,
        }),

      // --- 이벤트 노드 선택 ---

      selectEventNode: (data, nodeId) =>
        set({
          selectedEventNodeData: data,
          selectedCardId: null,
          selectedNodeId: nodeId ?? null,
        }),

      // --- SSE 이벤트 처리 ---
      // 트리에 in-place 변경 후 treeVersion++ 으로 리렌더 트리거

      processEvent: (event, eventId) => {
        const state = get();
        let root = state.tree;
        let updated = false;

        switch (event.type) {
          case "user_message": {
            root = ensureRoot(root);
            const node = createNode(
              `user-msg-${eventId}`,
              "user_message",
              event.text,
              { completed: true, user: event.user },
            );
            root.children.push(node);
            currentTurnNodeId = node.id;
            updated = true;
            break;
          }

          case "session": {
            root = ensureRoot(root);
            root.sessionId = event.session_id;
            root.content = event.session_id;
            updated = true;
            break;
          }

          case "intervention_sent": {
            root = ensureRoot(root);
            const node = createNode(
              `intervention-${eventId}`,
              "intervention",
              event.text,
              { completed: true, user: event.user },
            );
            root.children.push(node);
            currentTurnNodeId = node.id;
            updated = true;
            break;
          }

          case "thinking": {
            root = ensureRoot(root);
            const thinkingEvent = event as ThinkingEvent;
            const thinkingCardId = thinkingEvent.card_id || `thinking-${eventId}`;

            const parent = resolveParent(thinkingEvent.parent_tool_use_id, root);
            const thinkingNode = createNode(thinkingCardId, "thinking", thinkingEvent.thinking, {
              completed: true,
            });
            cardIdMap.set(thinkingCardId, thinkingNode);
            parent.children.push(thinkingNode);
            updated = true;
            break;
          }

          case "text_start": {
            root = ensureRoot(root);
            const textStartEvent = event as TextStartEvent;

            // card_id가 있고 cardIdMap에 있으면 → thinking 노드가 이미 존재
            // text_delta에서 thinking.textContent를 업데이트하므로 여기서는 마킹만
            if (textStartEvent.card_id && cardIdMap.has(textStartEvent.card_id)) {
              // thinking 노드가 이미 있음 → 별도 노드 생성 불필요
              updated = true;
              break;
            }

            // thinking 없이 text만 온 경우 → 부모에 독립 text 노드 생성
            const textNodeId = textStartEvent.card_id ?? `text-${eventId}`;
            const textParent = resolveParent(textStartEvent.parent_tool_use_id, root);
            const textNode = createNode(textNodeId, "text", "");
            if (textStartEvent.card_id) cardIdMap.set(textStartEvent.card_id, textNode);
            textParent.children.push(textNode);
            updated = true;
            break;
          }

          case "text_delta": {
            const targetNode = event.card_id ? cardIdMap.get(event.card_id) : null;
            if (targetNode) {
              if (targetNode.type === "thinking") {
                // thinking 노드의 가시적 텍스트 갱신
                targetNode.textContent = (targetNode.textContent ?? "") + event.text;
              } else {
                // 독립 text 노드의 content 갱신
                targetNode.content += event.text;
              }
              updated = true;
            }
            break;
          }

          case "text_end": {
            const targetNode = event.card_id ? cardIdMap.get(event.card_id) : null;
            if (targetNode) {
              targetNode.textCompleted = true;
              if (targetNode.type !== "thinking") {
                targetNode.completed = true;
              }
              updated = true;
            }
            break;
          }

          case "subagent_start": {
            root = ensureRoot(root);
            const subagentEvent = event as SubagentStartEvent;
            const subagentNode = createNode(subagentEvent.agent_id, "subagent", "", {
              agentId: subagentEvent.agent_id,
              agentType: subagentEvent.agent_type,
              parentToolUseId: subagentEvent.parent_tool_use_id,
            });
            subagentMap.set(subagentEvent.agent_id, subagentNode);

            // 부모 ToolUseBlock의 자식으로 연결
            // 서버가 toolu_* ID로 브릿지하므로 toolUseMap.get이 직접 성공해야 함
            const parentTool = toolUseMap.get(subagentEvent.parent_tool_use_id);
            if (parentTool) {
              parentTool.children.push(subagentNode);
            } else {
              // 서버가 parent_tool_use_id를 보냈으나 매칭 실패 → 에러 노드
              insertOrphanError(root, "subagent_start", eventId,
                `parent_tool_use_id="${subagentEvent.parent_tool_use_id}" toolUseMap 매칭 실패`);
              root.children.push(subagentNode);
            }
            updated = true;
            break;
          }

          case "subagent_stop": {
            const subagentStopEvent = event as SubagentStopEvent;
            const subagent = subagentMap.get(subagentStopEvent.agent_id);
            if (subagent) {
              subagent.completed = true;
            }
            subagentMap.delete(subagentStopEvent.agent_id);
            updated = true;
            break;
          }

          case "tool_start": {
            root = ensureRoot(root);
            const toolStartEvent = event as ToolStartEvent;
            const toolId = `tool-${eventId}`;
            const toolNode = createNode(toolId, "tool", "", {
              toolName: toolStartEvent.tool_name,
              toolInput: toolStartEvent.tool_input,
              toolUseId: toolStartEvent.tool_use_id,
              parentToolUseId: toolStartEvent.parent_tool_use_id,
            });

            if (toolStartEvent.tool_use_id) {
              toolUseMap.set(toolStartEvent.tool_use_id, toolNode);
            }

            // 부모 결정: card_id → thinking 자식 | 없으면 resolveParent
            const parentThinking = toolStartEvent.card_id
              ? cardIdMap.get(toolStartEvent.card_id)
              : null;
            if (parentThinking) {
              parentThinking.children.push(toolNode);
            } else {
              const parent = resolveParent(toolStartEvent.parent_tool_use_id, root);
              parent.children.push(toolNode);
            }
            updated = true;
            break;
          }

          case "tool_result": {
            const toolResultEvent = event as ToolResultEvent;

            // tool_use_id 정확 매칭만 (폴백 없음)
            const toolNode = toolResultEvent.tool_use_id
              ? toolUseMap.get(toolResultEvent.tool_use_id)
              : undefined;

            if (toolNode) {
              toolNode.toolResult = toolResultEvent.result;
              toolNode.isError = toolResultEvent.is_error;
              toolNode.durationMs = toolResultEvent.duration_ms;
              toolNode.completed = true;
              updated = true;
            }
            break;
          }

          case "complete": {
            root = ensureRoot(root);
            const turnNode = currentTurnNodeId ? nodeMap.get(currentTurnNodeId) : null;
            const completeNode = createNode(
              `complete-${eventId}`,
              "complete",
              event.result ?? "Session completed",
              { completed: true },
            );
            if (turnNode) {
              turnNode.children.push(completeNode);
            } else {
              root.children.push(completeNode);
            }
            updated = true;
            break;
          }

          case "error": {
            root = ensureRoot(root);
            const turnNode = currentTurnNodeId ? nodeMap.get(currentTurnNodeId) : null;
            const errorNode = createNode(
              `error-${eventId}`,
              "error",
              event.message,
              { completed: true, isError: true },
            );
            if (turnNode) {
              turnNode.children.push(errorNode);
            } else {
              root.children.push(errorNode);
            }
            updated = true;
            break;
          }

          case "result": {
            root = ensureRoot(root);
            const resultEvent = event as ResultEvent;
            const resultParent = resolveParent(resultEvent.parent_tool_use_id, root);
            const resultNode = createNode(
              `result-${eventId}`,
              "result",
              resultEvent.output || "Session completed",
              {
                completed: true,
                durationMs: resultEvent.duration_ms,
                usage: resultEvent.usage,
                totalCostUsd: resultEvent.total_cost_usd,
              },
            );
            resultParent.children.push(resultNode);
            updated = true;
            break;
          }

          default:
            break;
        }

        // 알림 큐에 이벤트 추가 (complete, error, intervention_sent)
        const shouldNotify = NOTIFY_TYPES.has(event.type);

        // 이벤트 타입에 따라 sessions 배열의 해당 세션 상태 갱신
        // - complete/result → "completed"
        // - error → "error"
        // - user_message/intervention_sent → "running" (resume 등 새 턴 시작)
        const derivedStatus: SessionStatus | null =
          event.type === "complete" || event.type === "result"
            ? "completed"
            : event.type === "error"
              ? "error"
              : event.type === "user_message" || event.type === "intervention_sent"
                ? "running"
                : null;

        let sessionsUpdate: { sessions: SessionSummary[] } | Record<string, never> = {};
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

        if (updated) {
          set({
            tree: root,
            treeVersion: state.treeVersion + 1,
            lastEventId: eventId,
            ...sessionsUpdate,
            ...(shouldNotify
              ? { pendingNotifications: [...state.pendingNotifications, event] }
              : {}),
          });
        } else {
          set({
            lastEventId: eventId,
            ...sessionsUpdate,
            ...(shouldNotify
              ? { pendingNotifications: [...state.pendingNotifications, event] }
              : {}),
          });
        }
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

      // --- 세션 생성/재개 ---

      startCompose: () => {
        resetInternalMaps();
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
        resetInternalMaps();
        set({
          tree: null,
          treeVersion: 0,
          lastEventId: 0,
          pendingNotifications: [],
          selectedCardId: null,
          selectedNodeId: null,
          selectedEventNodeData: null,
          collapsedNodeIds: new Set<string>(),
        });
      },

      // 하위 호환 alias
      clearCards() {
        get().clearTree();
      },

      reset: () => {
        resetInternalMaps();
        set({ ...initialState, collapsedNodeIds: new Set<string>() });
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

/** DashboardCard 호환 객체를 트리에서 생성합니다. */
export function treeNodeToCard(node: EventTreeNode): DashboardCard {
  return {
    cardId: node.id,
    type: node.type === "user_message"
      ? "user_message"
      : node.type === "intervention"
        ? "intervention"
        : node.type === "session"
          ? "session"
          : node.type === "complete"
            ? "complete"
            : node.type === "error"
              ? "error"
              : node.type === "tool"
                ? "tool"
                : "text",
    content: node.content,
    completed: node.completed,
    toolName: node.toolName,
    toolInput: node.toolInput,
    toolResult: node.toolResult,
    isError: node.isError,
    toolUseId: node.toolUseId,
    user: node.user,
    sessionId: node.sessionId,
  };
}
