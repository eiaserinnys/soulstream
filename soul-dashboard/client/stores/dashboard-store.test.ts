/**
 * dashboard-store 테스트
 *
 * Zustand 스토어의 트리 기반 이벤트 처리 로직을 검증합니다.
 * 세션 키는 agentSessionId (예: "sess-xxx") 형식입니다.
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
  SubagentStartEvent,
  SubagentStopEvent,
  ResultEvent,
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
          agentSessionId: "sess-abc",
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

    // === 세션 목록 CRUD (SSE 구독 지원) ===

    describe("addSession", () => {
      it("should add new session to the beginning of the list", () => {
        const existing: SessionSummary[] = [
          { agentSessionId: "sess-old", status: "completed", eventCount: 10, createdAt: "2026-01-01T00:00:00Z" },
        ];
        useDashboardStore.getState().setSessions(existing);

        const newSession: SessionSummary = {
          agentSessionId: "sess-new",
          status: "running",
          eventCount: 0,
          createdAt: "2026-01-02T00:00:00Z",
        };
        useDashboardStore.getState().addSession(newSession);

        const sessions = useDashboardStore.getState().sessions;
        expect(sessions).toHaveLength(2);
        expect(sessions[0].agentSessionId).toBe("sess-new");
        expect(sessions[1].agentSessionId).toBe("sess-old");
      });

      it("should not add duplicate session", () => {
        useDashboardStore.getState().setSessions([
          { agentSessionId: "sess-abc", status: "running", eventCount: 3, createdAt: "2026-01-01T00:00:00Z" },
        ]);

        useDashboardStore.getState().addSession({
          agentSessionId: "sess-abc",
          status: "running",
          eventCount: 5,
          createdAt: "2026-01-01T00:00:00Z",
        });

        expect(useDashboardStore.getState().sessions).toHaveLength(1);
        // 기존 값이 유지되어야 함
        expect(useDashboardStore.getState().sessions[0].eventCount).toBe(3);
      });

      it("should clear sessionsError on add", () => {
        useDashboardStore.getState().setSessionsError("some error");
        useDashboardStore.getState().addSession({
          agentSessionId: "sess-new",
          status: "running",
          eventCount: 0,
          createdAt: "2026-01-01T00:00:00Z",
        });

        expect(useDashboardStore.getState().sessionsError).toBeNull();
      });
    });

    describe("updateSession", () => {
      it("should update existing session's status", () => {
        useDashboardStore.getState().setSessions([
          { agentSessionId: "sess-abc", status: "running", eventCount: 5, createdAt: "2026-01-01T00:00:00Z" },
          { agentSessionId: "sess-def", status: "running", eventCount: 3, createdAt: "2026-01-01T00:00:00Z" },
        ]);

        useDashboardStore.getState().updateSession("sess-abc", {
          status: "completed",
          completedAt: "2026-01-02T00:00:00Z",
        });

        const sessions = useDashboardStore.getState().sessions;
        expect(sessions[0].status).toBe("completed");
        expect(sessions[0].completedAt).toBe("2026-01-02T00:00:00Z");
        // 다른 세션은 변경되지 않아야 함
        expect(sessions[1].status).toBe("running");
      });

      it("should do nothing if session not found", () => {
        useDashboardStore.getState().setSessions([
          { agentSessionId: "sess-abc", status: "running", eventCount: 5, createdAt: "2026-01-01T00:00:00Z" },
        ]);

        useDashboardStore.getState().updateSession("sess-nonexistent", { status: "completed" });

        expect(useDashboardStore.getState().sessions).toHaveLength(1);
        expect(useDashboardStore.getState().sessions[0].status).toBe("running");
      });

      it("should allow partial updates", () => {
        useDashboardStore.getState().setSessions([
          { agentSessionId: "sess-abc", status: "running", eventCount: 5, createdAt: "2026-01-01T00:00:00Z", prompt: "test" },
        ]);

        useDashboardStore.getState().updateSession("sess-abc", { eventCount: 10 });

        const session = useDashboardStore.getState().sessions[0];
        expect(session.eventCount).toBe(10);
        expect(session.status).toBe("running"); // 변경되지 않음
        expect(session.prompt).toBe("test"); // 변경되지 않음
      });
    });

    describe("removeSession", () => {
      it("should remove session from list", () => {
        useDashboardStore.getState().setSessions([
          { agentSessionId: "sess-abc", status: "running", eventCount: 5, createdAt: "2026-01-01T00:00:00Z" },
          { agentSessionId: "sess-def", status: "completed", eventCount: 3, createdAt: "2026-01-01T00:00:00Z" },
        ]);

        useDashboardStore.getState().removeSession("sess-abc");

        const sessions = useDashboardStore.getState().sessions;
        expect(sessions).toHaveLength(1);
        expect(sessions[0].agentSessionId).toBe("sess-def");
      });

      it("should do nothing if session not found", () => {
        useDashboardStore.getState().setSessions([
          { agentSessionId: "sess-abc", status: "running", eventCount: 5, createdAt: "2026-01-01T00:00:00Z" },
        ]);

        useDashboardStore.getState().removeSession("sess-nonexistent");

        expect(useDashboardStore.getState().sessions).toHaveLength(1);
      });

      it("should handle removing last session", () => {
        useDashboardStore.getState().setSessions([
          { agentSessionId: "sess-abc", status: "running", eventCount: 5, createdAt: "2026-01-01T00:00:00Z" },
        ]);

        useDashboardStore.getState().removeSession("sess-abc");

        expect(useDashboardStore.getState().sessions).toHaveLength(0);
      });
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
  });


  // === 세션 생성/재개 ===

  describe("startCompose / cancelCompose", () => {
    it("should reset session state and set isComposing to true", () => {
      useDashboardStore.getState().setActiveSession("sess-abc");
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
      useDashboardStore.getState().startResume("sess-abc");
      expect(useDashboardStore.getState().resumeTargetKey).toBe("sess-abc");

      useDashboardStore.getState().cancelCompose();
      expect(useDashboardStore.getState().isComposing).toBe(false);
      expect(useDashboardStore.getState().resumeTargetKey).toBeNull();
    });
  });

  // === 세션 재개 ===

  describe("startResume", () => {
    it("should preserve session state while setting isComposing and resumeTargetKey", () => {
      useDashboardStore.getState().setActiveSession("sess-old");
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "x" }, 5);
      useDashboardStore.getState().processEvent({ type: "session", session_id: "s1" } as SessionEvent, 6);

      expect(useDashboardStore.getState().tree).not.toBeNull();
      expect(useDashboardStore.getState().lastEventId).toBe(6);

      useDashboardStore.getState().startResume("sess-old");
      const state = useDashboardStore.getState();

      expect(state.isComposing).toBe(true);
      expect(state.resumeTargetKey).toBe("sess-old");
      expect(state.activeSessionKey).toBe("sess-old");
      expect(state.tree).not.toBeNull();
      expect(state.lastEventId).toBe(6);
    });

    it("should differ from startCompose: startCompose resets state, startResume preserves it", () => {
      useDashboardStore.getState().setActiveSession("sess-existing");
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

      useDashboardStore.getState().setActiveSession("sess-existing");
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "t1" }, 1);
      useDashboardStore.getState().startResume("sess-existing");

      expect(useDashboardStore.getState().isComposing).toBe(true);
      expect(useDashboardStore.getState().resumeTargetKey).toBe("sess-existing");
      expect(useDashboardStore.getState().activeSessionKey).toBe("sess-existing");
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
        { agentSessionId: "sess-abc", status: "running", eventCount: 5, createdAt: "2026-01-01T00:00:00Z" },
      ];
      useDashboardStore.getState().setSessions(sessions);
      useDashboardStore.getState().setActiveSession("sess-abc");
      useDashboardStore.getState().processEvent(
        { type: "user_message", user: "u", text: "hi" } as UserMessageEvent,
        0,
      );
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "t1" }, 1);

      useDashboardStore.getState().clearTree();

      expect(useDashboardStore.getState().sessions).toEqual(sessions);
    });
  });

  // === 낙관적 세션 추가 ===

  describe("addOptimisticSession", () => {
    it("should prepend new session to sessions array", () => {
      const existing: SessionSummary[] = [
        { agentSessionId: "sess-old", status: "completed", eventCount: 10, createdAt: "2026-01-01T00:00:00Z" },
      ];
      useDashboardStore.getState().setSessions(existing);

      useDashboardStore.getState().addOptimisticSession("sess-new", "hello");
      const sessions = useDashboardStore.getState().sessions;

      expect(sessions).toHaveLength(2);
      expect(sessions[0].agentSessionId).toBe("sess-new");
      expect(sessions[0].status).toBe("running");
      expect(sessions[0].eventCount).toBe(0);
      expect(sessions[0].prompt).toBe("hello");
      expect(sessions[1].agentSessionId).toBe("sess-old");
    });

    it("should not duplicate if session already exists", () => {
      useDashboardStore.getState().setSessions([
        { agentSessionId: "sess-abc", status: "running", eventCount: 3, createdAt: "2026-01-01T00:00:00Z" },
      ]);

      useDashboardStore.getState().addOptimisticSession("sess-abc", "dup");
      expect(useDashboardStore.getState().sessions).toHaveLength(1);
    });
  });

  // === 멀티턴 세션 상태 전환 ===

  describe("processEvent - session status derivation (multi-turn)", () => {
    beforeEach(() => {
      // 세션 목록에 running 세션 등록 + 활성 세션 설정
      useDashboardStore.getState().setSessions([
        { agentSessionId: "sess-mt", status: "running", eventCount: 0, createdAt: "2026-01-01T00:00:00Z" },
      ]);
      useDashboardStore.getState().setActiveSession("sess-mt");
    });

    it("should set status to 'completed' on complete event", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({ type: "text_end", card_id: "t1" }, 2);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 3);

      const session = useDashboardStore.getState().sessions.find(s => s.agentSessionId === "sess-mt");
      expect(session?.status).toBe("completed");
    });

    it("should set status to 'error' on error event", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      processEvent({ type: "error", message: "failed" } as ErrorEvent, 1);

      const session = useDashboardStore.getState().sessions.find(s => s.agentSessionId === "sess-mt");
      expect(session?.status).toBe("error");
    });

    it("should reset status to 'running' on user_message after complete (multi-turn)", () => {
      const { processEvent } = useDashboardStore.getState();

      // Turn 1: user_message → text → complete
      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({ type: "text_end", card_id: "t1" }, 2);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 3);

      expect(useDashboardStore.getState().sessions.find(s => s.agentSessionId === "sess-mt")?.status).toBe("completed");

      // Turn 2: new user_message (resume)
      processEvent({ type: "user_message", user: "u", text: "Turn 2" } as UserMessageEvent, 4);

      expect(useDashboardStore.getState().sessions.find(s => s.agentSessionId === "sess-mt")?.status).toBe("running");
    });

    it("should reset status to 'running' on intervention_sent after complete", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 1);

      expect(useDashboardStore.getState().sessions.find(s => s.agentSessionId === "sess-mt")?.status).toBe("completed");

      // Intervention resumes the session
      processEvent({ type: "intervention_sent", user: "admin", text: "continue" } as InterventionSentEvent, 2);

      expect(useDashboardStore.getState().sessions.find(s => s.agentSessionId === "sess-mt")?.status).toBe("running");
    });

    it("should handle full multi-turn cycle: running → completed → running → completed", () => {
      const { processEvent } = useDashboardStore.getState();
      const getStatus = () =>
        useDashboardStore.getState().sessions.find(s => s.agentSessionId === "sess-mt")?.status;

      // Turn 1
      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      expect(getStatus()).toBe("running");

      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({ type: "text_end", card_id: "t1" }, 2);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 3);
      expect(getStatus()).toBe("completed");

      // Turn 2
      processEvent({ type: "user_message", user: "u", text: "Turn 2" } as UserMessageEvent, 4);
      expect(getStatus()).toBe("running");

      processEvent({ type: "text_start", card_id: "t2" }, 5);
      processEvent({ type: "text_end", card_id: "t2" }, 6);
      processEvent({ type: "complete", result: "done again", attachments: [] } as CompleteEvent, 7);
      expect(getStatus()).toBe("completed");
    });

    it("should not update status for unrelated event types (text_start, text_delta, etc.)", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      expect(useDashboardStore.getState().sessions.find(s => s.agentSessionId === "sess-mt")?.status).toBe("running");

      // These should NOT change status
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({ type: "text_delta", card_id: "t1", text: "hello" } as TextDeltaEvent, 2);
      processEvent({ type: "text_end", card_id: "t1" }, 3);
      processEvent({ type: "tool_start", card_id: "t1", tool_name: "Bash", tool_input: {} } as ToolStartEvent, 4);
      processEvent({ type: "tool_result", card_id: "t1", tool_name: "Bash", result: "ok", is_error: false } as ToolResultEvent, 5);

      expect(useDashboardStore.getState().sessions.find(s => s.agentSessionId === "sess-mt")?.status).toBe("running");
    });

    it("should not update sessions when activeSessionKey is null", () => {
      useDashboardStore.getState().setActiveSession(null);
      useDashboardStore.getState().processEvent(
        { type: "complete", result: "done", attachments: [] } as CompleteEvent,
        0,
      );

      // sessions[0] should still be "running" (unchanged)
      expect(useDashboardStore.getState().sessions[0].status).toBe("running");
    });
  });

  // === 서브에이전트 구조 ===

  describe("processEvent - subagent structure", () => {
    it("Subagent 노드가 Task ToolUseBlock의 자식으로 배치", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      // Task tool 시작
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { subagent_type: "Explore" },
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 2);

      // Subagent 시작
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_tool_use_id: "toolu_task_1",
      } as SubagentStartEvent, 3);

      const tree = useDashboardStore.getState().tree!;
      const taskNode = findTreeNode(tree, "tool-2");
      expect(taskNode).not.toBeNull();
      expect(taskNode?.children).toHaveLength(1);
      expect(taskNode?.children[0].type).toBe("subagent");
      expect(taskNode?.children[0].agentId).toBe("agent-1");
      expect(taskNode?.children[0].agentType).toBe("Explore");
    });

    it("Subagent 내부 노드들이 Subagent의 자식으로 배치", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      // Task 시작
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: {},
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 2);

      // Subagent 시작
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_tool_use_id: "toolu_task_1",
      } as SubagentStartEvent, 3);

      // Subagent 내부 tool (parent_tool_use_id 포함)
      processEvent({
        type: "tool_start",
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
        tool_use_id: "toolu_2",
        parent_tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 4);

      const tree = useDashboardStore.getState().tree!;
      const taskNode = findTreeNode(tree, "tool-2");
      const subagentNode = taskNode?.children[0];
      expect(subagentNode?.type).toBe("subagent");
      expect(subagentNode?.children).toHaveLength(1);
      expect(subagentNode?.children[0].toolName).toBe("Read");
    });

    it("Subagent 내부 text_start가 Subagent의 자식으로 배치", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      // Task 시작
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: {},
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 2);

      // Subagent 시작
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_tool_use_id: "toolu_task_1",
      } as SubagentStartEvent, 3);

      // Subagent 내부 text (parent_tool_use_id 포함)
      processEvent({
        type: "text_start",
        card_id: "sub-text-1",
        parent_tool_use_id: "toolu_task_1",
      } as TextStartEvent, 4);

      processEvent({
        type: "text_delta",
        card_id: "sub-text-1",
        text: "Exploring...",
      } as TextDeltaEvent, 5);

      const tree = useDashboardStore.getState().tree!;
      const taskNode = findTreeNode(tree, "tool-2");
      const subagentNode = taskNode?.children[0];
      expect(subagentNode?.children).toHaveLength(1);
      expect(subagentNode?.children[0].type).toBe("text");
      expect(subagentNode?.children[0].content).toBe("Exploring...");
    });

    it("subagent_stop이 Subagent를 완료 상태로 변경", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: {},
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 2);

      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_tool_use_id: "toolu_task_1",
      } as SubagentStartEvent, 3);

      // Subagent 내부 작업
      processEvent({
        type: "tool_start",
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "toolu_2",
        parent_tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 4);

      // Subagent 종료
      processEvent({
        type: "subagent_stop",
        agent_id: "agent-1",
      } as SubagentStopEvent, 5);

      const tree = useDashboardStore.getState().tree!;
      const taskNode = findTreeNode(tree, "tool-2");
      const subagentNode = taskNode?.children[0];
      expect(subagentNode?.completed).toBe(true);
    });

    it("중첩 Subagent (2단계) 정상 렌더링", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      // 1단계 Task
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: {},
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 2);

      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "general-purpose",
        parent_tool_use_id: "toolu_task_1",
      } as SubagentStartEvent, 3);

      // 2단계 Task (agent-1 내부)
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: {},
        tool_use_id: "toolu_task_2",
        parent_tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 4);

      processEvent({
        type: "subagent_start",
        agent_id: "agent-2",
        agent_type: "Explore",
        parent_tool_use_id: "toolu_task_2",
      } as SubagentStartEvent, 5);

      const tree = useDashboardStore.getState().tree!;
      const task1 = findTreeNode(tree, "tool-2");
      expect(task1).not.toBeNull();

      const subagent1 = task1?.children[0];
      expect(subagent1?.agentType).toBe("general-purpose");

      const task2 = subagent1?.children[0];
      expect(task2?.toolName).toBe("Task");

      const subagent2 = task2?.children[0];
      expect(subagent2?.agentType).toBe("Explore");
    });

    it("병렬 tool 실행이 같은 Subagent 아래에 형제로 배치", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: {},
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 2);

      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_tool_use_id: "toolu_task_1",
      } as SubagentStartEvent, 3);

      // 병렬 tool 1
      processEvent({
        type: "tool_start",
        tool_name: "Glob",
        tool_input: { pattern: "*.ts" },
        tool_use_id: "toolu_2",
        parent_tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 4);

      // 병렬 tool 2
      processEvent({
        type: "tool_start",
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
        tool_use_id: "toolu_3",
        parent_tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 5);

      const tree = useDashboardStore.getState().tree!;
      const taskNode = findTreeNode(tree, "tool-2");
      const subagentNode = taskNode?.children[0];

      expect(subagentNode?.children).toHaveLength(2);
      expect(subagentNode?.children[0].toolName).toBe("Glob");
      expect(subagentNode?.children[1].toolName).toBe("Read");
    });

    it("parent_tool_use_id 불일치 시 subagent가 root에 배치 (방어)", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);

      // Task tool 시작
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { subagent_type: "shay-dev" },
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 2);

      // Subagent 시작 — parent_tool_use_id가 매칭되지 않는 경우 (방어 케이스)
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "shay-dev",
        parent_tool_use_id: "unknown-id",
      } as SubagentStartEvent, 3);

      const tree = useDashboardStore.getState().tree!;

      // 매칭 실패 시 root에 배치
      const rootSubagents = tree.children.filter(c => c.type === "subagent");
      expect(rootSubagents).toHaveLength(1);
      expect(rootSubagents[0].agentId).toBe("agent-1");
    });
  });

  // === result 이벤트 ===

  describe("processEvent - result event", () => {
    it("result 이벤트가 root의 자식으로 배치", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({ type: "text_end", card_id: "t1" }, 2);

      processEvent({
        type: "result",
        success: true,
        output: "Task completed successfully",
        duration_ms: 5000,
        usage: { input_tokens: 1000, output_tokens: 500 },
        total_cost_usd: 0.01,
      } as ResultEvent, 3);

      const tree = useDashboardStore.getState().tree!;
      const resultNodes = collectNodes(tree, "result");
      expect(resultNodes).toHaveLength(1);
      expect(resultNodes[0].content).toBe("Task completed successfully");
      expect(resultNodes[0].durationMs).toBe(5000);
      expect(resultNodes[0].usage).toEqual({ input_tokens: 1000, output_tokens: 500 });
      expect(resultNodes[0].totalCostUsd).toBe(0.01);
    });
  });

  // === 세션 재오픈 무결성 ===

  describe("processEvent - session reopen integrity", () => {
    /** 세션 A: user→text→tool→text→complete */
    function replaySessionA(processEvent: (event: any, eventId: number) => void) {
      processEvent({ type: "user_message", user: "u", text: "Session A" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "a-t1" }, 1);
      processEvent({ type: "text_delta", card_id: "a-t1", text: "Analyzing..." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end", card_id: "a-t1" }, 3);
      processEvent({ type: "tool_start", card_id: "a-t1", tool_name: "Read", tool_input: { file_path: "/test.ts" }, tool_use_id: "tu-a1" } as ToolStartEvent, 4);
      processEvent({ type: "tool_result", card_id: "a-t1", tool_name: "Read", result: "content", is_error: false, tool_use_id: "tu-a1" } as ToolResultEvent, 5);
      processEvent({ type: "text_start", card_id: "a-t2" }, 6);
      processEvent({ type: "text_delta", card_id: "a-t2", text: "Done." } as TextDeltaEvent, 7);
      processEvent({ type: "text_end", card_id: "a-t2" }, 8);
      processEvent({ type: "complete", result: "Session A done", attachments: [] } as CompleteEvent, 9);
    }

    /** 세션 B: user→text→complete (tool 없음) */
    function replaySessionB(processEvent: (event: any, eventId: number) => void) {
      processEvent({ type: "user_message", user: "u", text: "Session B" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "b-t1" }, 1);
      processEvent({ type: "text_delta", card_id: "b-t1", text: "Simple answer." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end", card_id: "b-t1" }, 3);
      processEvent({ type: "complete", result: "Session B done", attachments: [] } as CompleteEvent, 4);
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
      processEvent({ type: "text_start", card_id: "a-t1" }, 1);
      processEvent({ type: "tool_start", card_id: "a-t1", tool_name: "Read", tool_input: {}, tool_use_id: "tu-a1" } as ToolStartEvent, 2);

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
      processEvent({ type: "text_start", card_id: "a-t1" }, 1);
      processEvent({ type: "tool_start", card_id: "a-t1", tool_name: "Read", tool_input: {}, tool_use_id: "tu-a1" } as ToolStartEvent, 4);
      processEvent({ type: "tool_result", card_id: "a-t1", tool_name: "Read", result: "ok", is_error: false, tool_use_id: "tu-a1" } as ToolResultEvent, 5);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 9);

      // Session B: eventId=4 → complete node (different type for same eventId!)
      setActiveSession("sess-B");
      processEvent({ type: "user_message", user: "u", text: "B" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "b-t1" }, 1);
      processEvent({ type: "text_end", card_id: "b-t1" }, 3);
      processEvent({ type: "complete", result: "B done", attachments: [] } as CompleteEvent, 4);

      // Switch back to A — replay
      setActiveSession("sess-A");
      processEvent({ type: "user_message", user: "u", text: "A" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "a-t1" }, 1);
      processEvent({ type: "tool_start", card_id: "a-t1", tool_name: "Read", tool_input: {}, tool_use_id: "tu-a1" } as ToolStartEvent, 4);
      processEvent({ type: "tool_result", card_id: "a-t1", tool_name: "Read", result: "ok", is_error: false, tool_use_id: "tu-a1" } as ToolResultEvent, 5);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 9);

      // Verify eventId=4 in session A is a tool node, not a complete node
      const tree = useDashboardStore.getState().tree!;
      const toolNode = findTreeNode(tree, "tool-4");
      expect(toolNode).not.toBeNull();
      expect(toolNode!.type).toBe("tool");
      expect(toolNode!.toolName).toBe("Read");
    });
  });

  // === 멀티턴 서브에이전트 ===

  describe("processEvent - multi-turn subagent", () => {
    /** 세션 C: 멀티턴 서브에이전트 시퀀스 */
    function replayMultiTurnSubagent(processEvent: (event: any, eventId: number) => void) {
      let id = 0;
      // Turn 1: user → tool(Skill, text 전) → text → complete
      processEvent({ type: "user_message", user: "u", text: "Load skill" } as UserMessageEvent, id++);
      processEvent({ type: "tool_start", tool_name: "Skill", tool_input: { skill: "dialogue" }, tool_use_id: "tu-skill" } as ToolStartEvent, id++);
      processEvent({ type: "tool_result", tool_name: "Skill", result: "ok", is_error: false, tool_use_id: "tu-skill" } as ToolResultEvent, id++);
      processEvent({ type: "text_start", card_id: "c-t1" }, id++);
      processEvent({ type: "text_delta", card_id: "c-t1", text: "Loaded." } as TextDeltaEvent, id++);
      processEvent({ type: "text_end", card_id: "c-t1" }, id++);
      processEvent({ type: "complete", result: "Skill loaded", attachments: [] } as CompleteEvent, id++);

      // Turn 2: user → text → Task(subagent) → subagent 내부 tool → subagent stop → text → complete
      processEvent({ type: "user_message", user: "u", text: "Analyze" } as UserMessageEvent, id++);
      processEvent({ type: "text_start", card_id: "c-t2" }, id++);
      processEvent({ type: "text_delta", card_id: "c-t2", text: "Exploring..." } as TextDeltaEvent, id++);
      processEvent({ type: "text_end", card_id: "c-t2" }, id++);
      // Task tool
      processEvent({ type: "tool_start", tool_name: "Task", tool_input: { subagent_type: "Explore" }, tool_use_id: "tu-task1" } as ToolStartEvent, id++);
      // Subagent
      processEvent({ type: "subagent_start", agent_id: "agent-1", agent_type: "Explore", parent_tool_use_id: "tu-task1" } as SubagentStartEvent, id++);
      // Subagent 내부 tool
      processEvent({ type: "tool_start", tool_name: "Grep", tool_input: {}, tool_use_id: "tu-sub-grep", parent_tool_use_id: "tu-task1" } as ToolStartEvent, id++);
      processEvent({ type: "tool_result", tool_name: "Grep", result: "found", is_error: false, tool_use_id: "tu-sub-grep", parent_tool_use_id: "tu-task1" } as ToolResultEvent, id++);
      processEvent({ type: "subagent_stop", agent_id: "agent-1", parent_tool_use_id: "tu-task1" } as SubagentStopEvent, id++);
      // Task result
      processEvent({ type: "tool_result", tool_name: "Task", result: "Explored", is_error: false, tool_use_id: "tu-task1" } as ToolResultEvent, id++);
      // Post-subagent text
      processEvent({ type: "text_start", card_id: "c-t3" }, id++);
      processEvent({ type: "text_delta", card_id: "c-t3", text: "Found results." } as TextDeltaEvent, id++);
      processEvent({ type: "text_end", card_id: "c-t3" }, id++);
      processEvent({ type: "complete", result: "Done", attachments: [] } as CompleteEvent, id++);
    }

    /** 세션 B: 단순 세션 (reopen 테스트용) */
    function replaySimpleSessionB(processEvent: (event: any, eventId: number) => void) {
      processEvent({ type: "user_message", user: "u", text: "Session B" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "b-t1" }, 1);
      processEvent({ type: "text_delta", card_id: "b-t1", text: "Simple answer." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end", card_id: "b-t1" }, 3);
      processEvent({ type: "complete", result: "Session B done", attachments: [] } as CompleteEvent, 4);
    }

    /** 트리를 재귀 순회하여 타입별 노드 수 집계 */
    function snapshotTree(tree: EventTreeNode | null): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const node of collectNodes(tree)) {
        counts[node.type] = (counts[node.type] ?? 0) + 1;
      }
      return counts;
    }

    it("멀티턴 서브에이전트 트리 구조 검증", () => {
      const { processEvent } = useDashboardStore.getState();
      replayMultiTurnSubagent(processEvent);

      const tree = useDashboardStore.getState().tree!;

      // Turn 1: user_message, tool(Skill), text
      const turn1 = tree.children[0];
      expect(turn1.type).toBe("user_message");
      expect(turn1.content).toBe("Load skill");
      const turn1Tools = collectNodes(turn1, "tool");
      expect(turn1Tools).toHaveLength(1);
      expect(turn1Tools[0].toolName).toBe("Skill");
      const turn1Texts = collectNodes(turn1, "text");
      expect(turn1Texts).toHaveLength(1);

      // Turn 2: user_message, text(2개), tool(Task + Grep inside subagent), subagent
      const turn2 = tree.children[1];
      expect(turn2.type).toBe("user_message");
      expect(turn2.content).toBe("Analyze");
      const turn2Texts = collectNodes(turn2, "text");
      expect(turn2Texts).toHaveLength(2); // c-t2, c-t3
      const turn2Subagents = collectNodes(turn2, "subagent");
      expect(turn2Subagents).toHaveLength(1);
      expect(turn2Subagents[0].agentType).toBe("Explore");

      // Subagent는 Task tool의 자식
      const taskNode = collectNodes(turn2, "tool").find(t => t.toolName === "Task");
      expect(taskNode).toBeDefined();
      expect(taskNode!.children.some(c => c.type === "subagent")).toBe(true);

      // Subagent 내부 tool이 subagent의 자식
      const subagentNode = turn2Subagents[0];
      expect(subagentNode.children.some(c => c.toolName === "Grep")).toBe(true);
    });

    it("멀티턴 서브에이전트 세션 재오픈 무결성", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();

      // Session C: first load
      setActiveSession("sess-C");
      replayMultiTurnSubagent(processEvent);
      const snapC1 = snapshotTree(useDashboardStore.getState().tree);

      // Switch to B
      setActiveSession("sess-B");
      replaySimpleSessionB(processEvent);

      // Switch back to C (cache replay)
      setActiveSession("sess-C");
      replayMultiTurnSubagent(processEvent);
      const snapC2 = snapshotTree(useDashboardStore.getState().tree);

      // C2 should match C1
      expect(snapC2).toEqual(snapC1);
      expect(snapC2["subagent"]).toBe(1);
      expect(snapC2["user_message"]).toBe(2);

      // No B nodes leaked into C
      const allNodes = collectNodes(useDashboardStore.getState().tree);
      const bNodeLeaks = allNodes.filter(n => n.content.includes("Session B"));
      expect(bNodeLeaks).toHaveLength(0);
    });

    it("서브에이전트 이벤트 누락 시에도 tool이 올바른 턴에 배치", () => {
      const { processEvent } = useDashboardStore.getState();

      // Turn 1
      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({ type: "text_end", card_id: "t1" }, 2);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 3);

      // Turn 2: Task tool with parent_tool_use_id but NO subagent_start/stop
      processEvent({ type: "user_message", user: "u", text: "Turn 2" } as UserMessageEvent, 4);
      processEvent({ type: "text_start", card_id: "t2" }, 5);
      processEvent({ type: "text_end", card_id: "t2" }, 6);
      processEvent({ type: "tool_start", tool_name: "Task", tool_input: {}, tool_use_id: "tu-task" } as ToolStartEvent, 7);
      // Inner tool with parent_tool_use_id (subagent event missing)
      processEvent({ type: "tool_start", tool_name: "Grep", tool_input: {}, tool_use_id: "tu-grep", parent_tool_use_id: "tu-task" } as ToolStartEvent, 8);
      processEvent({ type: "tool_result", tool_name: "Grep", result: "ok", is_error: false, tool_use_id: "tu-grep", parent_tool_use_id: "tu-task" } as ToolResultEvent, 9);
      processEvent({ type: "tool_result", tool_name: "Task", result: "done", is_error: false, tool_use_id: "tu-task" } as ToolResultEvent, 10);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 11);

      const tree = useDashboardStore.getState().tree!;

      // Should not crash, 2 user_message turns
      const userMsgs = tree.children.filter(c => c.type === "user_message");
      expect(userMsgs).toHaveLength(2);

      // Turn 2 should have the Task tool
      const turn2Tools = collectNodes(userMsgs[1], "tool");
      expect(turn2Tools.length).toBeGreaterThanOrEqual(1);
      expect(turn2Tools.some(t => t.toolName === "Task")).toBe(true);

      // Grep은 Turn 2 어딘가에 배치되어야 함 (subagent 없이도 크래시하지 않음)
      const grepInTurn2 = collectNodes(userMsgs[1], "tool").filter(t => t.toolName === "Grep");
      expect(grepInTurn2).toHaveLength(1);
    });
  });

  // === 순차 서브에이전트 lastTextNodeId 오염 방지 ===

  describe("processEvent - sequential subagent isolation", () => {
    it("서브에이전트 내부 text가 lastTextNodeId를 오염하지 않아 후속 Task가 올바른 부모에 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      let id = 0;

      // Turn: user → text → Task-1 → subagent-1(text+tool) → subagent-1 stop → Task-2
      processEvent({ type: "user_message", user: "u", text: "Run tasks" } as UserMessageEvent, id++);
      processEvent({ type: "text_start", card_id: "main-text" }, id++);
      processEvent({ type: "text_delta", card_id: "main-text", text: "Planning..." } as TextDeltaEvent, id++);
      processEvent({ type: "text_end", card_id: "main-text" }, id++);

      // Task-1
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { prompt: "Explore" },
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, id++);

      // Subagent-1
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_tool_use_id: "toolu_task_1",
      } as SubagentStartEvent, id++);

      // Subagent-1 내부 text (이것이 lastTextNodeId를 오염하면 안됨)
      processEvent({
        type: "text_start",
        card_id: "agent-1-text",
        parent_tool_use_id: "toolu_task_1",
      }, id++);
      processEvent({ type: "text_delta", card_id: "agent-1-text", text: "Searching..." } as TextDeltaEvent, id++);
      processEvent({ type: "text_end", card_id: "agent-1-text" }, id++);

      // Subagent-1 내부 tool
      processEvent({
        type: "tool_start",
        tool_name: "Grep",
        tool_input: {},
        tool_use_id: "toolu_grep",
        parent_tool_use_id: "toolu_task_1",
      } as ToolStartEvent, id++);
      processEvent({
        type: "tool_result",
        tool_name: "Grep",
        result: "found",
        is_error: false,
        tool_use_id: "toolu_grep",
        parent_tool_use_id: "toolu_task_1",
      } as ToolResultEvent, id++);

      // Subagent-1 종료
      processEvent({
        type: "subagent_stop",
        agent_id: "agent-1",
        parent_tool_use_id: "toolu_task_1",
      } as SubagentStopEvent, id++);
      processEvent({
        type: "tool_result",
        tool_name: "Task",
        result: "Explored",
        is_error: false,
        tool_use_id: "toolu_task_1",
      } as ToolResultEvent, id++);

      // Task-2: 루트 레벨 (parent_tool_use_id 없음)
      // 이것이 main-text의 자식이어야 하지, agent-1-text의 자식이면 안됨
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { prompt: "Review" },
        tool_use_id: "toolu_task_2",
      } as ToolStartEvent, id++);

      const tree = useDashboardStore.getState().tree!;
      const turn = tree.children[0]; // user_message
      const mainText = findTreeNode(turn, "main-text")!;

      // Task-1과 Task-2가 모두 main-text의 자식이어야 함
      const mainTextTools = mainText.children.filter(c => c.type === "tool");
      expect(mainTextTools).toHaveLength(2);
      expect(mainTextTools[0].toolName).toBe("Task");
      expect(mainTextTools[1].toolName).toBe("Task");

      // Task-2가 agent-1 내부에 잘못 배치되지 않았는지 확인
      const agent1 = collectNodes(tree, "subagent")[0];
      const agentInternalTools = collectNodes(agent1, "tool");
      // agent-1 내부에는 Grep만 있어야 함 (Task-2가 여기 있으면 안됨)
      expect(agentInternalTools.every(t => t.toolName === "Grep")).toBe(true);
    });

    it("서브에이전트 내부 thinking이 lastTextNodeId를 오염하지 않아 후속 Task가 올바른 부모에 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      let id = 0;

      processEvent({ type: "user_message", user: "u", text: "Run tasks" } as UserMessageEvent, id++);
      processEvent({ type: "text_start", card_id: "main-text" }, id++);
      processEvent({ type: "text_end", card_id: "main-text" }, id++);

      // Task-1
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { prompt: "Explore" },
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, id++);

      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_tool_use_id: "toolu_task_1",
      } as SubagentStartEvent, id++);

      // Subagent-1 내부 thinking (text_start 대신 thinking 이벤트)
      processEvent({
        type: "thinking",
        card_id: "agent-1-thinking",
        thinking: "Analyzing...",
        parent_tool_use_id: "toolu_task_1",
      } as ThinkingEvent, id++);

      // Subagent-1 종료
      processEvent({
        type: "subagent_stop",
        agent_id: "agent-1",
        parent_tool_use_id: "toolu_task_1",
      } as SubagentStopEvent, id++);
      processEvent({
        type: "tool_result",
        tool_name: "Task",
        result: "Explored",
        is_error: false,
        tool_use_id: "toolu_task_1",
      } as ToolResultEvent, id++);

      // Task-2: 루트 레벨
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { prompt: "Review" },
        tool_use_id: "toolu_task_2",
      } as ToolStartEvent, id++);

      const tree = useDashboardStore.getState().tree!;
      const turn = tree.children[0];
      const mainText = findTreeNode(turn, "main-text")!;

      // Task-1과 Task-2가 모두 main-text의 자식
      const mainTextTools = mainText.children.filter(c => c.type === "tool");
      expect(mainTextTools).toHaveLength(2);
      expect(mainTextTools[0].toolName).toBe("Task");
      expect(mainTextTools[1].toolName).toBe("Task");
    });
  });

  // === 초기화 ===

  describe("reset", () => {
    it("should reset all state to initial values", () => {
      const { processEvent, setSessions, setActiveSession, selectCard } =
        useDashboardStore.getState();

      setSessions([
        { agentSessionId: "sess-abc", status: "running", eventCount: 1 },
      ]);
      setActiveSession("sess-abc");
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
