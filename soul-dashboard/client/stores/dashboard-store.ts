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
} from "@shared/types";
import type { StorageMode } from "../providers/types";

// === State Interface ===

export interface DashboardState {
  /** 스토리지 모드: file(기본) 또는 serendipity */
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

  /** 선택된 이벤트 노드 데이터 (user/intervention 노드용, 카드 기반이 아닌 노드) */
  selectedEventNodeData: {
    nodeType: string;
    label: string;
    content: string;
  } | null;

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

  // 이벤트 노드 선택 (user/intervention 등 카드가 아닌 노드)
  selectEventNode: (data: {
    nodeType: string;
    label: string;
    content: string;
  } | null) => void;

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
/** 마지막 text 노드 ID (tool_start 부모 결정) */
let lastTextNodeId: string | null = null;

/** processEvent에서 알림 대상 이벤트 타입 (모듈 스코프: 매 호출 재생성 방지) */
const NOTIFY_TYPES = new Set(["complete", "error", "intervention_sent"]);

function resetInternalMaps() {
  nodeMap = new Map();
  toolUseMap = new Map();
  subagentMap = new Map();
  cardIdMap = new Map();
  currentTurnNodeId = null;
  lastTextNodeId = null;
}

/**
 * parent_tool_use_id로 해당하는 서브에이전트 노드를 찾습니다.
 * 서브에이전트의 parentToolUseId와 매칭합니다.
 */
function findSubagentByParentToolUseId(parentToolUseId: string): EventTreeNode | null {
  for (const subagent of subagentMap.values()) {
    if (subagent.parentToolUseId === parentToolUseId) {
      return subagent;
    }
  }
  return null;
}

/**
 * parent_tool_use_id를 기반으로 부모 노드를 결정합니다.
 * 1. parent_tool_use_id가 있으면 해당 서브에이전트를 찾음
 * 2. 없으면 currentTurnNode 또는 root 반환
 */
function findParentForNode(
  parentToolUseId: string | undefined,
  root: EventTreeNode,
): EventTreeNode {
  if (parentToolUseId) {
    const subagent = findSubagentByParentToolUseId(parentToolUseId);
    if (subagent) return subagent;
  }
  // 폴백: currentTurnNode 또는 root
  const turnNode = currentTurnNodeId ? nodeMap.get(currentTurnNodeId) : null;
  return turnNode ?? root;
}

// === Tree Helpers ===

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
  storageMode: "file",
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

      selectEventNode: (data) =>
        set({
          selectedEventNodeData: data,
          selectedCardId: null,
          selectedNodeId: null,
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
            lastTextNodeId = null;
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
            lastTextNodeId = null;
            updated = true;
            break;
          }

          case "text_start": {
            root = ensureRoot(root);
            const textStartEvent = event as TextStartEvent;

            // parent_tool_use_id가 있으면 서브에이전트 내부
            if (textStartEvent.parent_tool_use_id) {
              const parentSubagent = findSubagentByParentToolUseId(textStartEvent.parent_tool_use_id);
              if (parentSubagent) {
                const textNode = createNode(textStartEvent.card_id, "text", "");
                cardIdMap.set(textStartEvent.card_id, textNode);
                parentSubagent.children.push(textNode);
                lastTextNodeId = textNode.id;
                updated = true;
                break;
              }
            }

            // 기존 로직: currentTurnNode가 없으면 암시적 user_message 턴 생성
            if (!currentTurnNodeId) {
              const implicitTurn = createNode(
                `implicit-turn-${eventId}`,
                "user_message",
                "",
                { completed: true, user: "unknown" },
              );
              root.children.push(implicitTurn);
              currentTurnNodeId = implicitTurn.id;
            }
            const turnNode = nodeMap.get(currentTurnNodeId);
            if (turnNode) {
              const textNode = createNode(textStartEvent.card_id, "text", "");
              cardIdMap.set(textStartEvent.card_id, textNode);
              turnNode.children.push(textNode);
              lastTextNodeId = textNode.id;
              updated = true;
            }
            break;
          }

          case "text_delta": {
            const textNode = cardIdMap.get(event.card_id);
            if (textNode) {
              textNode.content += event.text;
              updated = true;
            }
            break;
          }

          case "text_end": {
            const textNode = cardIdMap.get(event.card_id);
            if (textNode) {
              textNode.completed = true;
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
            const parentTool = toolUseMap.get(subagentEvent.parent_tool_use_id);
            if (parentTool) {
              parentTool.children.push(subagentNode);
            } else {
              // 폴백: root에 추가
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

            // 부모 결정: parent_tool_use_id 기반
            if (toolStartEvent.parent_tool_use_id) {
              // 서브에이전트 내부 → 해당 서브에이전트의 자식
              const parentSubagent = findSubagentByParentToolUseId(toolStartEvent.parent_tool_use_id);
              if (parentSubagent) {
                parentSubagent.children.push(toolNode);
              } else {
                // 폴백: lastTextNode 또는 currentTurnNode 또는 root
                const parentText = lastTextNodeId ? nodeMap.get(lastTextNodeId) : null;
                if (parentText) {
                  parentText.children.push(toolNode);
                } else {
                  const turnNode = currentTurnNodeId ? nodeMap.get(currentTurnNodeId) : null;
                  if (turnNode) {
                    turnNode.children.push(toolNode);
                  } else {
                    root.children.push(toolNode);
                  }
                }
              }
            } else {
              // 루트 레벨: 기존 로직 유지 (lastTextNode → currentTurnNode → root)
              const parentText = lastTextNodeId ? nodeMap.get(lastTextNodeId) : null;
              if (parentText) {
                parentText.children.push(toolNode);
              } else {
                const turnNode = currentTurnNodeId ? nodeMap.get(currentTurnNodeId) : null;
                if (turnNode) {
                  turnNode.children.push(toolNode);
                } else {
                  root.children.push(toolNode);
                }
              }
            }
            updated = true;
            break;
          }

          case "tool_result": {
            const toolResultEvent = event as ToolResultEvent;
            let toolNode: EventTreeNode | undefined;

            // 1차: tool_use_id로 정확 매칭
            if (toolResultEvent.tool_use_id) {
              toolNode = toolUseMap.get(toolResultEvent.tool_use_id);
            }
            // 2차: card_id + tool_name으로 매칭
            if (!toolNode && toolResultEvent.card_id) {
              const parentText = cardIdMap.get(toolResultEvent.card_id);
              if (parentText) {
                toolNode = parentText.children.find(
                  (c) =>
                    c.type === "tool" &&
                    !c.completed &&
                    c.toolName === toolResultEvent.tool_name,
                );
              }
            }
            // 3차 폴백: 모든 tool 노드에서 미완료 + tool_name 매칭 (역순)
            if (!toolNode) {
              for (const [, node] of nodeMap) {
                if (
                  node.type === "tool" &&
                  !node.completed &&
                  node.toolName === toolResultEvent.tool_name
                ) {
                  toolNode = node;
                  // 가장 마지막 매칭을 사용하지 않고 첫 매칭으로 break
                  // (nodeMap 삽입 순서가 시간순이므로 마지막 매칭을 위해 계속 순회)
                }
              }
            }

            if (toolNode) {
              toolNode.toolResult = toolResultEvent.result;
              toolNode.isError = toolResultEvent.is_error;
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
            root.children.push(resultNode);
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
