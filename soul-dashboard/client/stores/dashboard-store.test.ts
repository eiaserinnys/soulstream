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
  ThinkingEvent,
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
      useDashboardStore.getState().processEvent({ type: "text_start" } as TextStartEvent, 1);

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
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Hello " } as TextDeltaEvent, 2);
      processEvent({ type: "text_delta", text: "World" } as TextDeltaEvent, 3);

      const textNode = findTreeNode(useDashboardStore.getState().tree, "text-1");
      expect(textNode?.content).toBe("Hello World");
      expect(textNode?.completed).toBe(false);
    });

    it("should mark completed on text_end", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
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
      processEvent({ type: "text_start" } as TextStartEvent, 1);

      const event: ToolStartEvent = {
        type: "tool_start",
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
        tool_use_id: "toolu_abc",
      } as ToolStartEvent;
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
      processEvent({ type: "text_start" } as TextStartEvent, 1);

      processEvent({
        type: "tool_start",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_bash1",
      } as ToolStartEvent, 2);
      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "file1.txt\nfile2.txt",
        is_error: false,
        tool_use_id: "toolu_bash1",
      } as ToolResultEvent, 3);

      const toolNode = findTreeNode(useDashboardStore.getState().tree, "tool-2");
      expect(toolNode?.toolResult).toBe("file1.txt\nfile2.txt");
      expect(toolNode?.isError).toBe(false);
      expect(toolNode?.completed).toBe(true);
    });

    it("should handle tool error", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);

      processEvent({
        type: "tool_start",
        tool_name: "Bash",
        tool_input: { command: "invalid" },
        tool_use_id: "toolu_bash2",
      } as ToolStartEvent, 2);
      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "command not found",
        is_error: true,
        tool_use_id: "toolu_bash2",
      } as ToolResultEvent, 3);

      const toolNode = findTreeNode(useDashboardStore.getState().tree, "tool-2");
      expect(toolNode?.isError).toBe(true);
      expect(toolNode?.completed).toBe(true);
    });

    it("tool_start → resolveParent로 턴 루트에 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({
        type: "tool_start",
        tool_name: "Read",
        tool_input: {},
      } as ToolStartEvent, 42);

      const tree = useDashboardStore.getState().tree!;
      const toolNode = findTreeNode(tree, "tool-42");
      expect(toolNode).not.toBeNull();

      // resolveParent로 턴 루트(user_message)에 배치
      const userMsg = tree.children[0];
      expect(userMsg.type).toBe("user_message");
      expect(userMsg.children.some(c => c.id === "tool-42")).toBe(true);

      // 에러 노드 없음 (parent_tool_use_id도 없으므로 정상 경로)
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes).toHaveLength(0);
    });

    it("tool_result without tool_use_id is silently ignored (no fallback matching)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);

      processEvent({
        type: "tool_start",
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
        tool_use_id: "tu1",
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
      expect(toolNodes[0].toolResult).toBeUndefined();
    });

    it("tool_result with matching tool_use_id completes the tool", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);

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

      const toolNodes = collectNodes(useDashboardStore.getState().tree, "tool");
      expect(toolNodes).toHaveLength(1);
      expect(toolNodes[0].completed).toBe(true);
      expect(toolNodes[0].toolResult).toBe("done");
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
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Analyzing..." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end" } as TextEndEvent, 3);

      // Tool card (no parent_tool_use_id → resolveParent → turn root)
      processEvent({
        type: "tool_start",
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
      processEvent({ type: "text_start" } as TextStartEvent, 6);
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
      expect(toolNodes[0].toolUseId).toBe("toolu_bash1");

      // tool은 user_message(턴 루트)의 자식이어야 함 (resolveParent)
      const userMsg = tree.children[0];
      expect(userMsg.children.some((c) => c.id === "tool-4")).toBe(true);
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
      processEvent({ type: "text_start" } as TextStartEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      expect(userMsg.children).toHaveLength(1);
      expect(userMsg.children[0].type).toBe("text");
    });

    it("tool is turn root's child (resolveParent)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({
        type: "tool_start",
        tool_name: "Bash",
        tool_input: {},
      } as ToolStartEvent, 2);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      expect(userMsg.children.some(c => c.type === "tool")).toBe(true);
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
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 2);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 3);

      // Resume: new user_message
      processEvent({ type: "user_message", user: "u", text: "resume" } as UserMessageEvent, 4);
      processEvent({ type: "text_start" } as TextStartEvent, 5);

      const tree = useDashboardStore.getState().tree!;
      const userMsgs = tree.children.filter((c) => c.type === "user_message");
      expect(userMsgs).toHaveLength(2);
      expect(userMsgs[0].content).toBe("first");
      expect(userMsgs[1].content).toBe("resume");

      // text-5 should be under the second user_message
      const secondTurn = userMsgs[1];
      expect(secondTurn.children.some((c) => c.id === "text-5")).toBe(true);
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
      useDashboardStore.getState().processEvent({ type: "text_start" } as TextStartEvent, 1);
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
      useDashboardStore.getState().processEvent({ type: "text_start" } as TextStartEvent, 5);
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
      useDashboardStore.getState().processEvent({ type: "text_start" } as TextStartEvent, 1);
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
      useDashboardStore.getState().processEvent({ type: "text_start" } as TextStartEvent, 1);
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
      useDashboardStore.getState().processEvent({ type: "text_start" } as TextStartEvent, 1);

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
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 2);
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
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 2);
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

      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 2);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 3);
      expect(getStatus()).toBe("completed");

      // Turn 2
      processEvent({ type: "user_message", user: "u", text: "Turn 2" } as UserMessageEvent, 4);
      expect(getStatus()).toBe("running");

      processEvent({ type: "text_start" } as TextStartEvent, 5);
      processEvent({ type: "text_end" } as TextEndEvent, 6);
      processEvent({ type: "complete", result: "done again", attachments: [] } as CompleteEvent, 7);
      expect(getStatus()).toBe("completed");
    });

    it("should not update status for unrelated event types (text_start, text_delta, etc.)", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      expect(useDashboardStore.getState().sessions.find(s => s.agentSessionId === "sess-mt")?.status).toBe("running");

      // These should NOT change status
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "hello" } as TextDeltaEvent, 2);
      processEvent({ type: "text_end" } as TextEndEvent, 3);
      processEvent({ type: "tool_start", tool_name: "Bash", tool_input: {} } as ToolStartEvent, 4);
      processEvent({ type: "tool_result", tool_name: "Bash", result: "ok", is_error: false } as ToolResultEvent, 5);

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
      processEvent({ type: "text_start" } as TextStartEvent, 1);

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
      expect(collectNodes(tree, "error")).toHaveLength(0);
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
      processEvent({ type: "text_start" } as TextStartEvent, 1);

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
      expect(collectNodes(tree, "error")).toHaveLength(0);
      const taskNode = findTreeNode(tree, "tool-2");
      const subagentNode = taskNode?.children[0];
      expect(subagentNode?.type).toBe("subagent");
      expect(subagentNode?.children).toHaveLength(1);
      expect(subagentNode?.children[0].toolName).toBe("Read");
    });

    it("Subagent 내부 text_start가 Subagent의 자식으로 배치", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);

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
        parent_tool_use_id: "toolu_task_1",
      } as TextStartEvent, 4);

      processEvent({
        type: "text_delta",
        text: "Exploring...",
      } as TextDeltaEvent, 5);

      const tree = useDashboardStore.getState().tree!;
      expect(collectNodes(tree, "error")).toHaveLength(0);
      const taskNode = findTreeNode(tree, "tool-2");
      const subagentNode = taskNode?.children[0];
      expect(subagentNode?.children).toHaveLength(1);
      expect(subagentNode?.children[0].type).toBe("text");
      expect(subagentNode?.children[0].content).toBe("Exploring...");
    });

    it("subagent_stop이 Subagent를 완료 상태로 변경", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);

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
      expect(collectNodes(tree, "error")).toHaveLength(0);
      const taskNode = findTreeNode(tree, "tool-2");
      const subagentNode = taskNode?.children[0];
      expect(subagentNode?.completed).toBe(true);
    });

    it("중첩 Subagent (2단계) 정상 렌더링", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);

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
      expect(collectNodes(tree, "error")).toHaveLength(0);
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
      processEvent({ type: "text_start" } as TextStartEvent, 1);

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
      expect(collectNodes(tree, "error")).toHaveLength(0);
      const taskNode = findTreeNode(tree, "tool-2");
      const subagentNode = taskNode?.children[0];

      expect(subagentNode?.children).toHaveLength(2);
      expect(subagentNode?.children[0].toolName).toBe("Glob");
      expect(subagentNode?.children[1].toolName).toBe("Read");
    });

    it("parent_tool_use_id 불일치 시 에러 노드 삽입 + subagent가 root에 배치", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);

      // Task tool 시작
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { subagent_type: "shay-dev" },
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 2);

      // Subagent 시작 — parent_tool_use_id가 매칭되지 않는 경우
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "shay-dev",
        parent_tool_use_id: "unknown-id",
      } as SubagentStartEvent, 3);

      const tree = useDashboardStore.getState().tree!;

      // 에러 노드 삽입
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes.length).toBeGreaterThanOrEqual(1);
      expect(errorNodes.some(e => e.content.includes("toolUseMap 매칭 실패"))).toBe(true);

      // 매칭 실패 시 root에 배치
      const rootSubagents = tree.children.filter(c => c.type === "subagent");
      expect(rootSubagents).toHaveLength(1);
      expect(rootSubagents[0].agentId).toBe("agent-1");
    });

    it("parent_tool_use_id 빈 문자열 → 에러 노드 없이 턴 루트에 배치 (SDK 한계 대응)", () => {
      const { processEvent } = useDashboardStore.getState();

      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);

      // Task tool 시작
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { subagent_type: "Explore" },
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, 2);

      // Subagent 시작 — parent_tool_use_id가 빈 문자열 (SDK 한계)
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_tool_use_id: "",
      } as SubagentStartEvent, 3);

      const tree = useDashboardStore.getState().tree!;

      // 에러 노드가 없어야 함 (빈 parent_tool_use_id는 예상된 동작)
      expect(collectNodes(tree, "error")).toHaveLength(0);

      // 턴 루트(user_message)의 자식으로 배치
      const turnRoot = tree.children[0];
      expect(turnRoot.type).toBe("user_message");
      const subagents = turnRoot.children.filter(c => c.type === "subagent");
      expect(subagents).toHaveLength(1);
      expect(subagents[0].agentId).toBe("agent-1");
      expect(subagents[0].agentType).toBe("Explore");

      // 세션 루트에 직접 배치되지 않아야 함
      const rootSubagents = tree.children.filter(c => c.type === "subagent");
      expect(rootSubagents).toHaveLength(0);
    });

    it("parent_tool_use_id 빈 문자열 + 턴 루트 없음 → 세션 루트에 폴백", () => {
      const { processEvent } = useDashboardStore.getState();

      // user_message 없이 subagent_start 직접 수신 (비정상이지만 방어 코드 검증)
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_tool_use_id: "",
      } as SubagentStartEvent, 0);

      const tree = useDashboardStore.getState().tree!;

      // 에러 노드 없음
      expect(collectNodes(tree, "error")).toHaveLength(0);

      // 턴 루트가 없으므로 세션 루트에 폴백
      const subagents = tree.children.filter(c => c.type === "subagent");
      expect(subagents).toHaveLength(1);
      expect(subagents[0].agentId).toBe("agent-1");
    });

    it("parent_tool_use_id 빈 문자열 + 서브에이전트 내부 이벤트가 정상 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      let id = 0;

      processEvent({ type: "user_message", user: "u", text: "Run tasks" } as UserMessageEvent, id++);
      processEvent({ type: "text_start" } as TextStartEvent, id++);
      processEvent({ type: "text_end" } as TextEndEvent, id++);

      // Task tool 시작
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { subagent_type: "Explore" },
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, id++);

      // Subagent 시작 (빈 parent_tool_use_id)
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_tool_use_id: "",
      } as SubagentStartEvent, id++);

      // Subagent 내부 tool (parent_tool_use_id 있음 → resolveParent 경유)
      processEvent({
        type: "tool_start",
        tool_name: "Grep",
        tool_input: { pattern: "test" },
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

      // Subagent 종료
      processEvent({
        type: "subagent_stop",
        agent_id: "agent-1",
        parent_tool_use_id: "",
      } as SubagentStopEvent, id++);

      const tree = useDashboardStore.getState().tree!;
      expect(collectNodes(tree, "error")).toHaveLength(0);

      // 턴 루트에 subagent가 배치됨
      const turnRoot = tree.children[0];
      const subagents = turnRoot.children.filter(c => c.type === "subagent");
      expect(subagents).toHaveLength(1);
      expect(subagents[0].completed).toBe(true);
    });

    it("병렬 서브에이전트 — 빈 parent_tool_use_id로 모두 턴 루트에 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      let id = 0;

      processEvent({ type: "user_message", user: "u", text: "Run parallel tasks" } as UserMessageEvent, id++);
      processEvent({ type: "text_start" } as TextStartEvent, id++);
      processEvent({ type: "text_end" } as TextEndEvent, id++);

      // Task-1
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { subagent_type: "Explore" },
        tool_use_id: "toolu_task_1",
      } as ToolStartEvent, id++);

      // Task-2 (병렬)
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { subagent_type: "code-reviewer" },
        tool_use_id: "toolu_task_2",
      } as ToolStartEvent, id++);

      // Subagent-1 (빈 parent_tool_use_id)
      processEvent({
        type: "subagent_start",
        agent_id: "agent-1",
        agent_type: "Explore",
        parent_tool_use_id: "",
      } as SubagentStartEvent, id++);

      // Subagent-2 (빈 parent_tool_use_id)
      processEvent({
        type: "subagent_start",
        agent_id: "agent-2",
        agent_type: "code-reviewer",
        parent_tool_use_id: "",
      } as SubagentStartEvent, id++);

      const tree = useDashboardStore.getState().tree!;
      expect(collectNodes(tree, "error")).toHaveLength(0);

      // 턴 루트에 두 서브에이전트가 모두 배치
      const turnRoot = tree.children[0];
      const subagents = turnRoot.children.filter(c => c.type === "subagent");
      expect(subagents).toHaveLength(2);
      expect(subagents[0].agentId).toBe("agent-1");
      expect(subagents[1].agentId).toBe("agent-2");

      // 세션 루트에는 서브에이전트 없음
      const rootSubagents = tree.children.filter(c => c.type === "subagent");
      expect(rootSubagents).toHaveLength(0);
    });
  });

  // === thinking + text 결합 ===

  describe("processEvent - thinking + text lifecycle", () => {
    it("thinking 노드 생성 → 턴 루트 자식으로 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({
        type: "thinking",
        thinking: "Let me think...",
      } as ThinkingEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      expect(userMsg.children).toHaveLength(1);
      expect(userMsg.children[0].type).toBe("thinking");
      expect(userMsg.children[0].content).toBe("Let me think...");
      expect(userMsg.children[0].id).toBe("thinking-1");
    });

    it("text_start가 같은 parent_tool_use_id의 thinking을 찾으면 별도 노드 생성하지 않음", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({
        type: "thinking",
        thinking: "Reasoning...",
      } as ThinkingEvent, 1);
      // text_start가 같은 parent 레벨 → thinking 노드 재사용
      processEvent({ type: "text_start" } as TextStartEvent, 2);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      // thinking 하나만 있어야 함 (text 노드 추가 생성 안 함)
      expect(userMsg.children).toHaveLength(1);
      expect(userMsg.children[0].type).toBe("thinking");
    });

    it("text_delta가 thinking 노드의 textContent를 갱신", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({
        type: "thinking",
        thinking: "Deep thought",
      } as ThinkingEvent, 1);
      processEvent({ type: "text_start" } as TextStartEvent, 2);
      processEvent({ type: "text_delta", text: "Here is " } as TextDeltaEvent, 3);
      processEvent({ type: "text_delta", text: "the answer." } as TextDeltaEvent, 4);

      const thinkingNode = findTreeNode(useDashboardStore.getState().tree, "thinking-1")!;
      expect(thinkingNode.type).toBe("thinking");
      expect(thinkingNode.textContent).toBe("Here is the answer.");
      // content(thinking 원문)는 변경되지 않음
      expect(thinkingNode.content).toBe("Deep thought");
    });

    it("text_end가 thinking 노드의 textCompleted를 설정하지만 completed는 유지", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({
        type: "thinking",
        thinking: "Pondering",
      } as ThinkingEvent, 1);
      processEvent({ type: "text_start" } as TextStartEvent, 2);
      processEvent({ type: "text_delta", text: "Answer" } as TextDeltaEvent, 3);
      processEvent({ type: "text_end" } as TextEndEvent, 4);

      const thinkingNode = findTreeNode(useDashboardStore.getState().tree, "thinking-1")!;
      expect(thinkingNode.textCompleted).toBe(true);
      // thinking 노드의 completed는 true (생성 시 설정)
      expect(thinkingNode.completed).toBe(true);
    });

    it("tool_start → resolveParent로 턴 루트에 배치 (thinking과 형제)", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({
        type: "thinking",
        thinking: "Planning to read file",
      } as ThinkingEvent, 1);
      processEvent({
        type: "tool_start",
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
        tool_use_id: "toolu_read1",
      } as ToolStartEvent, 2);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      // tool은 턴 루트(user_message)의 자식으로 배치 (thinking과 형제)
      expect(userMsg.children.some(c => c.type === "tool")).toBe(true);
      expect(userMsg.children.some(c => c.type === "thinking")).toBe(true);
    });

    it("thinking 없이 text_start → 독립 text 노드 생성", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Direct text" } as TextDeltaEvent, 2);
      processEvent({ type: "text_end" } as TextEndEvent, 3);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      const textNodes = collectNodes(userMsg, "text");
      expect(textNodes).toHaveLength(1);
      expect(textNodes[0].content).toBe("Direct text");
      expect(textNodes[0].completed).toBe(true);
    });

    it("text_start → 독립 text 노드 생성, text_delta로 activeTextTarget 갱신", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      const textNodes = collectNodes(userMsg, "text");
      // text 노드는 생성됨 (id: "text-1")
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
      } as ThinkingEvent, 1);
      processEvent({ type: "text_start" } as TextStartEvent, 2);
      processEvent({ type: "text_delta", text: "Response 1" } as TextDeltaEvent, 3);
      processEvent({ type: "text_end" } as TextEndEvent, 4);

      // 도구 호출 (resolveParent → 턴 루트)
      processEvent({
        type: "tool_start",
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "toolu_1",
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
      } as ThinkingEvent, 7);
      processEvent({ type: "text_start" } as TextStartEvent, 8);
      processEvent({ type: "text_delta", text: "Response 2" } as TextDeltaEvent, 9);
      processEvent({ type: "text_end" } as TextEndEvent, 10);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      const thinkingNodes = collectNodes(userMsg, "thinking");
      expect(thinkingNodes).toHaveLength(2);
      expect(thinkingNodes[0].content).toBe("First thought");
      expect(thinkingNodes[0].textContent).toBe("Response 1");
      expect(thinkingNodes[1].content).toBe("Second thought");
      expect(thinkingNodes[1].textContent).toBe("Response 2");

      // 도구는 턴 루트(user_message)의 자식 (thinking과 형제)
      const toolNodes = collectNodes(userMsg, "tool");
      expect(toolNodes).toHaveLength(1);
      expect(toolNodes[0].toolName).toBe("Read");
      expect(userMsg.children.some(c => c.type === "tool")).toBe(true);
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
      expect(resultNodes[0].usage).toEqual({ input_tokens: 1000, output_tokens: 500 });
      expect(resultNodes[0].totalCostUsd).toBe(0.01);
    });
  });

  // === 세션 재오픈 무결성 ===

  describe("processEvent - session reopen integrity", () => {
    /** 세션 A: user→text→tool→text→complete */
    function replaySessionA(processEvent: (event: any, eventId: number) => void) {
      processEvent({ type: "user_message", user: "u", text: "Session A" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Analyzing..." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end" } as TextEndEvent, 3);
      processEvent({ type: "tool_start", tool_name: "Read", tool_input: { file_path: "/test.ts" }, tool_use_id: "tu-a1" } as ToolStartEvent, 4);
      processEvent({ type: "tool_result", tool_name: "Read", result: "content", is_error: false, tool_use_id: "tu-a1" } as ToolResultEvent, 5);
      processEvent({ type: "text_start" } as TextStartEvent, 6);
      processEvent({ type: "text_delta", text: "Done." } as TextDeltaEvent, 7);
      processEvent({ type: "text_end" } as TextEndEvent, 8);
      processEvent({ type: "complete", result: "Session A done", attachments: [] } as CompleteEvent, 9);
    }

    /** 세션 B: user→text→complete (tool 없음) */
    function replaySessionB(processEvent: (event: any, eventId: number) => void) {
      processEvent({ type: "user_message", user: "u", text: "Session B" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Simple answer." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end" } as TextEndEvent, 3);
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
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "tool_start", tool_name: "Read", tool_input: {}, tool_use_id: "tu-a1" } as ToolStartEvent, 2);

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
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "tool_start", tool_name: "Read", tool_input: {}, tool_use_id: "tu-a1" } as ToolStartEvent, 4);
      processEvent({ type: "tool_result", tool_name: "Read", result: "ok", is_error: false, tool_use_id: "tu-a1" } as ToolResultEvent, 5);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 9);

      // Session B: eventId=4 → complete node (different type for same eventId!)
      setActiveSession("sess-B");
      processEvent({ type: "user_message", user: "u", text: "B" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 3);
      processEvent({ type: "complete", result: "B done", attachments: [] } as CompleteEvent, 4);

      // Switch back to A — replay
      setActiveSession("sess-A");
      processEvent({ type: "user_message", user: "u", text: "A" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "tool_start", tool_name: "Read", tool_input: {}, tool_use_id: "tu-a1" } as ToolStartEvent, 4);
      processEvent({ type: "tool_result", tool_name: "Read", result: "ok", is_error: false, tool_use_id: "tu-a1" } as ToolResultEvent, 5);
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
      // Turn 1: user → text → tool(Skill) → complete
      processEvent({ type: "user_message", user: "u", text: "Load skill" } as UserMessageEvent, id++);
      processEvent({ type: "text_start" } as TextStartEvent, id++);
      processEvent({ type: "tool_start", tool_name: "Skill", tool_input: { skill: "dialogue" }, tool_use_id: "tu-skill" } as ToolStartEvent, id++);
      processEvent({ type: "tool_result", tool_name: "Skill", result: "ok", is_error: false, tool_use_id: "tu-skill" } as ToolResultEvent, id++);
      processEvent({ type: "text_delta", text: "Loaded." } as TextDeltaEvent, id++);
      processEvent({ type: "text_end" } as TextEndEvent, id++);
      processEvent({ type: "complete", result: "Skill loaded", attachments: [] } as CompleteEvent, id++);

      // Turn 2: user → text → Task(subagent) → subagent 내부 tool → subagent stop → text → complete
      processEvent({ type: "user_message", user: "u", text: "Analyze" } as UserMessageEvent, id++);
      processEvent({ type: "text_start" } as TextStartEvent, id++);
      processEvent({ type: "text_delta", text: "Exploring..." } as TextDeltaEvent, id++);
      processEvent({ type: "text_end" } as TextEndEvent, id++);
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
      processEvent({ type: "text_start" } as TextStartEvent, id++);
      processEvent({ type: "text_delta", text: "Found results." } as TextDeltaEvent, id++);
      processEvent({ type: "text_end" } as TextEndEvent, id++);
      processEvent({ type: "complete", result: "Done", attachments: [] } as CompleteEvent, id++);
    }

    /** 세션 B: 단순 세션 (reopen 테스트용) */
    function replaySimpleSessionB(processEvent: (event: any, eventId: number) => void) {
      processEvent({ type: "user_message", user: "u", text: "Session B" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Simple answer." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end" } as TextEndEvent, 3);
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
      expect(turn2Texts).toHaveLength(2); // text-8, text-17
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

    it("서브에이전트 이벤트 누락 시 tool은 Task tool의 자식으로 배치 (subagent 없이)", () => {
      const { processEvent } = useDashboardStore.getState();

      // Turn 1
      processEvent({ type: "user_message", user: "u", text: "Turn 1" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_end" } as TextEndEvent, 2);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 3);

      // Turn 2: Task tool with parent_tool_use_id but NO subagent_start/stop
      processEvent({ type: "user_message", user: "u", text: "Turn 2" } as UserMessageEvent, 4);
      processEvent({ type: "text_start" } as TextStartEvent, 5);
      processEvent({ type: "text_end" } as TextEndEvent, 6);
      processEvent({ type: "tool_start", tool_name: "Task", tool_input: {}, tool_use_id: "tu-task" } as ToolStartEvent, 7);
      // Inner tool with parent_tool_use_id → resolveParent → toolUseMap["tu-task"] → subagent 없으면 tool 자체 반환
      processEvent({ type: "tool_start", tool_name: "Grep", tool_input: {}, tool_use_id: "tu-grep", parent_tool_use_id: "tu-task" } as ToolStartEvent, 8);
      processEvent({ type: "tool_result", tool_name: "Grep", result: "ok", is_error: false, tool_use_id: "tu-grep", parent_tool_use_id: "tu-task" } as ToolResultEvent, 9);
      processEvent({ type: "tool_result", tool_name: "Task", result: "done", is_error: false, tool_use_id: "tu-task" } as ToolResultEvent, 10);
      processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 11);

      const tree = useDashboardStore.getState().tree!;

      // Should not crash, 2 user_message turns
      const userMsgs = tree.children.filter(c => c.type === "user_message");
      expect(userMsgs).toHaveLength(2);

      // Turn 2 should have the Task tool (resolveParent → turn root)
      const turn2Tools = collectNodes(userMsgs[1], "tool");
      expect(turn2Tools.some(t => t.toolName === "Task")).toBe(true);

      // Grep은 Task tool의 자식으로 배치 (subagent 없이 resolveParent가 toolNode 반환)
      const taskNode = turn2Tools.find(t => t.toolName === "Task");
      expect(taskNode?.children.some(c => c.toolName === "Grep")).toBe(true);

      // 에러 노드 없음 (parent_tool_use_id가 toolUseMap에서 매칭 성공)
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes).toHaveLength(0);
    });
  });

  // === 순차 서브에이전트 격리 ===

  describe("processEvent - sequential subagent isolation", () => {
    it("서브에이전트 내부 text가 후속 Task의 부모에 영향 주지 않음 (resolveParent 기반)", () => {
      const { processEvent } = useDashboardStore.getState();
      let id = 0;

      // Turn: user → text → Task-1 → subagent-1(text+tool) → subagent-1 stop → Task-2
      processEvent({ type: "user_message", user: "u", text: "Run tasks" } as UserMessageEvent, id++);
      processEvent({ type: "text_start" } as TextStartEvent, id++);
      processEvent({ type: "text_delta", text: "Planning..." } as TextDeltaEvent, id++);
      processEvent({ type: "text_end" } as TextEndEvent, id++);

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

      // Subagent-1 내부 text (후속 Task의 배치에 영향 주면 안됨)
      processEvent({
        type: "text_start",
        parent_tool_use_id: "toolu_task_1",
      } as TextStartEvent, id++);
      processEvent({ type: "text_delta", text: "Searching..." } as TextDeltaEvent, id++);
      processEvent({ type: "text_end" } as TextEndEvent, id++);

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

      // Task-2: 루트 레벨 (parent_tool_use_id 없음, resolveParent → 턴 루트)
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { prompt: "Review" },
        tool_use_id: "toolu_task_2",
      } as ToolStartEvent, id++);

      const tree = useDashboardStore.getState().tree!;
      const turn = tree.children[0]; // user_message

      // Task-1과 Task-2가 모두 턴 루트의 자식이어야 함
      const turnTools = turn.children.filter(c => c.type === "tool");
      expect(turnTools).toHaveLength(2);
      expect(turnTools[0].toolName).toBe("Task");
      expect(turnTools[1].toolName).toBe("Task");

      // Task-2가 agent-1 내부에 잘못 배치되지 않았는지 확인
      const agent1 = collectNodes(tree, "subagent")[0];
      const agentInternalTools = collectNodes(agent1, "tool");
      // agent-1 내부에는 Grep만 있어야 함 (Task-2가 여기 있으면 안됨)
      expect(agentInternalTools.every(t => t.toolName === "Grep")).toBe(true);
    });

    it("서브에이전트 내부 thinking이 후속 Task의 부모에 영향 주지 않음 (resolveParent 기반)", () => {
      const { processEvent } = useDashboardStore.getState();
      let id = 0;

      processEvent({ type: "user_message", user: "u", text: "Run tasks" } as UserMessageEvent, id++);
      processEvent({ type: "text_start" } as TextStartEvent, id++);
      processEvent({ type: "text_end" } as TextEndEvent, id++);

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

      // Task-2: 루트 레벨 (resolveParent → 턴 루트)
      processEvent({
        type: "tool_start",
        tool_name: "Task",
        tool_input: { prompt: "Review" },
        tool_use_id: "toolu_task_2",
      } as ToolStartEvent, id++);

      const tree = useDashboardStore.getState().tree!;
      const turn = tree.children[0];

      // Task-1과 Task-2가 모두 턴 루트의 자식
      const turnTools = turn.children.filter(c => c.type === "tool");
      expect(turnTools).toHaveLength(2);
      expect(turnTools[0].toolName).toBe("Task");
      expect(turnTools[1].toolName).toBe("Task");
    });
  });

  // === 에러 노드 삽입 (orphan detection) ===

  describe("processEvent - orphan error node insertion", () => {
    it("tool이 resolveParent로 턴 루트에 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({
        type: "tool_start",
        tool_name: "Read",
        tool_input: {},
      } as ToolStartEvent, 2);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      // tool은 턴 루트(user_message)에 배치
      expect(userMsg.children.some(c => c.type === "tool")).toBe(true);
      const toolNode = userMsg.children.find(c => c.type === "tool");
      expect(toolNode?.toolName).toBe("Read");

      // 에러 노드 없음
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes).toHaveLength(0);
    });

    it("복수 tool이 resolveParent로 모두 턴 루트에 배치", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_start" } as TextStartEvent, 2);
      processEvent({
        type: "tool_start",
        tool_name: "Read",
        tool_input: {},
      } as ToolStartEvent, 3);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];

      // tool은 턴 루트에 배치
      const toolNodes = userMsg.children.filter(c => c.type === "tool");
      expect(toolNodes).toHaveLength(1);
      expect(toolNodes[0].toolName).toBe("Read");
    });

    it("parent_tool_use_id 매칭 실패 시 에러 노드 삽입", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({
        type: "tool_start",
        tool_name: "Read",
        tool_input: {},
        parent_tool_use_id: "nonexistent-id",
      } as ToolStartEvent, 2);

      const tree = useDashboardStore.getState().tree!;
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes.length).toBeGreaterThanOrEqual(1);
      expect(errorNodes[0].content).toContain("nonexistent-id");

      // tool은 root에 배치
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

    it("서브에이전트 내부 text_start에서 parent_tool_use_id 매칭 실패 시 에러 노드 삽입", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);

      // parent_tool_use_id가 있지만 매칭되는 subagent가 없는 text_start
      processEvent({
        type: "text_start",
        parent_tool_use_id: "nonexistent-parent",
      } as TextStartEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes.length).toBeGreaterThanOrEqual(1);
      expect(errorNodes[0].content).toContain("nonexistent-parent");

      // text는 root에 배치
      expect(tree.children.some(c => c.id === "text-1")).toBe(true);
    });

    it("서브에이전트 내부 thinking에서 parent_tool_use_id 매칭 실패 시 에러 노드 삽입", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);

      // parent_tool_use_id가 있지만 매칭되는 subagent가 없는 thinking
      processEvent({
        type: "thinking",
        thinking: "Lost thought...",
        parent_tool_use_id: "nonexistent-parent",
      } as ThinkingEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes.length).toBeGreaterThanOrEqual(1);
      expect(errorNodes[0].content).toContain("nonexistent-parent");

      // thinking은 root에 배치
      expect(tree.children.some(c => c.type === "thinking")).toBe(true);
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
      processEvent({ type: "text_start" } as TextStartEvent, 1);
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
