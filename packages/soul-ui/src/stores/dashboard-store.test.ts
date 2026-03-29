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
          agentId: "seo-soyoung",
          agentName: "서소영",
          agentPortraitUrl: null,
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

      it("should merge server data into existing session (optimistic update補完)", () => {
        // 낙관적 업데이트로 nodeId 없이 추가된 세션
        useDashboardStore.getState().setSessions([
          { agentSessionId: "sess-abc", status: "running", eventCount: 3, createdAt: "2026-01-01T00:00:00Z", prompt: "hello" },
        ]);

        // SSE session_created로 서버 데이터가 도착 — nodeId 포함
        useDashboardStore.getState().addSession({
          agentSessionId: "sess-abc",
          status: "running",
          eventCount: 5,
          createdAt: "2026-01-01T00:00:00Z",
          nodeId: "silent-manari",
        });

        const sessions = useDashboardStore.getState().sessions;
        expect(sessions).toHaveLength(1);
        // 서버 데이터로 머지됨
        expect(sessions[0].nodeId).toBe("silent-manari");
        expect(sessions[0].eventCount).toBe(5);
        // 낙관적 업데이트에만 있던 필드는 유지됨
        expect(sessions[0].prompt).toBe("hello");
      });

      it("should preserve optimistic fields not present in server data", () => {
        useDashboardStore.getState().setSessions([
          { agentSessionId: "sess-abc", status: "running", eventCount: 0, createdAt: "2026-01-01T00:00:00Z", prompt: "test prompt", nodeId: "node-1" },
        ]);

        // 서버 데이터에 prompt/nodeId가 없는 경우 — 낙관적 값 유지
        useDashboardStore.getState().addSession({
          agentSessionId: "sess-abc",
          status: "running",
          eventCount: 2,
          createdAt: "2026-01-01T00:00:00Z",
        });

        const session = useDashboardStore.getState().sessions[0];
        expect(session.prompt).toBe("test prompt");
        expect(session.nodeId).toBe("node-1");
        expect(session.eventCount).toBe(2);
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

      // parent_event_id: "0" → user_message에 배치
      const userMsg = tree.children[0];
      expect(userMsg.type).toBe("user_message");
      expect(userMsg.children.some(c => c.id === "tool-42")).toBe(true);

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

      // tool은 user_message의 자식이어야 함 (parent_event_id: "0")
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
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

      const tree = useDashboardStore.getState().tree!;
      const userMsg = tree.children[0];
      expect(userMsg.children).toHaveLength(1);
      expect(userMsg.children[0].type).toBe("text");
    });

    it("tool is user_message's child (parent_event_id)", () => {
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
      const userMsg = tree.children[0];
      expect(userMsg.children.some(c => c.type === "tool")).toBe(true);
    });

    it("complete is user_message's child", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "complete", result: "done", attachments: [], parent_event_id: "0" } as CompleteEvent, 1);

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

      // text-5 should be under the second user_message
      const secondTurn = userMsgs[1];
      expect(secondTurn.children.some((c) => c.id === "text-5")).toBe(true);
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
  });

  // === addOptimisticSession ===

  describe("addOptimisticSession", () => {
    it("should add session and set it as active", () => {
      useDashboardStore.getState().addOptimisticSession("sess-new", "hello");
      const state = useDashboardStore.getState();

      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0].agentSessionId).toBe("sess-new");
      expect(state.sessions[0].prompt).toBe("hello");
      expect(state.activeSessionKey).toBe("sess-new");
    });

    it("should not duplicate session if already exists", () => {
      useDashboardStore.getState().addOptimisticSession("sess-new", "hello");
      useDashboardStore.getState().addOptimisticSession("sess-new", "hello again");
      const state = useDashboardStore.getState();

      expect(state.sessions).toHaveLength(1);
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

    it("should assign folderId in catalog.sessions when folderId is provided", () => {
      const catalog: CatalogState = {
        folders: [{ id: "folder-1", name: "Test Folder" }],
        sessions: {},
      };
      useDashboardStore.getState().setCatalog(catalog);

      useDashboardStore.getState().addOptimisticSession("sess-folder", "hi", "folder-1");
      const state = useDashboardStore.getState();

      expect(state.catalog?.sessions["sess-folder"]).toEqual({
        folderId: "folder-1",
        displayName: null,
      });
      expect(state.sessions[0].agentSessionId).toBe("sess-folder");
    });

    it("should not modify catalog.sessions when folderId is null/undefined", () => {
      const catalog: CatalogState = {
        folders: [{ id: "folder-1", name: "Test Folder" }],
        sessions: { "sess-existing": { folderId: "folder-1", displayName: null } },
      };
      useDashboardStore.getState().setCatalog(catalog);

      useDashboardStore.getState().addOptimisticSession("sess-no-folder", "hi");
      const state = useDashboardStore.getState();

      // 기존 catalog.sessions는 그대로, 새 세션에 대한 할당은 없음
      expect(state.catalog?.sessions["sess-no-folder"]).toBeUndefined();
      expect(state.catalog?.sessions["sess-existing"]).toEqual({
        folderId: "folder-1",
        displayName: null,
      });
    });

    it("should include nodeId when provided", () => {
      useDashboardStore.getState().addOptimisticSession("sess-node", "hi", null, "silent-manari");
      const session = useDashboardStore.getState().sessions[0];

      expect(session.agentSessionId).toBe("sess-node");
      expect(session.nodeId).toBe("silent-manari");
    });

    it("should not include nodeId when not provided", () => {
      useDashboardStore.getState().addOptimisticSession("sess-no-node", "hi");
      const session = useDashboardStore.getState().sessions[0];

      expect(session.agentSessionId).toBe("sess-no-node");
      expect(session.nodeId).toBeUndefined();
    });

    it("should place session in correct folder via getSessionsInFolder", () => {
      const catalog: CatalogState = {
        folders: [{ id: "folder-1", name: "Test Folder" }],
        sessions: {},
      };
      useDashboardStore.getState().setCatalog(catalog);

      useDashboardStore.getState().addOptimisticSession("sess-in-folder", "hi", "folder-1");
      const inFolder = useDashboardStore.getState().getSessionsInFolder("folder-1");
      const inUncategorized = useDashboardStore.getState().getSessionsInFolder(null);

      expect(inFolder).toHaveLength(1);
      expect(inFolder[0].agentSessionId).toBe("sess-in-folder");
      expect(inUncategorized).toHaveLength(0);
    });

    it("should switch selectedFolderId to the new session's folder", () => {
      // 초기 폴더 선택: 'other-folder'
      useDashboardStore.getState().selectFolder("other-folder");
      expect(useDashboardStore.getState().selectedFolderId).toBe("other-folder");

      useDashboardStore.getState().addOptimisticSession("sess-new", "hi", "folder-1");

      const state = useDashboardStore.getState();
      expect(state.selectedFolderId).toBe("folder-1");
      expect(state.viewMode).toBe("folder");
    });

    it("should switch selectedFolderId to null when folderId is null (uncategorized)", () => {
      // 초기 폴더 선택: 'folder-1'
      useDashboardStore.getState().selectFolder("folder-1");
      expect(useDashboardStore.getState().selectedFolderId).toBe("folder-1");

      useDashboardStore.getState().addOptimisticSession("sess-new", "hi", null);

      const state = useDashboardStore.getState();
      expect(state.selectedFolderId).toBeNull();
      expect(state.viewMode).toBe("folder");
    });

    it("should not change selectedFolderId when folderId is undefined", () => {
      // 초기 폴더 선택: 'folder-1'
      useDashboardStore.getState().selectFolder("folder-1");
      expect(useDashboardStore.getState().selectedFolderId).toBe("folder-1");

      // folderId 인자 생략 (undefined)
      useDashboardStore.getState().addOptimisticSession("sess-new", "hi");

      expect(useDashboardStore.getState().selectedFolderId).toBe("folder-1");
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

      // history_sync를 보내 히스토리 리플레이 완료 상태로 전환
      // (리플레이 중에는 status 갱신이 억제되므로, 라이브 이벤트 테스트 전에 필수)
      useDashboardStore.getState().processEvent(
        { type: "history_sync", last_event_id: 0, is_live: true, status: "running" } as any,
        -1,
      );
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
      processEvent({ type: "tool_start", timestamp: 0, tool_name: "Bash", tool_input: {} } as ToolStartEvent, 4);
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

      // Inner tool — resolveParent finds toolu_task_1 in nodeMap, no subagent child → tool node itself
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
      // Read tool is placed as child of Task tool directly (no subagent intermediary)
      const taskNode = findTreeNode(tree, "tool-2");
      expect(taskNode?.children).toHaveLength(1);
      expect((taskNode?.children[0] as ToolNode).toolName).toBe("Read");
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
      const userMsg = tree.children[0];
      expect(userMsg.children).toHaveLength(1);
      expect(userMsg.children[0].type).toBe("thinking");
      expect(userMsg.children[0].content).toBe("Let me think...");
      expect(userMsg.children[0].id).toBe("thinking-1");
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
      const userMsg = tree.children[0];
      // thinking + text 두 개가 형제로 존재
      expect(userMsg.children).toHaveLength(2);
      expect(userMsg.children[0].type).toBe("thinking");
      expect(userMsg.children[1].type).toBe("text");
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
      const userMsg = tree.children[0];
      // tool은 user_message의 자식으로 배치 (thinking과 형제)
      expect(userMsg.children.some(c => c.type === "tool")).toBe(true);
      expect(userMsg.children.some(c => c.type === "thinking")).toBe(true);
    });

    it("thinking 없이 text_start → 독립 text 노드 생성", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "user_message", user: "u", text: "hi" } as UserMessageEvent, 0);
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);
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
      processEvent({ type: "text_start", parent_event_id: "0" } as TextStartEvent, 1);

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
      const userMsg = tree.children[0];
      const thinkingNodes = collectNodes(userMsg, "thinking");
      expect(thinkingNodes).toHaveLength(2);
      expect(thinkingNodes[0].content).toBe("First thought");
      expect(thinkingNodes[1].content).toBe("Second thought");

      // text는 독립 TextNode로 생성됨
      const textNodes = collectNodes(userMsg, "text");
      expect(textNodes).toHaveLength(2);
      expect(textNodes[0].content).toBe("Response 1");
      expect(textNodes[1].content).toBe("Response 2");

      // 도구는 user_message의 자식 (thinking과 형제)
      const toolNodes = collectNodes(userMsg, "tool");
      expect(toolNodes).toHaveLength(1);
      expect((toolNodes[0] as ToolNode).toolName).toBe("Read");
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

      // Turn 1: user_message with tool(Skill) and text
      const turn1 = tree.children[0];
      expect(turn1.type).toBe("user_message");
      expect(turn1.content).toBe("Load skill");
      const turn1Tools = collectNodes(turn1, "tool");
      expect(turn1Tools).toHaveLength(1);
      expect((turn1Tools[0] as ToolNode).toolName).toBe("Skill");

      // Turn 2: user_message with text, tool(Task with Grep child)
      const turn2 = tree.children[1];
      expect(turn2.type).toBe("user_message");
      expect(turn2.content).toBe("Analyze");
      // Grep is child of Task tool (no subagent intermediary)
      const taskNode = collectNodes(turn2, "tool").find(t => (t as ToolNode).toolName === "Task");
      expect(taskNode).toBeDefined();
      expect(taskNode!.children.some(c => (c as ToolNode).toolName === "Grep")).toBe(true);
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
      // Inner tool with parent_event_id → resolveParent → nodeMap["tu-task"] → tool itself
      processEvent({ type: "tool_start", timestamp: 0, tool_name: "Grep", tool_input: {}, tool_use_id: "tu-grep", parent_event_id: "tu-task" } as ToolStartEvent, 8);
      processEvent({ type: "tool_result", tool_name: "Grep", result: "ok", is_error: false, tool_use_id: "tu-grep", parent_event_id: "tu-task" } as ToolResultEvent, 9);
      processEvent({ type: "tool_result", tool_name: "Task", result: "done", is_error: false, tool_use_id: "tu-task" } as ToolResultEvent, 10);
      processEvent({ type: "complete", result: "done", attachments: [], parent_event_id: "4" } as CompleteEvent, 11);

      const tree = useDashboardStore.getState().tree!;

      // Should not crash, 2 user_message turns
      const userMsgs = tree.children.filter(c => c.type === "user_message");
      expect(userMsgs).toHaveLength(2);

      // Turn 2 should have the Task tool (parent_event_id → user_message)
      const turn2Tools = collectNodes(userMsgs[1], "tool");
      expect(turn2Tools.some(t => (t as ToolNode).toolName === "Task")).toBe(true);

      // Grep은 Task tool의 자식으로 배치 (resolveParent가 toolNode 반환)
      const taskNode = turn2Tools.find(t => (t as ToolNode).toolName === "Task");
      expect(taskNode?.children.some(c => (c as ToolNode).toolName === "Grep")).toBe(true);

      // 에러 노드 없음 (parent_event_id가 nodeMap에서 매칭 성공)
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
      const turn = tree.children[0]; // user_message

      // Task-1 and Task-2 are both user_message children
      const turnTools = turn.children.filter(c => c.type === "tool");
      expect(turnTools).toHaveLength(2);
      expect((turnTools[0] as ToolNode).toolName).toBe("Task");
      expect((turnTools[1] as ToolNode).toolName).toBe("Task");

      // Grep is child of Task-1 (directly, no subagent)
      const task1 = turnTools[0];
      expect(task1.children.some(c => (c as ToolNode).toolName === "Grep")).toBe(true);

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
      const userMsg = tree.children[0];
      // tool은 user_message에 배치
      expect(userMsg.children.some(c => c.type === "tool")).toBe(true);
      const toolNode = userMsg.children.find(c => c.type === "tool");
      expect((toolNode as ToolNode).toolName).toBe("Read");

      // 에러 노드 없음
      const errorNodes = collectNodes(tree, "error");
      expect(errorNodes).toHaveLength(0);
    });

    it("복수 tool이 parent_event_id로 모두 user_message에 배치", () => {
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
      const userMsg = tree.children[0];

      // tool은 user_message에 배치
      const toolNodes = userMsg.children.filter(c => c.type === "tool");
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

  // === Dedup 가드 테스트 ===

  describe("dedup guard", () => {
    it("processEvent should skip events with eventId <= lastEventId", () => {
      const store = useDashboardStore.getState();

      // 먼저 세션 설정
      store.setSessions([
        { agentSessionId: "sess-dedup", status: "running", eventCount: 0, createdAt: "2026-01-01T00:00:00Z" },
      ]);
      store.setActiveSession("sess-dedup");

      // 이벤트를 처리하여 lastEventId를 5로 설정
      const userMsg: UserMessageEvent = { type: "user_message", user: "test", text: "hello", timestamp: 0 };
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

      store.setSessions([
        { agentSessionId: "sess-dedup2", status: "running", eventCount: 0, createdAt: "2026-01-01T00:00:00Z" },
      ]);
      store.setActiveSession("sess-dedup2");

      // lastEventId를 10으로 설정
      const userMsg: UserMessageEvent = { type: "user_message", user: "test", text: "hello", timestamp: 0 };
      store.processEvent(userMsg, 10);
      expect(useDashboardStore.getState().lastEventId).toBe(10);

      // history_sync (eventId=0) → 건너뛰지 않아야 함
      const historySync = { type: "history_sync", last_event_id: 10, is_live: true } as unknown as import("../../shared/types").SoulSSEEvent;
      store.processEvent(historySync, 0);

      // lastEventId는 그대로 (history_sync는 eventId=0)
      // 중요한 것은 에러 없이 처리되는 것
      expect(useDashboardStore.getState().lastEventId).toBe(10);
    });

    it("processEvents batch should skip duplicate events", () => {
      const store = useDashboardStore.getState();

      store.setSessions([
        { agentSessionId: "sess-batch", status: "running", eventCount: 0, createdAt: "2026-01-01T00:00:00Z" },
      ]);
      store.setActiveSession("sess-batch");

      // lastEventId를 5로 설정
      const userMsg: UserMessageEvent = { type: "user_message", user: "test", text: "hello", timestamp: 0 };
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

      store.setSessions([
        { agentSessionId: "sess-sync", status: "running", eventCount: 0, createdAt: "2026-01-01T00:00:00Z" },
      ]);
      store.setActiveSession("sess-sync");

      // lastEventId를 5로 설정
      store.processEvent(
        { type: "user_message", user: "test", text: "hello", timestamp: 0 } as UserMessageEvent,
        5,
      );

      // history_sync (eventId=0)를 배치로 처리 → 건너뛰지 않아야 함
      store.processEvents([
        { event: { type: "history_sync", last_event_id: 5, is_live: true } as unknown as import("../../shared/types").SoulSSEEvent, eventId: 0 },
      ]);

      // 에러 없이 처리되고, processingCtx.historySynced가 true가 되어야 함
      expect(useDashboardStore.getState().processingCtx.historySynced).toBe(true);
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
});
