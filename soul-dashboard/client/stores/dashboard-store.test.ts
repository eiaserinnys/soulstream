/**
 * dashboard-store 테스트
 *
 * Zustand 스토어의 트리 기반 이벤트 처리 로직을 검증합니다.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore, findTreeNode } from "./dashboard-store";
import type {
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ToolStartEvent,
  ToolResultEvent,
  CompleteEvent,
  SessionSummary,
  SessionEvent,
  ErrorEvent,
  InterventionSentEvent,
  UserMessageEvent,
  ProgressEvent,
  MemoryEvent,
  EventTreeNode,
} from "../../shared/types";

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

describe("dashboard-store", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  // === 세션 관리 ===

  describe("sessions", () => {
    it("should set sessions", () => {
      const sessions: SessionSummary[] = [
        {
          clientId: "c1",
          requestId: "r1",
          status: "running",
          eventCount: 5,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
      useDashboardStore.getState().setSessions(sessions);
      expect(useDashboardStore.getState().sessions).toEqual(sessions);
      expect(useDashboardStore.getState().sessionsError).toBeNull();
    });

    it("should set loading state", () => {
      useDashboardStore.getState().setSessionsLoading(true);
      expect(useDashboardStore.getState().sessionsLoading).toBe(true);
    });

    it("should set error and clear loading", () => {
      useDashboardStore.getState().setSessionsLoading(true);
      useDashboardStore.getState().setSessionsError("Network error");
      expect(useDashboardStore.getState().sessionsError).toBe("Network error");
      expect(useDashboardStore.getState().sessionsLoading).toBe(false);
    });
  });

  // === 활성 세션 ===

  describe("active session", () => {
    it("should set active session and clear tree", () => {
      const textStart: TextStartEvent = { type: "text_start", card_id: "abc" };
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent(textStart, 1);
      expect(useDashboardStore.getState().tree).not.toBeNull();

      useDashboardStore.getState().setActiveSession("c1:r1");
      expect(useDashboardStore.getState().activeSessionKey).toBe("c1:r1");
      expect(useDashboardStore.getState().tree).toBeNull();
      expect(useDashboardStore.getState().lastEventId).toBe(0);
      expect(useDashboardStore.getState().selectedCardId).toBeNull();
    });

    it("should clear active session when set to null", () => {
      useDashboardStore.getState().setActiveSession("c1:r1");
      useDashboardStore.getState().setActiveSession(null);
      expect(useDashboardStore.getState().activeSessionKey).toBeNull();
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
  });

  // === SSE 이벤트 처리: 텍스트 카드 ===

  describe("processEvent - text card lifecycle", () => {
    it("should create text node on text_start", () => {
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      const event: TextStartEvent = { type: "text_start", card_id: "abc123" };
      useDashboardStore.getState().processEvent(event, 1);

      const tree = useDashboardStore.getState().tree;
      expect(tree).not.toBeNull();
      const textNodes = collectNodes(tree, "text");
      expect(textNodes).toHaveLength(1);
      expect(textNodes[0].id).toBe("abc123");
      expect(textNodes[0].content).toBe("");
      expect(textNodes[0].completed).toBe(false);
      expect(useDashboardStore.getState().lastEventId).toBe(1);
    });

    it("should accumulate text on text_delta", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "abc" }, 1);
      processEvent({ type: "text_delta", card_id: "abc", text: "Hello " } as TextDeltaEvent, 2);
      processEvent({ type: "text_delta", card_id: "abc", text: "World" } as TextDeltaEvent, 3);

      const textNode = findTreeNode(useDashboardStore.getState().tree, "abc");
      expect(textNode?.content).toBe("Hello World");
      expect(textNode?.completed).toBe(false);
    });

    it("should mark completed on text_end", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "abc" }, 1);
      processEvent({ type: "text_delta", card_id: "abc", text: "Done" } as TextDeltaEvent, 2);
      processEvent({ type: "text_end", card_id: "abc" }, 3);

      const textNode = findTreeNode(useDashboardStore.getState().tree, "abc");
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
      processEvent({ type: "text_start", card_id: "thinking-1" }, 1);

      const event: ToolStartEvent = {
        type: "tool_start",
        card_id: "thinking-1",
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
        tool_use_id: "toolu_abc",
      };
      processEvent(event, 10);

      const toolNode = findTreeNode(useDashboardStore.getState().tree, "tool-10");
      expect(toolNode).not.toBeNull();
      expect(toolNode!.type).toBe("tool");
      expect(toolNode!.toolName).toBe("Read");
      expect(toolNode!.toolInput).toEqual({ file_path: "/test.ts" });
      expect(toolNode!.toolUseId).toBe("toolu_abc");
      expect(toolNode!.completed).toBe(false);
    });

    it("should complete tool node on tool_result", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      processEvent({
        type: "tool_start",
        card_id: "t1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      } as ToolStartEvent, 2);
      processEvent({
        type: "tool_result",
        card_id: "t1",
        tool_name: "Bash",
        result: "file1.txt\nfile2.txt",
        is_error: false,
      } as ToolResultEvent, 3);

      const toolNode = findTreeNode(useDashboardStore.getState().tree, "tool-2");
      expect(toolNode?.toolResult).toBe("file1.txt\nfile2.txt");
      expect(toolNode?.isError).toBe(false);
      expect(toolNode?.completed).toBe(true);
    });

    it("should handle tool error", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      processEvent({
        type: "tool_start",
        card_id: "t1",
        tool_name: "Bash",
        tool_input: { command: "invalid" },
      } as ToolStartEvent, 2);
      processEvent({
        type: "tool_result",
        card_id: "t1",
        tool_name: "Bash",
        result: "command not found",
        is_error: true,
      } as ToolResultEvent, 3);

      const toolNode = findTreeNode(useDashboardStore.getState().tree, "tool-2");
      expect(toolNode?.isError).toBe(true);
      expect(toolNode?.completed).toBe(true);
    });

    it("should use fallback cardId when card_id is undefined", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({
        type: "tool_start",
        tool_name: "Read",
        tool_input: {},
      } as ToolStartEvent, 42);

      const toolNode = findTreeNode(useDashboardStore.getState().tree, "tool-42");
      expect(toolNode).not.toBeNull();
    });

    it("should match tool_result by tool_name when both card_ids are undefined", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      processEvent({
        type: "tool_start",
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
      } as ToolStartEvent, 10);
      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "hello",
        is_error: false,
      } as ToolResultEvent, 11);

      const toolNodes = collectNodes(useDashboardStore.getState().tree, "tool");
      expect(toolNodes).toHaveLength(1);
      expect(toolNodes[0].toolResult).toBe("hello");
      expect(toolNodes[0].completed).toBe(true);
    });

    it("should match tool_result to the last uncompleted tool with matching name", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      // Tool 1 (completed)
      processEvent({
        type: "tool_start",
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "tu1",
      } as ToolStartEvent, 2);
      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "done",
        is_error: false,
        tool_use_id: "tu1",
      } as ToolResultEvent, 3);

      // Tool 2 (uncompleted)
      processEvent({
        type: "tool_start",
        tool_name: "Bash",
        tool_input: {},
      } as ToolStartEvent, 4);

      // Result without tool_use_id should match Tool 2
      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "second",
        is_error: false,
      } as ToolResultEvent, 5);

      const toolNodes = collectNodes(useDashboardStore.getState().tree, "tool");
      expect(toolNodes).toHaveLength(2);
      expect(toolNodes[0].completed).toBe(true);
      expect(toolNodes[0].toolResult).toBe("done");
      expect(toolNodes[1].completed).toBe(true);
      expect(toolNodes[1].toolResult).toBe("second");
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
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({ type: "text_delta", card_id: "t1", text: "Analyzing..." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end", card_id: "t1" }, 3);

      // Tool card
      processEvent({
        type: "tool_start",
        card_id: "t1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_bash1",
      } as ToolStartEvent, 4);
      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "ok",
        is_error: false,
        tool_use_id: "toolu_bash1",
      } as ToolResultEvent, 5);

      // Text card 2
      processEvent({ type: "text_start", card_id: "t2" }, 6);
      processEvent({ type: "text_delta", card_id: "t2", text: "Done!" } as TextDeltaEvent, 7);

      const tree = useDashboardStore.getState().tree!;
      const textNodes = collectNodes(tree, "text");
      expect(textNodes).toHaveLength(2);
      expect(textNodes[0].id).toBe("t1");
      expect(textNodes[0].completed).toBe(true);
      expect(textNodes[1].id).toBe("t2");
      expect(textNodes[1].completed).toBe(false);

      const toolNodes = collectNodes(tree, "tool");
      expect(toolNodes).toHaveLength(1);
      expect(toolNodes[0].id).toBe("tool-4");
      expect(toolNodes[0].completed).toBe(true);
      expect(toolNodes[0].toolUseId).toBe("toolu_bash1");

      // tool은 t1의 자식이어야 함
      const t1 = findTreeNode(tree, "t1")!;
      expect(t1.children.some((c) => c.id === "tool-4")).toBe(true);
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

    it("text is user_message's child", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      expect(userMsg.children).toHaveLength(1);
      expect(userMsg.children[0].type).toBe("text");
    });

    it("tool is text's child", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({
        type: "tool_start",
        tool_name: "Bash",
        tool_input: {},
      } as ToolStartEvent, 2);

      const textNode = findTreeNode(useDashboardStore.getState().tree, "t1")!;
      expect(textNode.children).toHaveLength(1);
      expect(textNode.children[0].type).toBe("tool");
    });

    it("complete is user_message's child", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      expect(userMsg.children.some((c) => c.type === "complete")).toBe(true);
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
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({ type: "text_end", card_id: "t1" }, 2);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 3);

      // Resume: new user_message
      processEvent({ type: "user_message", user: "u", text: "resume" } as UserMessageEvent, 4);
      processEvent({ type: "text_start", card_id: "t2" }, 5);

      const tree = useDashboardStore.getState().tree!;
      const userMsgs = tree.children.filter((c) => c.type === "user_message");
      expect(userMsgs).toHaveLength(2);
      expect(userMsgs[0].content).toBe("first");
      expect(userMsgs[1].content).toBe("resume");

      // t2 should be under the second user_message
      const secondTurn = userMsgs[1];
      expect(secondTurn.children.some((c) => c.id === "t2")).toBe(true);
    });

    it("session event sets root sessionId", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "session", session_id: "s1" } as SessionEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      expect(tree.sessionId).toBe("s1");
    });
  });

  // === 이벤트 노드 선택 ===

  describe("selectEventNode", () => {
    it("should set selectedEventNodeData and clear card/node selection", () => {
      useDashboardStore.getState().selectCard("card-1", "node-1");
      expect(useDashboardStore.getState().selectedCardId).toBe("card-1");
      expect(useDashboardStore.getState().selectedNodeId).toBe("node-1");

      const eventNodeData = {
        nodeType: "user",
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
        nodeType: "intervention",
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
  });


  // === 세션 생성/재개 ===

  describe("startCompose / cancelCompose", () => {
    it("should reset session state and set isComposing to true", () => {
      useDashboardStore.getState().setActiveSession("c1:r1");
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "t1" }, 1);
      useDashboardStore.getState().selectCard("t1");

      useDashboardStore.getState().startCompose();
      const state = useDashboardStore.getState();

      expect(state.isComposing).toBe(true);
      expect(state.resumeTargetKey).toBeNull();
      expect(state.activeSessionKey).toBeNull();
      expect(state.activeSession).toBeNull();
      expect(state.tree).toBeNull();
      expect(state.selectedCardId).toBeNull();
      expect(state.selectedNodeId).toBeNull();
      expect(state.selectedEventNodeData).toBeNull();
      expect(state.lastEventId).toBe(0);
    });

    it("should set isComposing to false and clear resumeTargetKey on cancel", () => {
      useDashboardStore.getState().startCompose();
      expect(useDashboardStore.getState().isComposing).toBe(true);

      useDashboardStore.getState().cancelCompose();
      const state = useDashboardStore.getState();
      expect(state.isComposing).toBe(false);
      expect(state.resumeTargetKey).toBeNull();
    });

    it("cancelCompose should clear resumeTargetKey from startResume", () => {
      useDashboardStore.getState().startResume("c1:r1");
      expect(useDashboardStore.getState().resumeTargetKey).toBe("c1:r1");

      useDashboardStore.getState().cancelCompose();
      expect(useDashboardStore.getState().isComposing).toBe(false);
      expect(useDashboardStore.getState().resumeTargetKey).toBeNull();
    });
  });

  // === 세션 재개 ===

  describe("startResume", () => {
    it("should preserve session state while setting isComposing and resumeTargetKey", () => {
      useDashboardStore.getState().setActiveSession("old:session");
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "x" }, 5);
      useDashboardStore.getState().processEvent({ type: "session", session_id: "s1" } as SessionEvent, 6);

      expect(useDashboardStore.getState().tree).not.toBeNull();
      expect(useDashboardStore.getState().lastEventId).toBe(6);

      useDashboardStore.getState().startResume("old:session");
      const state = useDashboardStore.getState();

      expect(state.isComposing).toBe(true);
      expect(state.resumeTargetKey).toBe("old:session");
      expect(state.activeSessionKey).toBe("old:session");
      expect(state.tree).not.toBeNull();
      expect(state.lastEventId).toBe(6);
    });

    it("should differ from startCompose: startCompose resets state, startResume preserves it", () => {
      useDashboardStore.getState().setActiveSession("existing:session");
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "t1" }, 1);
      useDashboardStore.getState().startCompose();

      expect(useDashboardStore.getState().isComposing).toBe(true);
      expect(useDashboardStore.getState().resumeTargetKey).toBeNull();
      expect(useDashboardStore.getState().activeSessionKey).toBeNull();
      expect(useDashboardStore.getState().tree).toBeNull();

      useDashboardStore.getState().reset();

      useDashboardStore.getState().setActiveSession("existing:session");
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "t1" }, 1);
      useDashboardStore.getState().startResume("existing:session");

      expect(useDashboardStore.getState().isComposing).toBe(true);
      expect(useDashboardStore.getState().resumeTargetKey).toBe("existing:session");
      expect(useDashboardStore.getState().activeSessionKey).toBe("existing:session");
      expect(useDashboardStore.getState().tree).not.toBeNull();
    });
  });

  // === clearTree ===

  describe("clearTree", () => {
    it("should clear tree and related state", () => {
      const { processEvent, selectCard } =
        useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({ type: "text_delta", card_id: "t1", text: "content" } as TextDeltaEvent, 2);
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

    it("should not affect sessions or activeSessionKey", () => {
      const sessions: SessionSummary[] = [
        { clientId: "c1", requestId: "r1", status: "running", eventCount: 5, createdAt: "2026-01-01T00:00:00Z" },
      ];
      useDashboardStore.getState().setSessions(sessions);
      useDashboardStore.getState().setActiveSession("c1:r1");
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "t1" }, 1);

      useDashboardStore.getState().clearTree();

      expect(useDashboardStore.getState().sessions).toEqual(sessions);
    });
  });

  // === 초기화 ===

  describe("reset", () => {
    it("should reset all state to initial values", () => {
      const { processEvent, setSessions, setActiveSession, selectCard } =
        useDashboardStore.getState();

      setSessions([
        { clientId: "c", requestId: "r", status: "running", eventCount: 1 },
      ]);
      setActiveSession("c:r");
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "x" }, 1);
      selectCard("x");

      useDashboardStore.getState().reset();
      const state = useDashboardStore.getState();

      expect(state.sessions).toEqual([]);
      expect(state.activeSessionKey).toBeNull();
      expect(state.tree).toBeNull();
      expect(state.selectedCardId).toBeNull();
      expect(state.lastEventId).toBe(0);
    });
  });
});
