/**
 * dashboard-store 테스트
 *
 * Zustand 스토어의 트리 기반 이벤트 처리 로직을 검증합니다.
 * 세션 키는 agentSessionId (예: "sess-xxx") 형식입니다.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { useDashboardStore } from "./dashboard-store";

/**
 * 평탄화 후(Phase 2-A §11.1 옵션 C) tree-utils.ts가 폐기되어 본 테스트는
 * 로컬 헬퍼로 노드를 lookup한다. 평탄화 후엔 root.children이 1depth 평면이라
 * 재귀가 1회만 도는 단순 순회이지만, 기존 테스트의 부모-자식 검증 표현을
 * 보존하기 위해 재귀 함수 형태를 유지한다.
 */
function findTreeNode(root: EventTreeNode | null, id: string): EventTreeNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findTreeNode(child, id);
    if (found) return found;
  }
  return null;
}
import { filterSessionsInFolder, type SessionPage } from "../hooks/session-stream-helpers";
import type {
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ToolStartEvent,
  ToolResultEvent,
  CompleteEvent,
  SessionSummary,
  CatalogState,
  SessionEvent,
  ErrorEvent,
  InterventionSentEvent,
  UserMessageEvent,
  ProgressEvent,
  MemoryEvent,
  EventTreeNode,
  SubagentStartEvent,
  SubagentStopEvent,
  ResultEvent,
  ThinkingEvent,
  ToolNode,
  SessionNode,
  ResultNode,
  TaskItem,
} from "../shared/types";

/** 트리에서 특정 타입의 모든 노드를 수집하는 헬퍼 */
function collectNodes(
  node: EventTreeNode | null,
  type?: EventTreeNode["type"],
): EventTreeNode[] {
  if (!node) return [];
  const result: EventTreeNode[] = [];
  if (!type || node.type === type) result.push(node);
  for (const child of node.children) {
    result.push(...collectNodes(child, type));
  }
  return result;
}

// === QueryClient 테스트 헬퍼 ===

/** addOptimisticSession 테스트용 QueryClient 생성 */
function makeTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** QueryClient에 초기 세션 데이터를 시드 */
function seedQueryClient(qc: QueryClient, sessions: import("../shared/types").SessionSummary[]) {
  qc.setQueryData<InfiniteData<SessionPage>>(["sessions"], {
    pages: [{ sessions, total: sessions.length }],
    pageParams: [0],
  });
}

/** QueryClient에 특정 세션 목록 queryKey로 초기 데이터를 시드 */
function seedQueryClientAt(
  qc: QueryClient,
  queryKey: readonly unknown[],
  sessions: import("../shared/types").SessionSummary[],
) {
  qc.setQueryData<InfiniteData<SessionPage>>(queryKey, {
    pages: [{ sessions, total: sessions.length }],
    pageParams: [0],
  });
}

/** QueryClient 캐시에서 세션 목록 조회 */
function getQuerySessions(qc: QueryClient): import("../shared/types").SessionSummary[] {
  const data = qc.getQueryData<InfiniteData<SessionPage>>(["sessions"]);
  return data?.pages.flatMap((p) => p.sessions) ?? [];
}

/** QueryClient 특정 queryKey 캐시에서 세션 목록 조회 */
function getQuerySessionsAt(
  qc: QueryClient,
  queryKey: readonly unknown[],
): import("../shared/types").SessionSummary[] {
  const data = qc.getQueryData<InfiniteData<SessionPage>>(queryKey);
  return data?.pages.flatMap((p) => p.sessions) ?? [];
}

describe("dashboard-store", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  // === 세션 관리 ===

  // === 활성 세션 ===

  describe("active session", () => {
    it("should set active session and clear tree", () => {
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent({ type: "text_start" } as TextStartEvent, 1);
      expect(useDashboardStore.getState().tree).not.toBeNull();

      useDashboardStore.getState().setActiveSession("sess-abc");
      expect(useDashboardStore.getState().activeSessionKey).toBe("sess-abc");
      expect(useDashboardStore.getState().tree).toBeNull();
      expect(useDashboardStore.getState().lastEventId).toBe(0);
      expect(useDashboardStore.getState().selectedCardId).toBeNull();
    });

    it("should clear active session when set to null", () => {
      useDashboardStore.getState().setActiveSession("sess-abc");
      useDashboardStore.getState().setActiveSession(null);
      expect(useDashboardStore.getState().activeSessionKey).toBeNull();
    });

    it("should not rewrite selected folder when selecting a session", () => {
      useDashboardStore.getState().setCatalog({
        folders: [
          { id: "folder-a", name: "Folder A", sortOrder: 0 },
          { id: "folder-b", name: "Folder B", sortOrder: 1 },
        ],
        sessions: {
          "sess-b": { folderId: "folder-b", displayName: null },
        },
      });
      useDashboardStore.getState().selectFolder("folder-a");

      useDashboardStore.getState().setActiveSession("sess-b");

      const state = useDashboardStore.getState();
      expect(state.activeSessionKey).toBe("sess-b");
      expect(state.selectedFolderId).toBe("folder-a");
      expect(state.viewMode).toBe("folder");
    });
  });

  // === 카드 선택 ===

  describe("selectCard", () => {
    it("should select and deselect card", () => {
      useDashboardStore.getState().selectCard("card-1");
      expect(useDashboardStore.getState().selectedCardId).toBe("card-1");

      useDashboardStore.getState().selectCard(null);
      expect(useDashboardStore.getState().selectedCardId).toBeNull();
    });

    it("should switch from chat to detail tab when selecting a card", () => {
      useDashboardStore.getState().setActiveRightTab("chat");
      useDashboardStore.getState().selectCard("card-1");
      expect(useDashboardStore.getState().activeRightTab).toBe("detail");
    });

    it("should NOT switch from info to detail tab when selecting a card", () => {
      useDashboardStore.getState().setActiveRightTab("info");
      useDashboardStore.getState().selectCard("card-1");
      expect(useDashboardStore.getState().activeRightTab).toBe("info");
    });

    it("should NOT switch tab when already on detail", () => {
      useDashboardStore.getState().setActiveRightTab("detail");
      useDashboardStore.getState().selectCard("card-1");
      expect(useDashboardStore.getState().activeRightTab).toBe("detail");
    });
  });

  // === SSE 이벤트 처리: 텍스트 카드 ===

  describe("processEvent - text card lifecycle", () => {
    it("should create text node on text_start", () => {
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      const tree = useDashboardStore.getState().tree;
      expect(tree).not.toBeNull();
      const textNodes = collectNodes(tree, "text");
      expect(textNodes).toHaveLength(1);
      expect(textNodes[0].id).toBe("text-1");
      expect(textNodes[0].content).toBe("");
      expect(textNodes[0].completed).toBe(false);
      expect(useDashboardStore.getState().lastEventId).toBe(1);
    });

    it("should accumulate text on text_delta", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Hello " } as TextDeltaEvent, 2);
      processEvent({ type: "text_delta", text: "World" } as TextDeltaEvent, 3);

      const textNode = findTreeNode(useDashboardStore.getState().tree, "text-1");
      expect(textNode?.content).toBe("Hello World");
      expect(textNode?.completed).toBe(false);
    });

    it("should mark completed on text_end", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Done" } as TextDeltaEvent, 2);
      processEvent({ type: "text_end" } as TextEndEvent, 3);

      const textNode = findTreeNode(useDashboardStore.getState().tree, "text-1");
      expect(textNode?.content).toBe("Done");
      expect(textNode?.completed).toBe(true);
      expect(useDashboardStore.getState().lastEventId).toBe(3);
    });
  });

  // === SSE 이벤트 처리: 도구 카드 ===

  describe("processEvent - tool card lifecycle", () => {
    it("should create tool node on tool_start", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
        tool_use_id: "toolu_abc",
        parent_event_id: "0",
      } as ToolStartEvent;
      processEvent(event, 10);

      const toolNode = findTreeNode(useDashboardStore.getState().tree, "tool-10");
      expect(toolNode).not.toBeNull();
      expect(toolNode!.type).toBe("tool");
      expect((toolNode as ToolNode).toolName).toBe("Read");
      expect((toolNode as ToolNode).toolInput).toEqual({ file_path: "/test.ts" });
      expect((toolNode as ToolNode).toolUseId).toBe("toolu_abc");
      expect(toolNode!.completed).toBe(false);
    });

    it("should complete tool node on tool_result", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_bash1",
        parent_event_id: "0",
      } as ToolStartEvent, 2);
      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "file1.txt\nfile2.txt",
        is_error: false,
        tool_use_id: "toolu_bash1",
      } as ToolResultEvent, 3);

      const toolNode = findTreeNode(useDashboardStore.getState().tree, "tool-2");
      expect((toolNode as ToolNode).toolResult).toBe("file1.txt\nfile2.txt");
      expect((toolNode as ToolNode).isError).toBe(false);
      expect(toolNode?.completed).toBe(true);
    });

    it("should handle tool error", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: { command: "invalid" },
        tool_use_id: "toolu_bash2",
        parent_event_id: "0",
      } as ToolStartEvent, 2);
      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "command not found",
        is_error: true,
        tool_use_id: "toolu_bash2",
      } as ToolResultEvent, 3);

      const toolNode = findTreeNode(useDashboardStore.getState().tree, "tool-2");
      expect((toolNode as ToolNode).isError).toBe(true);
      expect(toolNode?.completed).toBe(true);
    });

    it("tool_start → parent_event_id로 user_message에 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: {},
        parent_event_id: "0",
      } as ToolStartEvent, 42);

      const tree = useDashboardStore.getState().tree!;
      const toolNode = findTreeNode(tree, "tool-42");
      expect(toolNode).not.toBeNull();

      // Phase 2-A 평탄화: 모든 노드는 root.children에 시간순 push
      const userMsg = tree.children[0];
      expect(userMsg.type).toBe("user_message");
      expect(tree.children.some(c => c.id === "tool-42")).toBe(true);

      // 에러 노드 없음
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes).toHaveLength(0);
    });

    it("tool_result without tool_use_id is silently ignored (no fallback matching)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
        tool_use_id: "tu1",
        parent_event_id: "0",
      } as ToolStartEvent, 10);

      // tool_result without tool_use_id → no match (fallback removed)
      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "hello",
        is_error: false,
      } as ToolResultEvent, 11);

      const toolNodes = collectNodes(useDashboardStore.getState().tree, "tool");
      expect(toolNodes).toHaveLength(1);
      // tool_use_id가 없는 tool_result는 매칭 실패 → tool은 미완료 상태 유지
      expect(toolNodes[0].completed).toBe(false);
      expect((toolNodes[0] as ToolNode).toolResult).toBeUndefined();
    });

    it("tool_result with matching tool_use_id completes the tool", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "tu1",
        parent_event_id: "0",
      } as ToolStartEvent, 2);

      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "done",
        is_error: false,
        tool_use_id: "tu1",
      } as ToolResultEvent, 3);

      const toolNodes = collectNodes(useDashboardStore.getState().tree, "tool");
      expect(toolNodes).toHaveLength(1);
      expect(toolNodes[0].completed).toBe(true);
      expect((toolNodes[0] as ToolNode).toolResult).toBe("done");
    });
  });

  // === 무시되는 이벤트 ===

  describe("processEvent - ignored events", () => {
    it("should update lastEventId for unhandled event types", () => {
      const event: ProgressEvent = { type: "progress", text: "working..." };
      useDashboardStore.getState().processEvent(event, 99);

      expect(useDashboardStore.getState().tree).toBeNull();
      expect(useDashboardStore.getState().lastEventId).toBe(99);
    });
  });

  // === 복합 시나리오 ===

  describe("mixed card sequence", () => {
    it("should handle interleaved text and tool cards", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);

      // Text card 1
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Analyzing..." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end" } as TextEndEvent, 3);

      // Tool card (parent_event_id: "0" → user_message)
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_bash1",
        parent_event_id: "0",
      } as ToolStartEvent, 4);
      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "ok",
        is_error: false,
        tool_use_id: "toolu_bash1",
      } as ToolResultEvent, 5);

      // Text card 2
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 6);
      processEvent({ type: "text_delta", text: "Done!" } as TextDeltaEvent, 7);

      const tree = useDashboardStore.getState().tree!;
      const textNodes = collectNodes(tree, "text");
      expect(textNodes).toHaveLength(2);
      expect(textNodes[0].id).toBe("text-1");
      expect(textNodes[0].completed).toBe(true);
      expect(textNodes[1].id).toBe("text-6");
      expect(textNodes[1].completed).toBe(false);

      const toolNodes = collectNodes(tree, "tool");
      expect(toolNodes).toHaveLength(1);
      expect(toolNodes[0].id).toBe("tool-4");
      expect(toolNodes[0].completed).toBe(true);
      expect((toolNodes[0] as ToolNode).toolUseId).toBe("toolu_bash1");

      // Phase 2-A 평탄화: tool-4는 root.children에 user_message와 형제로 push (parent_event_id 무시)
      const userMsg = tree.children[0];
      expect(userMsg.type).toBe("user_message");
      expect(tree.children.some((c) => c.id === "tool-4")).toBe(true);
    });
  });

  // === 트리 구조 검증 ===

  describe("tree structure", () => {
    it("user_message is root's child", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hello" } as UserMessageEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      expect(tree.type).toBe("session");
      expect(tree.children).toHaveLength(1);
      expect(tree.children[0].type).toBe("user_message");
      expect(tree.children[0].content).toBe("hello");
    });

    it("Phase 2-A 평탄화: text는 root.children에 user_message와 형제로 push", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      expect(tree.children).toHaveLength(2);
      expect(tree.children[0].type).toBe("user_message");
      expect(tree.children[1].type).toBe("text");
    });

    it("Phase 2-A 평탄화: tool은 root.children에 push (parent_event_id 무시)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: {},
        parent_event_id: "0",
      } as ToolStartEvent, 2);

      const tree = useDashboardStore.getState().tree!;
      expect(tree.children.some(c => c.type === "tool")).toBe(true);
    });

    it("Phase 2-A 평탄화: complete은 root.children에 push", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "complete", result: "done", attachments: [], parent_event_id: "0" } as CompleteEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      expect(tree.children.some((c) => c.type === "complete")).toBe(true);
    });

    it("intervention is root's child (sibling of user_message)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "intervention_sent", user: "admin", text: "stop" } as InterventionSentEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      expect(tree.children).toHaveLength(2);
      expect(tree.children[0].type).toBe("user_message");
      expect(tree.children[1].type).toBe("intervention");
    });

    it("resume creates a sibling user_message", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "first" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 2);
      processEvent({ type: "complete", result: "done", attachments: [], parent_event_id: "0" } as CompleteEvent, 3);

      // Resume: new user_message
      processEvent({ type: "user_message", user: "u", text: "resume" } as UserMessageEvent, 4);
      processEvent({ type: "text_start", parent_event_id: "4" } as TextStartEvent, 5);

      const tree = useDashboardStore.getState().tree!;
      const userMsgs = tree.children.filter((c) => c.type === "user_message");
      expect(userMsgs).toHaveLength(2);
      expect(userMsgs[0].content).toBe("first");
      expect(userMsgs[1].content).toBe("resume");

      // Phase 2-A 평탄화: text-5는 root.children에 push (두 번째 user_message와 형제)
      expect(tree.children.some((c) => c.id === "text-5")).toBe(true);
    });

    it("session event sets root sessionId", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "session", session_id: "s1" } as SessionEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      expect((tree as SessionNode).sessionId).toBe("s1");
    });
  });

  // === 이벤트 노드 선택 ===

  describe("selectEventNode", () => {
    it("should set selectedEventNodeData and clear card/node selection", () => {
      useDashboardStore.getState().selectCard("card-1", "node-1");
      expect(useDashboardStore.getState().selectedCardId).toBe("card-1");
      expect(useDashboardStore.getState().selectedNodeId).toBe("node-1");

      const eventNodeData = {
        nodeType: "user" as const,
        label: "User Message",
        content: "Hello world",
      };
      useDashboardStore.getState().selectEventNode(eventNodeData);

      const state = useDashboardStore.getState();
      expect(state.selectedEventNodeData).toEqual(eventNodeData);
      expect(state.selectedCardId).toBeNull();
      expect(state.selectedNodeId).toBeNull();
    });

    it("should handle intervention node data", () => {
      const interventionData = {
        nodeType: "intervention" as const,
        label: "Operator",
        content: "Please stop",
      };
      useDashboardStore.getState().selectEventNode(interventionData);

      const state = useDashboardStore.getState();
      expect(state.selectedEventNodeData).toEqual(interventionData);
    });

    it("should clear selectedEventNodeData when set to null", () => {
      useDashboardStore.getState().selectEventNode({
        nodeType: "user",
        label: "msg",
        content: "text",
      });
      expect(useDashboardStore.getState().selectedEventNodeData).not.toBeNull();

      useDashboardStore.getState().selectEventNode(null);
      expect(useDashboardStore.getState().selectedEventNodeData).toBeNull();
    });

    it("should switch from chat to detail tab when selecting event node", () => {
      useDashboardStore.getState().setActiveRightTab("chat");
      useDashboardStore.getState().selectEventNode({
        nodeType: "user",
        label: "User",
        content: "hello",
      });
      expect(useDashboardStore.getState().activeRightTab).toBe("detail");
    });

    it("should NOT switch from info to detail tab when selecting event node", () => {
      useDashboardStore.getState().setActiveRightTab("info");
      useDashboardStore.getState().selectEventNode({
        nodeType: "user",
        label: "User",
        content: "hello",
      });
      expect(useDashboardStore.getState().activeRightTab).toBe("info");
    });
  });


  // === New Session 모달 ===

  describe("openNewSessionModal / closeNewSessionModal", () => {
    it("should open and close the new session modal", () => {
      expect(useDashboardStore.getState().isNewSessionModalOpen).toBe(false);

      useDashboardStore.getState().openNewSessionModal();
      expect(useDashboardStore.getState().isNewSessionModalOpen).toBe(true);

      useDashboardStore.getState().closeNewSessionModal();
      expect(useDashboardStore.getState().isNewSessionModalOpen).toBe(false);
    });

    it("should keep and clear the parent task for task-scoped new sessions", () => {
      const parentTask = {
        id: "task-parent",
        title: "Parent",
        status: "in_progress",
      } as TaskItem;

      useDashboardStore.getState().openNewSessionModal("feed", parentTask);
      expect(useDashboardStore.getState().newSessionParentTask).toBe(parentTask);

      useDashboardStore.getState().closeNewSessionModal();
      expect(useDashboardStore.getState().newSessionParentTask).toBeNull();
    });

    it("should keep and clear new session defaults", () => {
      useDashboardStore.getState().openNewSessionModal("feed", null, {
        folderId: "folder-parent",
        nodeId: "node-parent",
        agentId: "agent-parent",
      });

      expect(useDashboardStore.getState().newSessionDefaults).toEqual({
        folderId: "folder-parent",
        nodeId: "node-parent",
        agentId: "agent-parent",
      });

      useDashboardStore.getState().closeNewSessionModal();
      expect(useDashboardStore.getState().newSessionDefaults).toBeNull();
    });
  });

  // === addOptimisticSession ===

  describe("addOptimisticSession", () => {
    it("should add session and set it as active", () => {
      const qc = makeTestQueryClient();
      useDashboardStore.getState().addOptimisticSession(qc, "sess-new", "hello");
      const state = useDashboardStore.getState();

      expect(state.activeSessionSummary?.agentSessionId).toBe("sess-new");
      expect(state.activeSessionSummary?.prompt).toBe("hello");
      expect(state.activeSessionKey).toBe("sess-new");
    });

    it("should not duplicate session if already exists", () => {
      const qc = makeTestQueryClient();
      seedQueryClient(qc, [{ agentSessionId: "sess-new", status: "running", eventCount: 0, createdAt: "2026-01-01T00:00:00Z", prompt: "hello" }]);

      useDashboardStore.getState().addOptimisticSession(qc, "sess-new", "hello again");

      expect(getQuerySessions(qc)).toHaveLength(1);
    });
  });

  // === clearTree ===

  describe("clearTree", () => {
    it("should clear tree and related state", () => {
      const { processEvent, selectCard } =
        useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "content" } as TextDeltaEvent, 2);
      processEvent({ type: "session", session_id: "s1" } as SessionEvent, 3);
      selectCard("t1", "node-t1");
      useDashboardStore.getState().selectEventNode({
        nodeType: "user",
        label: "msg",
        content: "hello",
      });

      expect(useDashboardStore.getState().tree).not.toBeNull();
      expect(useDashboardStore.getState().lastEventId).toBeGreaterThan(0);

      useDashboardStore.getState().clearTree();
      const state = useDashboardStore.getState();

      expect(state.tree).toBeNull();
      expect(state.treeVersion).toBe(0);
      expect(state.lastEventId).toBe(0);
      expect(state.selectedCardId).toBeNull();
      expect(state.selectedNodeId).toBeNull();
      expect(state.selectedEventNodeData).toBeNull();
    });

    it("should not affect activeSessionKey", () => {
      useDashboardStore.getState().setActiveSession("sess-abc");
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent({ type: "text_start" } as TextStartEvent, 1);

      useDashboardStore.getState().clearTree();

      expect(useDashboardStore.getState().activeSessionKey).toBe("sess-abc");
    });
  });

  // === 낙관적 세션 추가 ===

  describe("addOptimisticSession", () => {
    it("should prepend new session to queryClient cache", () => {
      const qc = makeTestQueryClient();
      seedQueryClient(qc, [
        { agentSessionId: "sess-old", status: "completed", eventCount: 10, createdAt: "2026-01-01T00:00:00Z" },
      ]);

      useDashboardStore.getState().addOptimisticSession(qc, "sess-new", "hello");
      const sessions = getQuerySessions(qc);

      expect(sessions).toHaveLength(2);
      expect(sessions[0].agentSessionId).toBe("sess-new");
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].eventCount).toBe(0);
      expect(sessions[0].prompt).toBe("hello");
      expect(sessions[1].agentSessionId).toBe("sess-old");
    });

    it("should not duplicate if session already exists in cache", () => {
      const qc = makeTestQueryClient();
      seedQueryClient(qc, [
        { agentSessionId: "sess-abc", status: "running", eventCount: 3, createdAt: "2026-01-01T00:00:00Z" },
      ]);

      useDashboardStore.getState().addOptimisticSession(qc, "sess-abc", "dup");
      expect(getQuerySessions(qc)).toHaveLength(1);
    });

    it("should assign folderId in catalog.sessions when folderId is provided", () => {
      const catalog: CatalogState = {
        folders: [{ id: "folder-1", name: "Test Folder", sortOrder: 0 }],
        sessions: {},
      };
      useDashboardStore.getState().setCatalog(catalog);

      const qc = makeTestQueryClient();
      useDashboardStore.getState().addOptimisticSession(qc, "sess-folder", "hi", "folder-1");
      const state = useDashboardStore.getState();

      expect(state.catalog?.sessions["sess-folder"]).toEqual({
        folderId: "folder-1",
        displayName: null,
      });
      // activeSessionSummary로 새 세션 확인
      expect(state.activeSessionSummary?.agentSessionId).toBe("sess-folder");
    });

    it("should not modify catalog.sessions when folderId is null/undefined", () => {
      const catalog: CatalogState = {
        folders: [{ id: "folder-1", name: "Test Folder", sortOrder: 0 }],
        sessions: { "sess-existing": { folderId: "folder-1", displayName: null } },
      };
      useDashboardStore.getState().setCatalog(catalog);

      const qc = makeTestQueryClient();
      useDashboardStore.getState().addOptimisticSession(qc, "sess-no-folder", "hi");
      const state = useDashboardStore.getState();

      // 기존 catalog.sessions는 그대로, 새 세션에 대한 할당은 없음
      expect(state.catalog?.sessions["sess-no-folder"]).toBeUndefined();
      expect(state.catalog?.sessions["sess-existing"]).toEqual({
        folderId: "folder-1",
        displayName: null,
      });
    });

    it("should include nodeId when provided", () => {
      const qc = makeTestQueryClient();
      useDashboardStore.getState().addOptimisticSession(qc, "sess-node", "hi", null, "silent-manari");

      expect(useDashboardStore.getState().activeSessionSummary?.agentSessionId).toBe("sess-node");
      expect(useDashboardStore.getState().activeSessionSummary?.nodeId).toBe("silent-manari");
    });

    it("should include agent backend when provided", () => {
      const qc = makeTestQueryClient();
      seedQueryClient(qc, []);

      useDashboardStore.getState().addOptimisticSession(
        qc,
        "sess-backend",
        "hi",
        "folder-1",
        "node-1",
        "codex-default",
        "Codex Default",
        "/api/nodes/node-1/agents/codex-default/portrait",
        "codex",
      );

      expect(useDashboardStore.getState().activeSessionSummary?.backend).toBe("codex");
      expect(getQuerySessions(qc)[0].backend).toBe("codex");
    });

    it("should only prepend a folder-scoped optimistic session to matching folder caches", () => {
      const qc = makeTestQueryClient();
      const feedKey = ["sessions", "all", "feed", null] as const;
      const folderAKey = ["sessions", "all", "folder", "folder-A"] as const;
      const folderBKey = ["sessions", "all", "folder", "folder-B"] as const;
      seedQueryClientAt(qc, feedKey, []);
      seedQueryClientAt(qc, folderAKey, []);
      seedQueryClientAt(qc, folderBKey, []);

      useDashboardStore
        .getState()
        .addOptimisticSession(qc, "sess-folder-a", "hi", "folder-A");

      expect(getQuerySessionsAt(qc, feedKey).map((s) => s.agentSessionId)).toEqual([
        "sess-folder-a",
      ]);
      expect(getQuerySessionsAt(qc, folderAKey).map((s) => s.agentSessionId)).toEqual([
        "sess-folder-a",
      ]);
      expect(getQuerySessionsAt(qc, folderBKey)).toHaveLength(0);
    });

    it("should not prepend an excluded-folder optimistic session to the feed cache", () => {
      const qc = makeTestQueryClient();
      const feedKey = ["sessions", "all", "feed", null] as const;
      const hiddenFolderKey = ["sessions", "all", "folder", "hidden-folder"] as const;
      seedQueryClientAt(qc, feedKey, []);
      seedQueryClientAt(qc, hiddenFolderKey, []);
      useDashboardStore.getState().setCatalog({
        folders: [
          {
            id: "hidden-folder",
            name: "Hidden",
            sortOrder: 0,
            settings: { excludeFromFeed: true },
          },
        ],
        sessions: {},
      });

      useDashboardStore
        .getState()
        .addOptimisticSession(qc, "sess-hidden", "hi", "hidden-folder");

      expect(getQuerySessionsAt(qc, feedKey)).toHaveLength(0);
      expect(getQuerySessionsAt(qc, hiddenFolderKey).map((s) => s.agentSessionId)).toEqual([
        "sess-hidden",
      ]);
    });

    it("should include dashboard user profile in optimistic summary", () => {
      const qc = makeTestQueryClient();
      seedQueryClient(qc, []);
      useDashboardStore.setState({
        dashboardConfig: {
          user: {
            id: "user-1",
            name: "Jubok Kim",
            hasPortrait: true,
            portraitUrl: "https://example.com/avatar.png",
          },
          agents: [],
        },
      });

      useDashboardStore.getState().addOptimisticSession(qc, "sess-profile", "hi");

      expect(useDashboardStore.getState().activeSessionSummary?.userName).toBe("Jubok Kim");
      expect(useDashboardStore.getState().activeSessionSummary?.userPortraitUrl).toBe("https://example.com/avatar.png");
      expect(getQuerySessions(qc)[0].userPortraitUrl).toBe("https://example.com/avatar.png");
    });

    it("should not include nodeId when not provided", () => {
      const qc = makeTestQueryClient();
      useDashboardStore.getState().addOptimisticSession(qc, "sess-no-node", "hi");

      expect(useDashboardStore.getState().activeSessionSummary?.agentSessionId).toBe("sess-no-node");
      expect(useDashboardStore.getState().activeSessionSummary?.nodeId).toBeUndefined();
    });

    it("should place session in correct folder via catalog assignment and filterSessionsInFolder", () => {
      const catalog: CatalogState = {
        folders: [{ id: "folder-1", name: "Test Folder", sortOrder: 0 }],
        sessions: {},
      };
      useDashboardStore.getState().setCatalog(catalog);

      const qc = makeTestQueryClient();
      // queryClient에 빈 페이지를 시드해야 setQueriesData updater가 동작함
      seedQueryClient(qc, []);
      useDashboardStore.getState().addOptimisticSession(qc, "sess-in-folder", "hi", "folder-1");
      const updatedCatalog = useDashboardStore.getState().catalog;
      const querySessions = getQuerySessions(qc);

      // filterSessionsInFolder로 폴더 기준 필터링 확인
      const inFolder = filterSessionsInFolder(querySessions, updatedCatalog, "folder-1");
      const inUncategorized = filterSessionsInFolder(querySessions, updatedCatalog, null);

      expect(inFolder).toHaveLength(1);
      expect(inFolder[0].agentSessionId).toBe("sess-in-folder");
      expect(inUncategorized).toHaveLength(0);
    });

    it("should switch selectedFolderId to the new session's folder", () => {
      // 초기 폴더 선택: 'other-folder'
      useDashboardStore.getState().selectFolder("other-folder");
      expect(useDashboardStore.getState().selectedFolderId).toBe("other-folder");

      const qc = makeTestQueryClient();
      useDashboardStore.getState().addOptimisticSession(qc, "sess-new", "hi", "folder-1");

      const state = useDashboardStore.getState();
      expect(state.selectedFolderId).toBe("folder-1");
      expect(state.viewMode).toBe("folder");
    });

    it("should switch selectedFolderId to null when folderId is null (uncategorized)", () => {
      // 초기 폴더 선택: 'folder-1'
      useDashboardStore.getState().selectFolder("folder-1");
      expect(useDashboardStore.getState().selectedFolderId).toBe("folder-1");

      const qc = makeTestQueryClient();
      useDashboardStore.getState().addOptimisticSession(qc, "sess-new", "hi", null);

      const state = useDashboardStore.getState();
      expect(state.selectedFolderId).toBeNull();
      expect(state.viewMode).toBe("folder");
    });

    it("should not change selectedFolderId when folderId is undefined", () => {
      // 초기 폴더 선택: 'folder-1'
      useDashboardStore.getState().selectFolder("folder-1");
      expect(useDashboardStore.getState().selectedFolderId).toBe("folder-1");

      // folderId 인자 생략 (undefined)
      const qc = makeTestQueryClient();
      useDashboardStore.getState().addOptimisticSession(qc, "sess-new", "hi");

      expect(useDashboardStore.getState().selectedFolderId).toBe("folder-1");
    });
  });

  // === 멀티턴 세션 상태 전환 ===

  describe("processEvent - session status derivation (multi-turn)", () => {
    beforeEach(() => {
      // 활성 세션 설정
      useDashboardStore.getState().setActiveSession("sess-mt");

      // history_sync를 보내 히스토리 리플레이 완료 상태로 전환
      // (리플레이 중에는 status 갱신이 억제되므로, 라이브 이벤트 테스트 전에 필수)
      useDashboardStore.getState().processEvent(
        { type: "history_sync", last_event_id: 0, is_live: true, status: "running" } as any,
        -1,
      );
    });

    it("should not mark the session completed on a turn complete event", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 2);
      const result = processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 3);
      expect(result).toBeNull();
    });

    it("should not mark the session errored on a turn error event", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      const result = processEvent({ type: "error", message: "failed" } as ErrorEvent, 1);
      expect(result).toBeNull();
    });

    it("should keep user_message as the resume/running signal after complete", () => {
      const { processEvent } = useDashboardStore.getState();

      // Turn 1: user_message → text → complete
      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 2);
      const r1 = processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 3);
      expect(r1).toBeNull();

      // Turn 2: new user_message (resume) → status는 반환값으로 확인
      const r2 = processEvent({ type: "user_message", user: "u", text: "Turn 2" } as UserMessageEvent, 4);
      expect(r2?.status).toBe("running");
    });

    it("should keep intervention_sent as the resume/running signal after complete", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      const r1 = processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 1);
      expect(r1).toBeNull();

      // Intervention resumes the session → status는 반환값으로 확인
      const r2 = processEvent({ type: "intervention_sent", user: "admin", text: "continue" } as InterventionSentEvent, 2);
      expect(r2?.status).toBe("running");
    });

    it("should handle full multi-turn cycle without deriving terminal status from turn complete", () => {
      const { processEvent } = useDashboardStore.getState();

      // Turn 1: user_message → running
      const rUser1 = processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      expect(rUser1?.status).toBe("running");

      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 2);
      const rComplete1 = processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 3);
      expect(rComplete1).toBeNull();

      // Turn 2: user_message → running
      const rUser2 = processEvent({ type: "user_message", user: "u", text: "Turn 2" } as UserMessageEvent, 4);
      expect(rUser2?.status).toBe("running");

      processEvent({ type: "text_start" } as TextStartEvent, 5);
      processEvent({ type: "text_end" } as TextEndEvent, 6);
      const rComplete2 = processEvent({ type: "complete", result: "done again", attachments: [] } as CompleteEvent, 7);
      expect(rComplete2).toBeNull();
    });

    it("should not update status for unrelated event types (text_start, text_delta, etc.)", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);

      // These should NOT change status — processEvent returns null for non-status events
      const r1 = processEvent({ type: "text_start" } as TextStartEvent, 1);
      const r2 = processEvent({ type: "text_delta", text: "hello" } as TextDeltaEvent, 2);
      const r3 = processEvent({ type: "text_end" } as TextEndEvent, 3);
      const r4 = processEvent({ type: "tool_start", timestamp: 0, tool_name: "Bash", tool_input: {} } as ToolStartEvent, 4);
      const r5 = processEvent({ type: "tool_result", tool_name: "Bash", result: "ok", is_error: false } as ToolResultEvent, 5);

      expect(r1).toBeNull();
      expect(r2).toBeNull();
      expect(r3).toBeNull();
      expect(r4).toBeNull();
      expect(r5).toBeNull();
    });

    it("should not update status when activeSessionKey is null", () => {
      useDashboardStore.getState().setActiveSession(null);
      const result = useDashboardStore.getState().processEvent(
        { type: "complete", result: "done", attachments: [] } as CompleteEvent,
        0,
      );

      // activeSessionKey가 null이면 statusUpdate 반환값도 null
      expect(result).toBeNull();
    });
  });

  // === R4: 서브에이전트 이벤트 무시 ===

  describe("processEvent - R4: subagent events ignored", () => {
    it("subagent_start is silently ignored (no node created)", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      // Task tool
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Task",
        tool_input: { subagent_type: "Explore" },
        tool_use_id: "toolu_task_1",
        parent_event_id: "0",
      } as ToolStartEvent, 2);

      // subagent_start → ignored
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_event_id: "toolu_task_1",
      } as SubagentStartEvent, 3);

      const tree = useDashboardStore.getState().tree!;
      // No error nodes
      expect(collectNodes(tree, "error")).toHaveLength(0);
      // Task tool is still there with no children
      const taskNode = findTreeNode(tree, "tool-2");
      expect(taskNode).not.toBeNull();
      expect(taskNode?.children).toHaveLength(0);
    });

    it("subagent_stop is silently ignored", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Task",
        tool_input: {},
        tool_use_id: "toolu_task_1",
        parent_event_id: "0",
      } as ToolStartEvent, 2);

      // Both subagent events ignored
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_event_id: "toolu_task_1",
      } as SubagentStartEvent, 3);

      processEvent({
        type: "subagent_stop",
        agent_id: "agent-1",
      } as SubagentStopEvent, 4);

      const tree = useDashboardStore.getState().tree!;
      expect(collectNodes(tree, "error")).toHaveLength(0);
    });

    it("events with parent_event_id go to tool node directly (no subagent intermediary)", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      // Task tool
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Task",
        tool_input: {},
        tool_use_id: "toolu_task_1",
        parent_event_id: "0",
      } as ToolStartEvent, 2);

      // subagent_start ignored
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_event_id: "toolu_task_1",
      } as SubagentStartEvent, 3);

      // Phase 2-A 평탄화: parent_event_id="toolu_task_1"은 무시. tool_use_id 보조 등록은
      // applyUpdate 매칭 용도로 유지되지만 트리 배치는 root.children 평면 push.
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
        tool_use_id: "toolu_2",
        parent_event_id: "toolu_task_1",
      } as ToolStartEvent, 4);

      const tree = useDashboardStore.getState().tree!;
      expect(collectNodes(tree, "error")).toHaveLength(0);
      // Phase 2-A 평탄화: Task tool과 inner Read tool 둘 다 root.children에 형제로 push.
      // (parent_event_id="toolu_task_1"은 무시되지만 tool_use_id 보조 등록은 유지되어
      //  applyUpdate가 tool_result를 매칭할 수 있다.)
      const tools = collectNodes(tree, "tool");
      expect(tools).toHaveLength(2);
      expect((tools[0] as ToolNode).toolName).toBe("Task");
      expect((tools[1] as ToolNode).toolName).toBe("Read");
    });
  });

  // === thinking + text 결합 ===

  describe("processEvent - thinking + text lifecycle", () => {
    it("thinking 노드 생성 → parent_event_id로 user_message 자식으로 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({
        type: "thinking",
        thinking: "Let me think...",
        parent_event_id: "0",
      } as ThinkingEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      // Phase 2-A 평탄화: thinking은 root.children에 user_message와 형제로 push
      expect(tree.children).toHaveLength(2);
      expect(tree.children[0].type).toBe("user_message");
      expect(tree.children[1].type).toBe("thinking");
      expect(tree.children[1].content).toBe("Let me think...");
      expect(tree.children[1].id).toBe("thinking-1");
    });

    it("text_start가 독립 TextNode를 생성 (thinking과 형제)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({
        type: "thinking",
        thinking: "Reasoning...",
        parent_event_id: "0",
      } as ThinkingEvent, 1);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 2);

      const tree = useDashboardStore.getState().tree!;
      // Phase 2-A 평탄화: user_message + thinking + text 모두 root.children에 형제
      expect(tree.children).toHaveLength(3);
      expect(tree.children[0].type).toBe("user_message");
      expect(tree.children[1].type).toBe("thinking");
      expect(tree.children[2].type).toBe("text");
    });

    it("text_delta가 독립 TextNode의 content를 갱신", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({
        type: "thinking",
        thinking: "Deep thought",
        parent_event_id: "0",
      } as ThinkingEvent, 1);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 2);
      processEvent({ type: "text_delta", text: "Here is " } as TextDeltaEvent, 3);
      processEvent({ type: "text_delta", text: "the answer." } as TextDeltaEvent, 4);

      const textNode = findTreeNode(useDashboardStore.getState().tree, "text-2")!;
      expect(textNode.type).toBe("text");
      expect(textNode.content).toBe("Here is the answer.");
      // thinking 원문은 변경되지 않음
      const thinkingNode = findTreeNode(useDashboardStore.getState().tree, "thinking-1")!;
      expect(thinkingNode.content).toBe("Deep thought");
    });

    it("text_end가 독립 TextNode의 completed를 설정", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({
        type: "thinking",
        thinking: "Pondering",
        parent_event_id: "0",
      } as ThinkingEvent, 1);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 2);
      processEvent({ type: "text_delta", text: "Answer" } as TextDeltaEvent, 3);
      processEvent({ type: "text_end" } as TextEndEvent, 4);

      const textNode = findTreeNode(useDashboardStore.getState().tree, "text-2")!;
      expect(textNode.completed).toBe(true);
      // thinking 노드의 completed는 true (생성 시 설정)
      const thinkingNode = findTreeNode(useDashboardStore.getState().tree, "thinking-1")!;
      expect(thinkingNode.completed).toBe(true);
    });

    it("tool_start → parent_event_id로 user_message에 배치 (thinking과 형제)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({
        type: "thinking",
        thinking: "Planning to read file",
        parent_event_id: "0",
      } as ThinkingEvent, 1);
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
        tool_use_id: "toolu_read1",
        parent_event_id: "0",
      } as ToolStartEvent, 2);

      const tree = useDashboardStore.getState().tree!;
      // Phase 2-A 평탄화: tool과 thinking 모두 root.children에 user_message와 형제
      expect(tree.children.some(c => c.type === "tool")).toBe(true);
      expect(tree.children.some(c => c.type === "thinking")).toBe(true);
    });

    it("thinking 없이 text_start → 독립 text 노드 생성", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Direct text" } as TextDeltaEvent, 2);
      processEvent({ type: "text_end" } as TextEndEvent, 3);

      const tree = useDashboardStore.getState().tree!;
      // Phase 2-A 평탄화: text 노드는 root.children에 push (collectNodes는 root에서 시작)
      const textNodes = collectNodes(tree, "text");
      expect(textNodes).toHaveLength(1);
      expect(textNodes[0].content).toBe("Direct text");
      expect(textNodes[0].completed).toBe(true);
    });

    it("text_start → 독립 text 노드 생성, text_delta로 activeTextTarget 갱신", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      // Phase 2-A 평탄화: text 노드는 root.children에 push
      const textNodes = collectNodes(tree, "text");
      expect(textNodes).toHaveLength(1);
      expect(textNodes[0].id).toBe("text-1");

      // text_delta는 activeTextTarget을 통해 정상 갱신
      processEvent({ type: "text_delta", text: "hello" } as TextDeltaEvent, 2);
      const updatedTextNode = findTreeNode(useDashboardStore.getState().tree, "text-1");
      expect(updatedTextNode?.content).toBe("hello");
    });

    it("연속 thinking 블록이 각각 독립 노드로 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);

      // 첫 번째 thinking
      processEvent({
        type: "thinking",
        thinking: "First thought",
        parent_event_id: "0",
      } as ThinkingEvent, 1);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 2);
      processEvent({ type: "text_delta", text: "Response 1" } as TextDeltaEvent, 3);
      processEvent({ type: "text_end" } as TextEndEvent, 4);

      // 도구 호출 (parent_event_id → user_message)
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "toolu_1",
        parent_event_id: "0",
      } as ToolStartEvent, 5);
      processEvent({
        type: "tool_result",
        tool_name: "Read",
        result: "file content",
        is_error: false,
        tool_use_id: "toolu_1",
      } as ToolResultEvent, 6);

      // 두 번째 thinking
      processEvent({
        type: "thinking",
        thinking: "Second thought",
        parent_event_id: "0",
      } as ThinkingEvent, 7);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 8);
      processEvent({ type: "text_delta", text: "Response 2" } as TextDeltaEvent, 9);
      processEvent({ type: "text_end" } as TextEndEvent, 10);

      const tree = useDashboardStore.getState().tree!;
      // Phase 2-A 평탄화: 모든 노드는 root.children에 평면 push
      const thinkingNodes = collectNodes(tree, "thinking");
      expect(thinkingNodes).toHaveLength(2);
      expect(thinkingNodes[0].content).toBe("First thought");
      expect(thinkingNodes[1].content).toBe("Second thought");

      const textNodes = collectNodes(tree, "text");
      expect(textNodes).toHaveLength(2);
      expect(textNodes[0].content).toBe("Response 1");
      expect(textNodes[1].content).toBe("Response 2");

      const toolNodes = collectNodes(tree, "tool");
      expect(toolNodes).toHaveLength(1);
      expect((toolNodes[0] as ToolNode).toolName).toBe("Read");
      expect(tree.children.some(c => c.type === "tool")).toBe(true);
    });
  });

  // === result 이벤트 ===

  describe("processEvent - result event", () => {
    it("result 이벤트가 root의 자식으로 배치", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 2);

      processEvent({
        type: "result",
        timestamp: 1000.0,
        success: true,
        output: "Task completed successfully",
        usage: { input_tokens: 1000, output_tokens: 500 },
        total_cost_usd: 0.01,
      } as ResultEvent, 3);

      const tree = useDashboardStore.getState().tree!;
      const resultNodes = collectNodes(tree, "result");
      expect(resultNodes).toHaveLength(1);
      expect(resultNodes[0].content).toBe("Task completed successfully");
      expect(resultNodes[0].timestamp).toBe(1000.0);
      expect((resultNodes[0] as ResultNode).usage).toEqual({ input_tokens: 1000, output_tokens: 500 });
      expect((resultNodes[0] as ResultNode).totalCostUsd).toBe(0.01);
    });
  });

  // === 세션 재오픈 무결성 ===

  describe("processEvent - session reopen integrity", () => {
    /** 세션 A: user→text→tool→text→complete */
    function replaySessionA(processEvent: (event: any, eventId: number) => void) {
      processEvent({ type: "user_message", user: "u", text: "Session A" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Analyzing..." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end" } as TextEndEvent, 3);
      processEvent({ type: "tool_start", timestamp: 0, tool_name: "Read", tool_input: { file_path: "/test.ts" }, tool_use_id: "tu-a1", parent_event_id: "0" } as ToolStartEvent, 4);
      processEvent({ type: "tool_result", tool_name: "Read", result: "content", is_error: false, tool_use_id: "tu-a1" } as ToolResultEvent, 5);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 6);
      processEvent({ type: "text_delta", text: "Done." } as TextDeltaEvent, 7);
      processEvent({ type: "text_end" } as TextEndEvent, 8);
      processEvent({ type: "complete", result: "Session A done", attachments: [], parent_event_id: "0" } as CompleteEvent, 9);
    }

    /** 세션 B: user→text→complete (tool 없음) */
    function replaySessionB(processEvent: (event: any, eventId: number) => void) {
      processEvent({ type: "user_message", user: "u", text: "Session B" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Simple answer." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end" } as TextEndEvent, 3);
      processEvent({ type: "complete", result: "Session B done", attachments: [], parent_event_id: "0" } as CompleteEvent, 4);
    }

    /** 트리를 재귀 순회하여 타입별 노드 수 집계 */
    function snapshotTree(tree: EventTreeNode | null): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const node of collectNodes(tree)) {
        counts[node.type] = (counts[node.type] ?? 0) + 1;
      }
      return counts;
    }

    it("A→B→A roundtrip: tree should match first load", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();

      // Session A: first load
      setActiveSession("sess-A");
      replaySessionA(processEvent);
      const snapA1 = snapshotTree(useDashboardStore.getState().tree);

      // Switch to B
      setActiveSession("sess-B");
      replaySessionB(processEvent);
      const snapB = snapshotTree(useDashboardStore.getState().tree);

      // B should differ from A (no tool nodes)
      expect(snapB["tool"]).toBeUndefined();
      expect(snapA1["tool"]).toBe(1);

      // Switch back to A (cache replay)
      setActiveSession("sess-A");
      replaySessionA(processEvent);
      const snapA2 = snapshotTree(useDashboardStore.getState().tree);

      // A2 should match A1
      expect(snapA2).toEqual(snapA1);

      // No B nodes leaked into A
      const allNodes = collectNodes(useDashboardStore.getState().tree);
      const bNodeLeaks = allNodes.filter(n => n.content.includes("Session B"));
      expect(bNodeLeaks).toHaveLength(0);
    });

    it("fast switch: no duplicate nodes from incomplete replay", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();

      // Session A: partial replay (user + text + tool, no complete)
      setActiveSession("sess-A");
      processEvent({ type: "user_message", user: "u", text: "Session A" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "tool_start", timestamp: 0, tool_name: "Read", tool_input: {}, tool_use_id: "tu-a1", parent_event_id: "0" } as ToolStartEvent, 2);

      // Immediately switch to B
      setActiveSession("sess-B");
      replaySessionB(processEvent);

      // Immediately switch back to A — full replay
      setActiveSession("sess-A");
      replaySessionA(processEvent);

      // Should have exactly 1 user_message and 1 tool (no leftover from partial replay)
      const tree = useDashboardStore.getState().tree!;
      const userNodes = collectNodes(tree, "user_message");
      const toolNodes = collectNodes(tree, "tool");
      expect(userNodes).toHaveLength(1);
      expect(toolNodes).toHaveLength(1);
    });

    it("same eventId across sessions: no type confusion", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();

      // Session A: eventId=4 → tool node
      setActiveSession("sess-A");
      processEvent({ type: "user_message", user: "u", text: "A" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "tool_start", timestamp: 0, tool_name: "Read", tool_input: {}, tool_use_id: "tu-a1", parent_event_id: "0" } as ToolStartEvent, 4);
      processEvent({ type: "tool_result", tool_name: "Read", result: "ok", is_error: false, tool_use_id: "tu-a1" } as ToolResultEvent, 5);
      processEvent({ type: "complete", result: "done", attachments: [], parent_event_id: "0" } as CompleteEvent, 9);

      // Session B: eventId=4 → complete node (different type for same eventId!)
      setActiveSession("sess-B");
      processEvent({ type: "user_message", user: "u", text: "B" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 3);
      processEvent({ type: "complete", result: "B done", attachments: [], parent_event_id: "0" } as CompleteEvent, 4);

      // Switch back to A — replay
      setActiveSession("sess-A");
      processEvent({ type: "user_message", user: "u", text: "A" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "tool_start", timestamp: 0, tool_name: "Read", tool_input: {}, tool_use_id: "tu-a1", parent_event_id: "0" } as ToolStartEvent, 4);
      processEvent({ type: "tool_result", tool_name: "Read", result: "ok", is_error: false, tool_use_id: "tu-a1" } as ToolResultEvent, 5);
      processEvent({ type: "complete", result: "done", attachments: [], parent_event_id: "0" } as CompleteEvent, 9);

      // Verify eventId=4 in session A is a tool node, not a complete node
      const tree = useDashboardStore.getState().tree!;
      const toolNode = findTreeNode(tree, "tool-4");
      expect(toolNode).not.toBeNull();
      expect(toolNode!.type).toBe("tool");
      expect((toolNode as ToolNode).toolName).toBe("Read");
    });
  });

  // === 멀티턴 서브에이전트 ===

  describe("processEvent - multi-turn (subagent events ignored)", () => {
    it("멀티턴 시퀀스에서 subagent 이벤트가 무시되고 나머지가 정상 동작", () => {
      const { processEvent } = useDashboardStore.getState();
      let id = 0;

      // Turn 1: user(0) → text → tool(Skill) → complete
      processEvent({ type: "user_message", user: "u", text: "Load skill" } as UserMessageEvent, id++); // 0
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, id++); // 1
      processEvent({ type: "tool_start", timestamp: 0, tool_name: "Skill", tool_input: { skill: "dialogue" }, tool_use_id: "tu-skill", parent_event_id: "0" } as ToolStartEvent, id++); // 2
      processEvent({ type: "tool_result", tool_name: "Skill", result: "ok", is_error: false, tool_use_id: "tu-skill" } as ToolResultEvent, id++); // 3
      processEvent({ type: "text_delta", text: "Loaded." } as TextDeltaEvent, id++); // 4
      processEvent({ type: "text_end" } as TextEndEvent, id++); // 5
      processEvent({ type: "complete", result: "Skill loaded", attachments: [], parent_event_id: "0" } as CompleteEvent, id++); // 6

      // Turn 2: user(7) → text → Task(subagent_start ignored) → inner tool → subagent_stop ignored → text → complete
      processEvent({ type: "user_message", user: "u", text: "Analyze" } as UserMessageEvent, id++); // 7
      processEvent({ type: "text_start", parent_event_id: "7" } as TextStartEvent, id++); // 8
      processEvent({ type: "text_delta", text: "Exploring..." } as TextDeltaEvent, id++); // 9
      processEvent({ type: "text_end" } as TextEndEvent, id++); // 10
      processEvent({ type: "tool_start", timestamp: 0, tool_name: "Task", tool_input: { subagent_type: "Explore" }, tool_use_id: "tu-task1", parent_event_id: "7" } as ToolStartEvent, id++); // 11
      processEvent({ type: "subagent_start", agent_id: "agent-1", agent_type: "Explore", parent_event_id: "tu-task1" } as SubagentStartEvent, id++); // 12
      processEvent({ type: "tool_start", timestamp: 0, tool_name: "Grep", tool_input: {}, tool_use_id: "tu-sub-grep", parent_event_id: "tu-task1" } as ToolStartEvent, id++); // 13
      processEvent({ type: "tool_result", tool_name: "Grep", result: "found", is_error: false, tool_use_id: "tu-sub-grep", parent_event_id: "tu-task1" } as ToolResultEvent, id++); // 14
      processEvent({ type: "subagent_stop", agent_id: "agent-1", parent_event_id: "tu-task1" } as SubagentStopEvent, id++); // 15
      processEvent({ type: "tool_result", tool_name: "Task", result: "Explored", is_error: false, tool_use_id: "tu-task1" } as ToolResultEvent, id++); // 16
      processEvent({ type: "text_start", parent_event_id: "7" } as TextStartEvent, id++); // 17
      processEvent({ type: "text_delta", text: "Found results." } as TextDeltaEvent, id++); // 18
      processEvent({ type: "text_end" } as TextEndEvent, id++); // 19
      processEvent({ type: "complete", result: "Done", attachments: [], parent_event_id: "7" } as CompleteEvent, id++); // 20

      const tree = useDashboardStore.getState().tree!;

      // No error nodes
      expect(collectNodes(tree, "error")).toHaveLength(0);

      // Phase 2-A 평탄화: 두 턴의 user_message + 모든 tool/text가 root.children에 평면 push.
      // 두 user_message는 시간순으로 [0]·[N] 위치 (사이에 다른 노드들이 있음).
      const userMsgs = tree.children.filter(c => c.type === "user_message");
      expect(userMsgs).toHaveLength(2);
      expect(userMsgs[0].content).toBe("Load skill");
      expect(userMsgs[1].content).toBe("Analyze");

      // 모든 tool은 root.children에 평면 — turn 분리 없음. tool_use_id로 매칭만 검증.
      const allTools = collectNodes(tree, "tool");
      const skillTool = allTools.find(t => (t as ToolNode).toolName === "Skill");
      const taskTool = allTools.find(t => (t as ToolNode).toolName === "Task");
      const grepTool = allTools.find(t => (t as ToolNode).toolName === "Grep");
      expect(skillTool).toBeDefined();
      expect(taskTool).toBeDefined();
      expect(grepTool).toBeDefined();
    });

    it("tool은 Task tool의 자식으로 배치 (subagent 없이)", () => {
      const { processEvent } = useDashboardStore.getState();

      // Turn 1
      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 2);
      processEvent({ type: "complete", result: "done", attachments: [], parent_event_id: "0" } as CompleteEvent, 3);

      // Turn 2: Task tool with parent_event_id but NO subagent_start/stop
      processEvent({ type: "user_message", user: "u", text: "Turn 2" } as UserMessageEvent, 4);
      processEvent({ type: "text_start", parent_event_id: "4" } as TextStartEvent, 5);
      processEvent({ type: "text_end" } as TextEndEvent, 6);
      processEvent({ type: "tool_start", timestamp: 0, tool_name: "Task", tool_input: {}, tool_use_id: "tu-task", parent_event_id: "4" } as ToolStartEvent, 7);
      // Phase 2-A 평탄화: Inner tool도 parent_event_id 무시되고 root.children에 평면 push.
      processEvent({ type: "tool_start", timestamp: 0, tool_name: "Grep", tool_input: {}, tool_use_id: "tu-grep", parent_event_id: "tu-task" } as ToolStartEvent, 8);
      processEvent({ type: "tool_result", tool_name: "Grep", result: "ok", is_error: false, tool_use_id: "tu-grep", parent_event_id: "tu-task" } as ToolResultEvent, 9);
      processEvent({ type: "tool_result", tool_name: "Task", result: "done", is_error: false, tool_use_id: "tu-task" } as ToolResultEvent, 10);
      processEvent({ type: "complete", result: "done", attachments: [], parent_event_id: "4" } as CompleteEvent, 11);

      const tree = useDashboardStore.getState().tree!;

      // Should not crash, 2 user_message turns
      const userMsgs = tree.children.filter(c => c.type === "user_message");
      expect(userMsgs).toHaveLength(2);

      // Phase 2-A 평탄화: 모든 tool은 root.children에 평면 push, parent-child 트리 없음.
      const allTools = collectNodes(tree, "tool");
      expect(allTools.some(t => (t as ToolNode).toolName === "Task")).toBe(true);
      expect(allTools.some(t => (t as ToolNode).toolName === "Grep")).toBe(true);

      // 에러 노드 없음 (parent_event_id 매칭 실패도 silent — 평탄화 후 root.children push)
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes).toHaveLength(0);
    });
  });

  // === 순차 서브에이전트 격리 ===

  describe("processEvent - sequential subagent isolation (R4)", () => {
    it("서브에이전트 내부 이벤트가 tool 노드에 배치, 후속 Task는 user_message에 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      let id = 0;

      processEvent({ type: "user_message", user: "u", text: "Run tasks" } as UserMessageEvent, id++); // 0
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, id++); // 1
      processEvent({ type: "text_delta", text: "Planning..." } as TextDeltaEvent, id++); // 2
      processEvent({ type: "text_end" } as TextEndEvent, id++); // 3

      // Task-1
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Task",
        tool_input: { prompt: "Explore" },
        tool_use_id: "toolu_task_1",
        parent_event_id: "0",
      } as ToolStartEvent, id++); // 4

      // subagent_start → ignored
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_event_id: "toolu_task_1",
      } as SubagentStartEvent, id++);

      // Inner tool with parent_event_id → goes to Task tool node directly
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Grep",
        tool_input: {},
        tool_use_id: "toolu_grep",
        parent_event_id: "toolu_task_1",
      } as ToolStartEvent, id++);
      processEvent({
        type: "tool_result",
        tool_name: "Grep",
        result: "found",
        is_error: false,
        tool_use_id: "toolu_grep",
        parent_event_id: "toolu_task_1",
      } as ToolResultEvent, id++);

      // subagent_stop → ignored
      processEvent({
        type: "subagent_stop",
        agent_id: "agent-1",
        parent_event_id: "toolu_task_1",
      } as SubagentStopEvent, id++);
      processEvent({
        type: "tool_result",
        tool_name: "Task",
        result: "Explored",
        is_error: false,
        tool_use_id: "toolu_task_1",
      } as ToolResultEvent, id++);

      // Task-2: user_message level
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Task",
        tool_input: { prompt: "Review" },
        tool_use_id: "toolu_task_2",
        parent_event_id: "0",
      } as ToolStartEvent, id++);

      const tree = useDashboardStore.getState().tree!;

      // Phase 2-A 평탄화: 모든 tool은 root.children에 평면 push (Task-1, Grep, Task-2 셋 다)
      const tools = collectNodes(tree, "tool");
      const taskTools = tools.filter(t => (t as ToolNode).toolName === "Task");
      expect(taskTools).toHaveLength(2);
      expect(tools.some(t => (t as ToolNode).toolName === "Grep")).toBe(true);

      // No error nodes
      expect(collectNodes(tree, "error")).toHaveLength(0);
    });
  });

  // === 에러 노드 삽입 (orphan detection) ===

  describe("processEvent - orphan error node insertion", () => {
    it("tool이 parent_event_id로 user_message에 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: {},
        parent_event_id: "0",
      } as ToolStartEvent, 2);

      const tree = useDashboardStore.getState().tree!;
      // Phase 2-A 평탄화: tool은 root.children에 push
      expect(tree.children.some(c => c.type === "tool")).toBe(true);
      const toolNode = tree.children.find(c => c.type === "tool");
      expect((toolNode as ToolNode).toolName).toBe("Read");

      // 에러 노드 없음
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes).toHaveLength(0);
    });

    it("복수 tool이 모두 root.children에 push (Phase 2-A 평면)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 2);
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: {},
        parent_event_id: "0",
      } as ToolStartEvent, 3);

      const tree = useDashboardStore.getState().tree!;

      // Phase 2-A 평탄화: tool은 root.children에 push (text 2개 + tool 1개 + user_message)
      const toolNodes = tree.children.filter(c => c.type === "tool");
      expect(toolNodes).toHaveLength(1);
      expect((toolNodes[0] as ToolNode).toolName).toBe("Read");
    });

    it("parent_event_id 매칭 실패 시 root에 배치 (에러 노드 없음)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: {},
        parent_event_id: "nonexistent-id",
      } as ToolStartEvent, 2);

      const tree = useDashboardStore.getState().tree!;
      // Phase 6: orphan error 삽입 없음
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes).toHaveLength(0);

      // tool은 root에 배치 (nodeMap에 매칭 실패 → fallback to root)
      expect(tree.children.some(c => c.id === "tool-2")).toBe(true);
    });

    it("currentTurnNode 없이 thinking → root 직접 배치 (implicit turn 생성 안 함)", () => {
      const { processEvent } = useDashboardStore.getState();

      // user_message 없이 바로 thinking 이벤트
      processEvent({
        type: "thinking",
        thinking: "Analyzing...",
      } as ThinkingEvent, 0);

      const tree = useDashboardStore.getState().tree!;

      // implicit-turn 노드가 생성되지 않아야 함
      const userMsgs = collectNodes(tree, "user_message");
      expect(userMsgs).toHaveLength(0);

      // thinking이 root의 직접 자식
      const thinkingNodes = collectNodes(tree, "thinking");
      expect(thinkingNodes).toHaveLength(1);
      expect(thinkingNodes[0].content).toBe("Analyzing...");
      expect(tree.children.some(c => c.type === "thinking")).toBe(true);
    });

    it("currentTurnNode 없이 text_start → root 직접 배치 (implicit turn 생성 안 함)", () => {
      const { processEvent } = useDashboardStore.getState();

      // user_message 없이 바로 text_start 이벤트
      processEvent({ type: "text_start" } as TextStartEvent, 0);
      processEvent({ type: "text_delta", text: "hello" } as TextDeltaEvent, 1);

      const tree = useDashboardStore.getState().tree!;

      // implicit-turn 노드가 생성되지 않아야 함
      const userMsgs = collectNodes(tree, "user_message");
      expect(userMsgs).toHaveLength(0);

      // text가 root의 직접 자식
      const textNode = findTreeNode(tree, "text-0")!;
      expect(textNode.content).toBe("hello");
      expect(tree.children.some(c => c.id === "text-0")).toBe(true);
    });

    it("서브에이전트 내부 text_start에서 parent_event_id 매칭 실패 시 root에 배치 (에러 노드 없음)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);

      // parent_event_id가 있지만 매칭되는 노드가 없는 text_start
      processEvent({
        type: "text_start",
        parent_event_id: "nonexistent-parent",
      } as TextStartEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      // Phase 6: orphan error 삽입 없음
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes).toHaveLength(0);

      // text는 root에 배치 (nodeMap에 매칭 실패 → fallback to root)
      expect(tree.children.some(c => c.id === "text-1")).toBe(true);
    });

    it("서브에이전트 내부 thinking에서 parent_event_id 매칭 실패 시 root에 배치 (에러 노드 없음)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);

      // parent_event_id가 있지만 매칭되는 노드가 없는 thinking
      processEvent({
        type: "thinking",
        thinking: "Lost thought...",
        parent_event_id: "nonexistent-parent",
      } as ThinkingEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      // Phase 6: orphan error 삽입 없음
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes).toHaveLength(0);

      // thinking은 root에 배치 (nodeMap에 매칭 실패 → fallback to root)
      expect(tree.children.some(c => c.type === "thinking")).toBe(true);
    });
  });

  // === 초기화 ===

  describe("reset", () => {
    it("should reset all state to initial values", () => {
      const { processEvent, setActiveSession, selectCard } =
        useDashboardStore.getState();

      setActiveSession("sess-abc");
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      selectCard("x");

      useDashboardStore.getState().reset();
      const state = useDashboardStore.getState();

      expect(state.activeSessionKey).toBeNull();
      expect(state.tree).toBeNull();
      expect(state.selectedCardId).toBeNull();
      expect(state.lastEventId).toBe(0);
    });
  });

  // === Dedup 가드 테스트 ===

  describe("dedup guard", () => {
    it("processEvent should skip events with eventId <= lastEventId", () => {
      const store = useDashboardStore.getState();

      store.setActiveSession("sess-dedup");

      // 이벤트를 처리하여 lastEventId를 5로 설정
      const userMsg: UserMessageEvent = { type: "user_message", user: "test", text: "hello" };
      store.processEvent(userMsg, 5);
      expect(useDashboardStore.getState().lastEventId).toBe(5);

      // treeVersion 기록
      const versionBefore = useDashboardStore.getState().treeVersion;

      // eventId=3 (이미 처리된 것) → 건너뛰어야 함
      const textStart: TextStartEvent = { type: "text_start", timestamp: 0 };
      store.processEvent(textStart, 3);

      // treeVersion이 변하지 않아야 함 (노드가 추가되지 않음)
      expect(useDashboardStore.getState().treeVersion).toBe(versionBefore);
      expect(useDashboardStore.getState().lastEventId).toBe(5); // 변하지 않음
    });

    it("processEvent should allow eventId=0 (history_sync)", () => {
      const store = useDashboardStore.getState();

      store.setActiveSession("sess-dedup2");

      // lastEventId를 10으로 설정
      const userMsg: UserMessageEvent = { type: "user_message", user: "test", text: "hello" };
      store.processEvent(userMsg, 10);
      expect(useDashboardStore.getState().lastEventId).toBe(10);

      // history_sync (eventId=0) → 건너뛰지 않아야 함
      const historySync = { type: "history_sync", last_event_id: 10, is_live: true } as unknown as import("../shared/types").SoulSSEEvent;
      store.processEvent(historySync, 0);

      // lastEventId는 그대로 (history_sync는 eventId=0)
      // 중요한 것은 에러 없이 처리되는 것
      expect(useDashboardStore.getState().lastEventId).toBe(10);
    });

    it("processEvents batch should skip duplicate events", () => {
      const store = useDashboardStore.getState();

      store.setActiveSession("sess-batch");

      // lastEventId를 5로 설정
      const userMsg: UserMessageEvent = { type: "user_message", user: "test", text: "hello" };
      store.processEvent(userMsg, 5);

      const versionBefore = useDashboardStore.getState().treeVersion;

      // 배치: eventId 3, 4 (이미 처리됨) + 6, 7 (새 이벤트)
      store.processEvents([
        { event: { type: "text_start", timestamp: 0 } as TextStartEvent, eventId: 3 },
        { event: { type: "text_delta", text: "dup", timestamp: 0 } as TextDeltaEvent, eventId: 4 },
        { event: { type: "text_start", timestamp: 0 } as TextStartEvent, eventId: 6 },
        { event: { type: "text_delta", text: "new", timestamp: 0 } as TextDeltaEvent, eventId: 7 },
      ]);

      // lastEventId는 7이어야 함 (새 이벤트의 최대값)
      expect(useDashboardStore.getState().lastEventId).toBe(7);
      // treeVersion은 증가해야 함 (새 이벤트가 처리됨)
      expect(useDashboardStore.getState().treeVersion).toBeGreaterThan(versionBefore);
    });

    it("processEvents batch should handle history_sync with eventId=0", () => {
      const store = useDashboardStore.getState();

      store.setActiveSession("sess-sync");

      // lastEventId를 5로 설정
      store.processEvent(
        { type: "user_message", user: "test", text: "hello", timestamp: 0 } as UserMessageEvent,
        5,
      );

      // history_sync (eventId=0)를 배치로 처리 → 건너뛰지 않아야 함
      store.processEvents([
        { event: { type: "history_sync", last_event_id: 5, is_live: true } as unknown as import("../shared/types").SoulSSEEvent, eventId: 0 },
      ]);

      // 에러 없이 처리되고, processingCtx.historySynced가 true가 되어야 함
      expect(useDashboardStore.getState().processingCtx.historySynced).toBe(true);
    });

    it("processEvents returns statusUpdates from history_sync", () => {
      const store = useDashboardStore.getState();

      store.setActiveSession("sess-status");

      const result = store.processEvents([
        {
          event: {
            type: "history_sync",
            last_event_id: 5,
            is_live: true,
            status: "completed",
          } as unknown as import("../shared/types").SoulSSEEvent,
          eventId: 0,
        },
      ]);

      expect(result.statusUpdates).toHaveLength(1);
      expect(result.statusUpdates[0]).toEqual({ agentSessionId: "sess-status", status: "completed" });
    });

    it("processEvents does not derive terminal status from turn complete after historySynced", () => {
      const store = useDashboardStore.getState();

      store.setActiveSession("sess-derive");

      // historySynced를 먼저 true로 만듦
      store.processEvents([
        {
          event: {
            type: "history_sync",
            last_event_id: 0,
            is_live: true,
          } as unknown as import("../shared/types").SoulSSEEvent,
          eventId: 0,
        },
      ]);

      const result = store.processEvents([
        {
          event: {
            type: "complete",
            result: "done",
            attachments: [],
            timestamp: 0,
          } as unknown as import("../shared/types").SoulSSEEvent,
          eventId: 10,
        },
      ]);

      expect(result.statusUpdates).toHaveLength(0);
    });

    it("processEvents returns empty statusUpdates for events that don't affect status", () => {
      const store = useDashboardStore.getState();

      store.setActiveSession("sess-notrigger");

      // historySynced = true
      store.processEvents([
        {
          event: {
            type: "history_sync",
            last_event_id: 0,
            is_live: true,
          } as unknown as import("../shared/types").SoulSSEEvent,
          eventId: 0,
        },
      ]);

      // text_delta는 status 변경 없음
      const result = store.processEvents([
        {
          event: { type: "text_start", timestamp: 0 } as TextStartEvent,
          eventId: 20,
        },
        {
          event: { type: "text_delta", text: "hello", timestamp: 0 } as TextDeltaEvent,
          eventId: 21,
        },
      ]);

      expect(result.statusUpdates).toHaveLength(0);
    });

    it("processEvents should not crash when system_message is the first event (tree=null)", () => {
      const store = useDashboardStore.getState();
      store.clearTree(); // tree=null, nodeMap=empty

      // system_message가 root 없는 상태에서 첫 번째로 도착
      const result = store.processEvents([
        {
          event: { type: "system_message", text: "init", timestamp: 0 } as import("../shared/types").SystemMessageEvent,
          eventId: 1,
        },
      ]);

      const tree = useDashboardStore.getState().tree;
      expect(tree).not.toBeNull();
      expect(tree!.children).toHaveLength(1);
      expect(tree!.children[0].type).toBe("system_message");
      expect(result.statusUpdates).toHaveLength(0);
    });

    it("processEvents should not crash when compact is the first event (tree=null)", () => {
      const store = useDashboardStore.getState();
      store.clearTree();

      const result = store.processEvents([
        {
          event: { type: "compact", trigger: "manual", message: "Context compacted" } as import("../shared/types").CompactEvent,
          eventId: 1,
        },
      ]);

      const tree = useDashboardStore.getState().tree;
      expect(tree).not.toBeNull();
      expect(tree!.children).toHaveLength(1);
      expect(tree!.children[0].type).toBe("compact");
      expect(result.statusUpdates).toHaveLength(0);
    });

    it("processEvents should not crash when parent_event_id references missing node", () => {
      const store = useDashboardStore.getState();
      store.clearTree();

      // parent_event_id="2"를 참조하지만, eventId=2 노드가 없음
      const result = store.processEvents([
        {
          event: { type: "user_message", text: "hello", timestamp: 0 } as UserMessageEvent,
          eventId: 1,
        },
        {
          event: {
            type: "thinking",
            thinking: "test",
            timestamp: 0,
            parent_event_id: "999",
          } as ThinkingEvent,
          eventId: 3,
        },
      ]);

      const tree = useDashboardStore.getState().tree;
      expect(tree).not.toBeNull();
      // parent "999"를 찾지 못해 root로 폴백 — crash 없이 처리
      expect(tree!.children).toHaveLength(2);
      expect(result.statusUpdates).toHaveLength(0);
    });
  });

  describe("reorderFolders", () => {
    const makeFolder = (id: string, name: string, sortOrder: number): CatalogState["folders"][number] => ({
      id,
      name,
      sortOrder,
      createdAt: "2026-01-01T00:00:00Z",
    });

    it("시스템 폴더와 일반 폴더가 혼재할 때 reorderFolders 호출 후 시스템 폴더가 보존된다", () => {
      const store = useDashboardStore.getState();

      const systemFolder = makeFolder("sys-1", "⚙️ 클로드 코드 세션", 0);
      const folderA = makeFolder("folder-a", "Alpha", 1);
      const folderB = makeFolder("folder-b", "Beta", 2);
      const folderC = makeFolder("folder-c", "Gamma", 3);

      store.setCatalog({
        folders: [systemFolder, folderA, folderB, folderC],
        sessions: {},
      });

      // 일반 폴더를 역순으로 재정렬 (시스템 폴더 ID는 포함하지 않음)
      store.reorderFolders(["folder-c", "folder-b", "folder-a"]);

      const { catalog } = useDashboardStore.getState();
      expect(catalog).not.toBeNull();

      const folderIds = catalog!.folders.map((f) => f.id);
      // 시스템 폴더가 반드시 포함되어야 함
      expect(folderIds).toContain("sys-1");
      // 일반 폴더 3개 모두 포함
      expect(folderIds).toContain("folder-a");
      expect(folderIds).toContain("folder-b");
      expect(folderIds).toContain("folder-c");
      // 전체 개수 유지 (시스템 1 + 일반 3)
      expect(catalog!.folders).toHaveLength(4);

      // 재정렬된 일반 폴더의 sortOrder 확인
      const reorderedC = catalog!.folders.find((f) => f.id === "folder-c");
      const reorderedB = catalog!.folders.find((f) => f.id === "folder-b");
      const reorderedA = catalog!.folders.find((f) => f.id === "folder-a");
      expect(reorderedC!.sortOrder).toBe(0);
      expect(reorderedB!.sortOrder).toBe(1);
      expect(reorderedA!.sortOrder).toBe(2);
    });
  });

  // === catalog 자동 폴더 선택 가드 — store 사전 조건 회귀 테스트 ===
  // useSessionListProvider.ts L339의 guard 조건:
  //   store.selectedFolderId === null && !store.activeSessionKey && store.viewMode !== "feed"
  // 이 guard는 store의 selectFolder/selectFeed 동작에 의존하므로,
  // 해당 액션들의 store 상태 변경이 올바른지 회귀 검증한다.

  describe("catalog 자동 폴더 선택 가드 — store 사전 조건 회귀 테스트", () => {
    it("selectFolder 호출 시 viewMode가 'folder'로 변경되고 selectedFolderId가 설정된다", () => {
      useDashboardStore.getState().selectFolder("folder-1");

      const state = useDashboardStore.getState();
      expect(state.viewMode).toBe("folder");
      expect(state.selectedFolderId).toBe("folder-1");
    });

    it("selectFolder 후 selectFeed 호출 시 viewMode가 'feed'로 변경되고 selectedFolderId는 이전 값을 유지한다", () => {
      useDashboardStore.getState().selectFolder("folder-1");
      useDashboardStore.getState().selectFeed();

      const state = useDashboardStore.getState();
      expect(state.viewMode).toBe("feed");
      // selectedFolderId는 selectFeed가 건드리지 않으므로 이전 값 유지
      expect(state.selectedFolderId).toBe("folder-1");
    });
  });

  // === Phase 2-A 평탄화: subtree_update는 no-op ===

  describe("subtree_update SSE 이벤트 (Phase 2-A 평탄화 — no-op)", () => {
    // Phase 2-A (atom 260507.01.fe-tree-flattening §11.3 Phase D 폐기 완료):
    //   subtree_update 처리는 폐기되었다. event-processor는 dedup만 갱신하고 트리 변경 없이 return한다.
    //   백엔드는 계속 송출하지만 FE는 무시한다 (Phase 2-B 후속 카드).
    //   nodeMap.subtreeHeight 증분, applySubtreeHeightUpdate, totalSubtreeHeight·setTotalSubtreeHeight
    //   모두 Phase D §11.3 grep으로 컴포넌트·훅 소비자 0건 확인 후 폐기 완료.
    beforeEach(() => {
      useDashboardStore.getState().setActiveSession("sess-st");
      useDashboardStore.getState().processEvent(
        { type: "history_sync", last_event_id: 0, is_live: true, status: "running" } as any,
        -1,
      );
    });

    it("subtree_update 수신 시 트리·nodeMap 변경 없음 — dedup만 갱신", () => {
      const { processEvent } = useDashboardStore.getState();

      // 조상 노드 생성
      processEvent(
        { type: "user_message", user: "u", text: "hello" } as UserMessageEvent,
        10,
      );
      const beforeAncestorHeight = useDashboardStore
        .getState()
        .processingCtx.nodeMap.get("10")?.subtreeHeight;

      processEvent(
        {
          type: "subtree_update",
          timestamp: Date.now() / 1000,
          affected_event_ids: [42],
          deltas: { "10": 3 },
          new_total_subtree_height: 7,
        } as any,
        42,
      );

      const stateAfter = useDashboardStore.getState();
      // applySubtreeHeightUpdate 폐기 — nodeMap.subtreeHeight 변경 없음
      expect(stateAfter.processingCtx.nodeMap.get("10")?.subtreeHeight).toBe(
        beforeAncestorHeight,
      );
      // dedup만 갱신 — lastEventId 진척
      expect(stateAfter.lastEventId).toBe(42);
    });
  });

  describe("processHistoryEvents - 옵션 D 단일 트리 통합", () => {
    it("빈 events 배열 → addedCount 0, store 무영향", () => {
      const before = useDashboardStore.getState();
      const beforeTree = before.tree;
      const beforeLastEventId = before.lastEventId;

      const result = useDashboardStore.getState().processHistoryEvents([]);

      expect(result.addedCount).toBe(0);
      const after = useDashboardStore.getState();
      expect(after.tree).toBe(beforeTree);
      expect(after.lastEventId).toBe(beforeLastEventId);
    });

    it("activeTextTarget이 호출 후 복원됨 (라이브 text 스트림 격리)", () => {
      // Phase 2-A 평탄화 후: historyMode 토글은 폐기. activeTextTarget 격리만 try/finally로 보존.
      // 라이브 SSE로 진행 중인 text 시퀀스 시뮬레이션
      useDashboardStore.getState().processEvent(
        { type: "user_message", content: "u" } as UserMessageEvent,
        100,
      );
      useDashboardStore.getState().processEvent(
        { type: "text_start", parent_event_id: "100" } as TextStartEvent,
        101,
      );
      const ctx = useDashboardStore.getState().processingCtx;
      const liveTextTarget = ctx.activeTextTarget;
      expect(liveTextTarget).not.toBeNull();

      // history 페이지 처리 (페이지에 다른 text_start 포함)
      useDashboardStore.getState().processHistoryEvents([
        {
          event: { type: "user_message", content: "old-u" } as UserMessageEvent,
          eventId: 50,
        },
        {
          event: { type: "text_start", parent_event_id: "50" } as TextStartEvent,
          eventId: 51,
        },
      ]);

      // 라이브 text 노드가 보호되어야 함 (try/finally로 복원)
      expect(ctx.activeTextTarget).toBe(liveTextTarget);
    });

    it("동일 eventId 중복 호출 시 두 번째는 dedup으로 addedCount 0", () => {
      const events = [
        {
          event: { type: "user_message", content: "u" } as UserMessageEvent,
          eventId: 1000,
        },
      ];

      const first = useDashboardStore.getState().processHistoryEvents(events);
      expect(first.addedCount).toBeGreaterThan(0);

      // 같은 eventId 두 번째 호출 — processEventsBatch 내부 `eventId <= lastEventId` dedup
      const second = useDashboardStore.getState().processHistoryEvents(events);
      expect(second.addedCount).toBe(0);
    });
  });

  // === 좌표 단위 통일 — grouped 차분 + atomic chatPrependedCount ===

  describe("processHistoryEvents - grouped 차분 + chatPrependedCount atomic", () => {
    it("케이스 A — 단순: 기존 [user, tool] + prepend [tool_new] → grouped 3, addedCount=1", () => {
      // 라이브 SSE: user(eventId=200) + tool(eventId=210)을 트리에 깐다
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", content: "live-u" } as UserMessageEvent, 200);
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "tu_live",
        parent_event_id: "200",
      } as ToolStartEvent, 210);

      const beforeChat = useDashboardStore.getState().chatPrependedCount;

      // prepend: tool 1개 (이전 시점, eventId 더 작음)
      // Phase 2-A 평탄화 후: parent_event_id 무시, 모든 노드는 root.children에 평면 push
      const events = [
        {
          event: { type: "user_message", content: "old-u" } as UserMessageEvent,
          eventId: 50,
        },
        {
          event: {
            type: "tool_start",
            timestamp: 0,
            tool_name: "Bash",
            tool_input: {},
            tool_use_id: "tu_old",
            parent_event_id: "50",
          } as ToolStartEvent,
          eventId: 60,
        },
      ];

      const result = useDashboardStore.getState().processHistoryEvents(events);
      // grouped: [user(old), tool(old), user(live), tool(live)] → grouped 4 (전·후 tool 비연속)
      // before grouped = 2, after grouped = 4 → addedCount=2
      expect(result.addedCount).toBeGreaterThan(0);
      const afterChat = useDashboardStore.getState().chatPrependedCount;
      expect(afterChat).toBe(beforeChat + result.addedCount);

      // cross-page 시간순 보존 (260508.03 fix invariant): root.children 의 eventId ASC 순서.
      // sorted insert 부재 시 push 순서대로 [user-msg-200, tool-210, user-msg-50, tool-60] 가
      // 되어 시간순이 깨진다. sorted insert 가 cross-page 시간순을 보장한다.
      const tree = useDashboardStore.getState().tree;
      expect(tree).not.toBeNull();
      const childrenIds = tree!.children.map((n) => n.id);
      expect(childrenIds).toEqual([
        "user-msg-50",
        "tool-60",
        "user-msg-200",
        "tool-210",
      ]);
    });

    it("케이스 B (핵심) — tool 연속 병합: 기존 [tool] + prepend [tool, tool] → grouped 1, addedCount=0", () => {
      const { processEvent } = useDashboardStore.getState();
      // 라이브: user_message(부모) + tool 1개
      processEvent({ type: "user_message", content: "live-u" } as UserMessageEvent, 100);
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "tu_1",
        parent_event_id: "100",
      } as ToolStartEvent, 110);

      // 라이브 트리 grouped 길이 측정 (basis)
      // (직접 측정하지 않고 chatPrependedCount 기준으로 검증)
      const beforeChat = useDashboardStore.getState().chatPrependedCount;

      // prepend: 같은 부모(100)에 tool 2개 추가 → 트리에 tool 3개 연속(자식 순서로)
      // grouping은 형제 tool 메시지를 모두 1 group으로 합침
      // → grouped.length 변화 없음
      const events = [
        {
          event: {
            type: "tool_start",
            timestamp: 0,
            tool_name: "Bash",
            tool_input: {},
            tool_use_id: "tu_2",
            parent_event_id: "100",
          } as ToolStartEvent,
          eventId: 120,
        },
        {
          event: {
            type: "tool_start",
            timestamp: 0,
            tool_name: "Glob",
            tool_input: {},
            tool_use_id: "tu_3",
            parent_event_id: "100",
          } as ToolStartEvent,
          eventId: 130,
        },
      ];

      const result = useDashboardStore.getState().processHistoryEvents(events);

      // 핵심: messages는 2개 늘었지만 grouped는 변화 없음
      expect(result.addedCount).toBe(0);
      const afterChat = useDashboardStore.getState().chatPrependedCount;
      expect(afterChat).toBe(beforeChat);
    });

    it("케이스 C — 비연속: 기존 [user, tool] + prepend [user, tool] → grouped 4, addedCount=2", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", content: "live-u" } as UserMessageEvent, 200);
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "tu_live",
        parent_event_id: "200",
      } as ToolStartEvent, 210);

      const beforeChat = useDashboardStore.getState().chatPrependedCount;

      const events = [
        {
          event: { type: "user_message", content: "old-u1" } as UserMessageEvent,
          eventId: 50,
        },
        {
          event: {
            type: "tool_start",
            timestamp: 0,
            tool_name: "Bash",
            tool_input: {},
            tool_use_id: "tu_old1",
            parent_event_id: "50",
          } as ToolStartEvent,
          eventId: 60,
        },
        {
          event: { type: "user_message", content: "old-u2" } as UserMessageEvent,
          eventId: 70,
        },
        {
          event: {
            type: "tool_start",
            timestamp: 0,
            tool_name: "Glob",
            tool_input: {},
            tool_use_id: "tu_old2",
            parent_event_id: "70",
          } as ToolStartEvent,
          eventId: 80,
        },
      ];

      const result = useDashboardStore.getState().processHistoryEvents(events);
      // 새 user 2개와 새 tool 2개가 들어옴 (각자 다른 부모이므로 비연속)
      expect(result.addedCount).toBeGreaterThanOrEqual(2);
      const afterChat = useDashboardStore.getState().chatPrependedCount;
      expect(afterChat).toBe(beforeChat + result.addedCount);

      // cross-page 시간순 보존 (260508.03 fix invariant): root.children 의 eventId ASC 순서.
      const tree = useDashboardStore.getState().tree;
      expect(tree).not.toBeNull();
      const childrenIds = tree!.children.map((n) => n.id);
      expect(childrenIds).toEqual([
        "user-msg-50",
        "tool-60",
        "user-msg-70",
        "tool-80",
        "user-msg-200",
        "tool-210",
      ]);
    });

    it("케이스 D — 빈 events: addedCount=0, chatPrependedCount 변화 없음", () => {
      const before = useDashboardStore.getState().chatPrependedCount;
      const result = useDashboardStore.getState().processHistoryEvents([]);
      expect(result.addedCount).toBe(0);
      expect(useDashboardStore.getState().chatPrependedCount).toBe(before);
    });

    it("케이스 E — dedup: 동일 eventId 두 번째 호출 시 addedCount=0, chatPrependedCount 불변", () => {
      const events = [
        {
          event: { type: "user_message", content: "u" } as UserMessageEvent,
          eventId: 5000,
        },
      ];

      useDashboardStore.getState().processHistoryEvents(events);
      const afterFirst = useDashboardStore.getState().chatPrependedCount;

      const result = useDashboardStore.getState().processHistoryEvents(events);
      expect(result.addedCount).toBe(0);
      expect(useDashboardStore.getState().chatPrependedCount).toBe(afterFirst);
    });

    it("케이스 F — 세션 리셋: setActiveSession 호출 시 chatPrependedCount=0", () => {
      // 먼저 prepend 누적
      useDashboardStore.getState().processHistoryEvents([
        {
          event: { type: "user_message", content: "u" } as UserMessageEvent,
          eventId: 999,
        },
      ]);
      expect(useDashboardStore.getState().chatPrependedCount).toBeGreaterThan(0);

      // 세션 전환
      useDashboardStore.getState().setActiveSession("sess-new");
      expect(useDashboardStore.getState().chatPrependedCount).toBe(0);
    });

    it("케이스 G — atomic 갱신: tree와 chatPrependedCount가 한 set() 안에서 갱신됨", () => {
      // 라이브 트리 셋업
      useDashboardStore.getState().processEvent(
        { type: "user_message", content: "live-u" } as UserMessageEvent,
        100,
      );

      const events = [
        {
          event: { type: "user_message", content: "old-u" } as UserMessageEvent,
          eventId: 50,
        },
      ];

      // subscribe로 알림 횟수 측정
      const listener = vi.fn();
      const unsubscribe = useDashboardStore.subscribe(listener);
      try {
        useDashboardStore.getState().processHistoryEvents(events);

        // 한 번의 알림으로 tree와 chatPrependedCount가 모두 갱신
        expect(listener).toHaveBeenCalledTimes(1);
        const state = useDashboardStore.getState();
        expect(state.chatPrependedCount).toBeGreaterThan(0);
        expect(state.tree).not.toBeNull();
      } finally {
        unsubscribe();
      }
    });

    it("케이스 H — 다중 페이지 prepend: 페이지 경계마다 시간순 보존", () => {
      // 라이브 SSE: u300, t310 (가장 최근)
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", content: "live-u" } as UserMessageEvent, 300);
      processEvent({
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "tu_live",
        parent_event_id: "300",
      } as ToolStartEvent, 310);

      // 1차 prepend (중간 페이지): u100, t110 — 라이브와 가장 오래된 페이지 사이
      useDashboardStore.getState().processHistoryEvents([
        {
          event: { type: "user_message", content: "mid-u" } as UserMessageEvent,
          eventId: 100,
        },
        {
          event: {
            type: "tool_start",
            timestamp: 0,
            tool_name: "Bash",
            tool_input: {},
            tool_use_id: "tu_m",
            parent_event_id: "100",
          } as ToolStartEvent,
          eventId: 110,
        },
      ]);

      // 2차 prepend (가장 오래된 페이지): u10, t20
      useDashboardStore.getState().processHistoryEvents([
        {
          event: { type: "user_message", content: "old-u" } as UserMessageEvent,
          eventId: 10,
        },
        {
          event: {
            type: "tool_start",
            timestamp: 0,
            tool_name: "Glob",
            tool_input: {},
            tool_use_id: "tu_o",
            parent_event_id: "10",
          } as ToolStartEvent,
          eventId: 20,
        },
      ]);

      const tree = useDashboardStore.getState().tree;
      expect(tree).not.toBeNull();
      const childrenIds = tree!.children.map((n) => n.id);
      // 두 페이지 경계를 거쳐도 root.children 은 항상 eventId ASC 순서.
      expect(childrenIds).toEqual([
        "user-msg-10",
        "tool-20",
        "user-msg-100",
        "tool-110",
        "user-msg-300",
        "tool-310",
      ]);
    });

    it("케이스 I — text_start prepend 시간순: handleTextStart 도 sorted insert", () => {
      // 라이브 text_start (eventId=400)
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "text_start", timestamp: 0 } as TextStartEvent, 400);

      // 과거 text_start (eventId=50) prepend
      const result = useDashboardStore.getState().processHistoryEvents([
        {
          event: { type: "text_start", timestamp: 0 } as TextStartEvent,
          eventId: 50,
        },
      ]);
      expect(result.addedCount).toBeGreaterThan(0);

      const tree = useDashboardStore.getState().tree;
      expect(tree).not.toBeNull();
      const childrenIds = tree!.children.map((n) => n.id);
      // handleTextStart 도 placeInTree 와 동일한 sorted insert 패턴을 사용해야 시간순 정합.
      expect(childrenIds).toEqual(["text-50", "text-400"]);
    });
  });

  // === chatLastPrependAtMs — atBottom=true settle 가드용 시각 추적 ===

  describe("chatLastPrependAtMs — prepend 시각 추적 + atomic 갱신", () => {
    it("초기값은 null", () => {
      expect(useDashboardStore.getState().chatLastPrependAtMs).toBeNull();
    });

    it("processHistoryEvents 호출 후 chatLastPrependAtMs ≈ performance.now()", () => {
      const before = performance.now();
      const result = useDashboardStore.getState().processHistoryEvents([
        {
          event: { type: "user_message", content: "u" } as UserMessageEvent,
          eventId: 100,
        },
      ]);
      const after = performance.now();

      expect(result.addedCount).toBeGreaterThan(0);
      const ts = useDashboardStore.getState().chatLastPrependAtMs;
      expect(ts).not.toBeNull();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it("setActiveSession 호출 시 chatLastPrependAtMs는 null로 리셋", () => {
      // 먼저 prepend로 timestamp 설정
      useDashboardStore.getState().processHistoryEvents([
        {
          event: { type: "user_message", content: "u" } as UserMessageEvent,
          eventId: 200,
        },
      ]);
      expect(useDashboardStore.getState().chatLastPrependAtMs).not.toBeNull();

      // 세션 전환
      useDashboardStore.getState().setActiveSession("sess-reset");
      expect(useDashboardStore.getState().chatLastPrependAtMs).toBeNull();
    });

    it("한 번의 set() 호출: subscribe 1회 보장 (chatLastPrependAtMs는 updated 분기와 무관, chatPrependedCount는 updated=true일 때만)", () => {
      // 라이브 트리 셋업
      useDashboardStore.getState().processEvent(
        { type: "user_message", content: "live-u" } as UserMessageEvent,
        300,
      );

      const events = [
        {
          event: { type: "user_message", content: "old-u" } as UserMessageEvent,
          eventId: 250,
        },
      ];

      const listener = vi.fn();
      const unsubscribe = useDashboardStore.subscribe(listener);
      try {
        useDashboardStore.getState().processHistoryEvents(events);

        // 한 번의 알림으로 tree, chatPrependedCount, chatLastPrependAtMs 모두 갱신
        expect(listener).toHaveBeenCalledTimes(1);
        const state = useDashboardStore.getState();
        expect(state.chatPrependedCount).toBeGreaterThan(0);
        expect(state.chatLastPrependAtMs).not.toBeNull();
        expect(state.tree).not.toBeNull();
      } finally {
        unsubscribe();
      }
    });

    it("dedup 케이스: addedCount=0이어도 chatLastPrependAtMs는 사용자 prepend 시도 시각을 추적하여 strict 단조 증가", async () => {
      const events = [
        {
          event: { type: "user_message", content: "u" } as UserMessageEvent,
          eventId: 400,
        },
      ];
      useDashboardStore.getState().processHistoryEvents(events);
      const tsAfterFirst = useDashboardStore.getState().chatLastPrependAtMs;
      expect(tsAfterFirst).not.toBeNull();

      // 시간 진행을 보장 (performance.now 단조 증가는 마이크로초 단위)
      await new Promise((r) => setTimeout(r, 5));

      // 동일 eventId 재호출 — addedCount=0이지만 사용자 prepend 시도 시각이므로
      // chatLastPrependAtMs는 항상 갱신되어야 한다. settle 가드는 사용자 행위 시각 기준.
      useDashboardStore.getState().processHistoryEvents(events);
      const tsAfterSecond = useDashboardStore.getState().chatLastPrependAtMs;
      expect(tsAfterSecond).not.toBeNull();
      // strict greater-than — dedup-only 응답에서도 시각이 갱신되어야 settle 가드 stale 방지
      expect(tsAfterSecond! > tsAfterFirst!).toBe(true);
    });

    it("빈 events: processHistoryEvents([])는 chatLastPrependAtMs를 갱신하지 않음 (early-return)", async () => {
      // 먼저 prepend로 timestamp 설정
      useDashboardStore.getState().processHistoryEvents([
        {
          event: { type: "user_message", content: "u" } as UserMessageEvent,
          eventId: 410,
        },
      ]);
      const tsBefore = useDashboardStore.getState().chatLastPrependAtMs;
      expect(tsBefore).not.toBeNull();

      await new Promise((r) => setTimeout(r, 5));

      // 빈 events — early-return으로 set 자체 호출 안 함
      const result = useDashboardStore.getState().processHistoryEvents([]);
      expect(result.addedCount).toBe(0);
      const tsAfter = useDashboardStore.getState().chatLastPrependAtMs;
      // 갱신되지 않아야 함 — 호출자가 prepend를 "시도"한 것이 아니므로
      expect(tsAfter).toBe(tsBefore);
    });

    it("다발 dedup: 연속 dedup-only 호출에도 시각이 단조 증가", async () => {
      const events = [
        {
          event: { type: "user_message", content: "u" } as UserMessageEvent,
          eventId: 420,
        },
      ];
      useDashboardStore.getState().processHistoryEvents(events);
      const t1 = useDashboardStore.getState().chatLastPrependAtMs!;

      await new Promise((r) => setTimeout(r, 5));
      useDashboardStore.getState().processHistoryEvents(events);
      const t2 = useDashboardStore.getState().chatLastPrependAtMs!;

      await new Promise((r) => setTimeout(r, 5));
      useDashboardStore.getState().processHistoryEvents(events);
      const t3 = useDashboardStore.getState().chatLastPrependAtMs!;

      expect(t2 > t1).toBe(true);
      expect(t3 > t2).toBe(true);
    });

    it("updated=false 경로 (subtree_update만 포함된 events)에서도 chatLastPrependAtMs 갱신 — settle 가드 stale 방지", async () => {
      // 먼저 일반 prepend로 timestamp 설정
      useDashboardStore.getState().processHistoryEvents([
        {
          event: { type: "user_message", content: "u" } as UserMessageEvent,
          eventId: 430,
        },
      ]);
      const tsBefore = useDashboardStore.getState().chatLastPrependAtMs!;
      expect(tsBefore).not.toBeNull();

      await new Promise((r) => setTimeout(r, 5));

      // subtree_update만 포함된 events — processEventsBatch에서 updated=false로 빠진다.
      // 사용자가 위로 스크롤하여 fetch한 응답 페이지가 모두 트리 변경을 일으키지 않는 코너 케이스.
      // 옵션 A에 따르면 chatLastPrependAtMs는 "사용자 prepend 시도 시각"이므로 갱신되어야 한다.
      const result = useDashboardStore.getState().processHistoryEvents([
        {
          event: {
            type: "subtree_update",
            timestamp: 1,
            affected_event_ids: [],
            deltas: {},
            new_total_subtree_height: 0,
          } as any,
          eventId: 431,
        },
      ]);
      expect(result.addedCount).toBe(0);
      const tsAfter = useDashboardStore.getState().chatLastPrependAtMs!;
      expect(tsAfter).not.toBeNull();
      // strict greater-than — updated=false 분기에서도 시각 갱신
      expect(tsAfter > tsBefore).toBe(true);
    });

    it("clearTree 호출 시 chatLastPrependAtMs는 null로 리셋", () => {
      useDashboardStore.getState().processHistoryEvents([
        {
          event: { type: "user_message", content: "u" } as UserMessageEvent,
          eventId: 500,
        },
      ]);
      expect(useDashboardStore.getState().chatLastPrependAtMs).not.toBeNull();

      useDashboardStore.getState().clearTree();
      expect(useDashboardStore.getState().chatLastPrependAtMs).toBeNull();
    });
  });

});
