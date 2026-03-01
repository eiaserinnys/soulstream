/**
 * dashboard-store 테스트
 *
 * Zustand 스토어의 이벤트 처리 로직을 검증합니다.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useDashboardStore } from "./dashboard-store";
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
} from "../../shared/types";

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
    it("should set active session and clear cards", () => {
      // 먼저 카드를 추가
      const textStart: TextStartEvent = { type: "text_start", card_id: "abc" };
      useDashboardStore.getState().processEvent(textStart, 1);
      expect(useDashboardStore.getState().cards.length).toBe(1);

      // 활성 세션 변경 시 카드 초기화
      useDashboardStore.getState().setActiveSession("c1:r1");
      expect(useDashboardStore.getState().activeSessionKey).toBe("c1:r1");
      expect(useDashboardStore.getState().cards).toEqual([]);
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
    it("should create text card on text_start", () => {
      const event: TextStartEvent = { type: "text_start", card_id: "abc123" };
      useDashboardStore.getState().processEvent(event, 1);

      const cards = useDashboardStore.getState().cards;
      expect(cards).toHaveLength(1);
      expect(cards[0]).toEqual({
        cardId: "abc123",
        type: "text",
        content: "",
        completed: false,
      });
      expect(useDashboardStore.getState().lastEventId).toBe(1);
    });

    it("should accumulate text on text_delta", () => {
      const start: TextStartEvent = { type: "text_start", card_id: "abc" };
      const delta1: TextDeltaEvent = { type: "text_delta", card_id: "abc", text: "Hello " };
      const delta2: TextDeltaEvent = { type: "text_delta", card_id: "abc", text: "World" };

      const { processEvent } = useDashboardStore.getState();
      processEvent(start, 1);
      processEvent(delta1, 2);
      processEvent(delta2, 3);

      const cards = useDashboardStore.getState().cards;
      expect(cards[0].content).toBe("Hello World");
      expect(cards[0].completed).toBe(false);
    });

    it("should mark completed on text_end", () => {
      const start: TextStartEvent = { type: "text_start", card_id: "abc" };
      const delta: TextDeltaEvent = { type: "text_delta", card_id: "abc", text: "Done" };
      const end: TextEndEvent = { type: "text_end", card_id: "abc" };

      const { processEvent } = useDashboardStore.getState();
      processEvent(start, 1);
      processEvent(delta, 2);
      processEvent(end, 3);

      const cards = useDashboardStore.getState().cards;
      expect(cards[0].content).toBe("Done");
      expect(cards[0].completed).toBe(true);
      expect(useDashboardStore.getState().lastEventId).toBe(3);
    });
  });

  // === SSE 이벤트 처리: 도구 카드 ===

  describe("processEvent - tool card lifecycle", () => {
    it("should create tool card on tool_start", () => {
      const event: ToolStartEvent = {
        type: "tool_start",
        card_id: "thinking-1",
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
        tool_use_id: "toolu_abc",
      };
      useDashboardStore.getState().processEvent(event, 10);

      const cards = useDashboardStore.getState().cards;
      expect(cards).toHaveLength(1);
      expect(cards[0]).toEqual({
        cardId: "tool-10",
        type: "tool",
        content: "",
        toolName: "Read",
        toolInput: { file_path: "/test.ts" },
        completed: false,
        toolUseId: "toolu_abc",
        parentCardId: "thinking-1",
      });
    });

    it("should complete tool card on tool_result", () => {
      const start: ToolStartEvent = {
        type: "tool_start",
        card_id: "tool-1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      };
      const result: ToolResultEvent = {
        type: "tool_result",
        card_id: "tool-1",
        tool_name: "Bash",
        result: "file1.txt\nfile2.txt",
        is_error: false,
      };

      const { processEvent } = useDashboardStore.getState();
      processEvent(start, 1);
      processEvent(result, 2);

      const cards = useDashboardStore.getState().cards;
      expect(cards[0].toolResult).toBe("file1.txt\nfile2.txt");
      expect(cards[0].isError).toBe(false);
      expect(cards[0].completed).toBe(true);
    });

    it("should handle tool error", () => {
      const start: ToolStartEvent = {
        type: "tool_start",
        card_id: "tool-2",
        tool_name: "Bash",
        tool_input: { command: "invalid" },
      };
      const result: ToolResultEvent = {
        type: "tool_result",
        card_id: "tool-2",
        tool_name: "Bash",
        result: "command not found",
        is_error: true,
      };

      const { processEvent } = useDashboardStore.getState();
      processEvent(start, 1);
      processEvent(result, 2);

      const cards = useDashboardStore.getState().cards;
      expect(cards[0].isError).toBe(true);
      expect(cards[0].completed).toBe(true);
    });

    it("should use fallback cardId when card_id is undefined", () => {
      const start: ToolStartEvent = {
        type: "tool_start",
        tool_name: "Read",
        tool_input: {},
      };
      useDashboardStore.getState().processEvent(start, 42);

      const cards = useDashboardStore.getState().cards;
      expect(cards[0].cardId).toBe("tool-42");
    });

    it("should match tool_result by tool_name when both card_ids are undefined", () => {
      const start: ToolStartEvent = {
        type: "tool_start",
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
      };
      const result: ToolResultEvent = {
        type: "tool_result",
        tool_name: "Bash",
        result: "hello",
        is_error: false,
      };

      const { processEvent } = useDashboardStore.getState();
      processEvent(start, 10);
      processEvent(result, 11);

      const cards = useDashboardStore.getState().cards;
      expect(cards).toHaveLength(1);
      expect(cards[0].toolResult).toBe("hello");
      expect(cards[0].completed).toBe(true);
    });

    it("should fallback to tool_name when tool_start has no card_id but tool_result has card_id", () => {
      // 시나리오: tool_start에 card_id 없음 → 카드는 "tool-10" ID로 생성
      // tool_result에 card_id "abc123" 있음 → card_id로 찾으면 매칭 실패
      // 폴백: tool_name으로 마지막 미완료 카드를 매칭해야 함
      const { processEvent } = useDashboardStore.getState();

      processEvent({
        type: "tool_start",
        // card_id 없음
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
      } as ToolStartEvent, 10);

      processEvent({
        type: "tool_result",
        card_id: "abc123", // card_id가 있지만 "tool-10"과 불일치
        tool_name: "Bash",
        result: "hello",
        is_error: false,
      } as ToolResultEvent, 11);

      const cards = useDashboardStore.getState().cards;
      expect(cards).toHaveLength(1);
      expect(cards[0].cardId).toBe("tool-10"); // 원래 생성된 ID 유지
      expect(cards[0].toolResult).toBe("hello");
      expect(cards[0].completed).toBe(true);
    });

    it("should fallback to tool_name when card_id mismatch between tool_start and tool_result", () => {
      // 시나리오: tool_start card_id="A", tool_result card_id="B" → 불일치
      const { processEvent } = useDashboardStore.getState();

      processEvent({
        type: "tool_start",
        card_id: "cardA",
        tool_name: "Read",
        tool_input: { file_path: "/test.ts" },
      } as ToolStartEvent, 1);

      processEvent({
        type: "tool_result",
        card_id: "cardB", // 불일치
        tool_name: "Read",
        result: "file content",
        is_error: false,
      } as ToolResultEvent, 2);

      const cards = useDashboardStore.getState().cards;
      expect(cards).toHaveLength(1);
      expect(cards[0].toolResult).toBe("file content");
      expect(cards[0].completed).toBe(true);
    });

    it("should match tool_result to the last uncompleted tool with matching name", () => {
      const { processEvent } = useDashboardStore.getState();

      // Tool 1 (completed)
      processEvent({
        type: "tool_start",
        card_id: "t1",
        tool_name: "Bash",
        tool_input: {},
      } as ToolStartEvent, 1);
      processEvent({
        type: "tool_result",
        card_id: "t1",
        tool_name: "Bash",
        result: "done",
        is_error: false,
      } as ToolResultEvent, 2);

      // Tool 2 (uncompleted, no card_id)
      processEvent({
        type: "tool_start",
        tool_name: "Bash",
        tool_input: {},
      } as ToolStartEvent, 3);

      // Result without card_id should match Tool 2
      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "second",
        is_error: false,
      } as ToolResultEvent, 4);

      const cards = useDashboardStore.getState().cards;
      expect(cards).toHaveLength(2);
      expect(cards[0].completed).toBe(true);
      expect(cards[0].toolResult).toBe("done");
      expect(cards[1].completed).toBe(true);
      expect(cards[1].toolResult).toBe("second");
    });
  });

  // === 무시되는 이벤트 ===

  describe("processEvent - ignored events", () => {
    it("should update lastEventId for unhandled event types", () => {
      const event: CompleteEvent = {
        type: "complete",
        result: "done",
        attachments: [],
      };
      useDashboardStore.getState().processEvent(event, 99);

      expect(useDashboardStore.getState().cards).toEqual([]);
      expect(useDashboardStore.getState().lastEventId).toBe(99);
    });
  });

  // === 복합 시나리오 ===

  describe("mixed card sequence", () => {
    it("should handle interleaved text and tool cards", () => {
      const { processEvent } = useDashboardStore.getState();

      // Text card 1
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({ type: "text_delta", card_id: "t1", text: "Analyzing..." } as TextDeltaEvent, 2);
      processEvent({ type: "text_end", card_id: "t1" }, 3);

      // Tool card (card_id는 부모 thinking의 ID, tool_use_id로 매칭)
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

      const cards = useDashboardStore.getState().cards;
      expect(cards).toHaveLength(3);
      expect(cards[0].cardId).toBe("t1");
      expect(cards[0].completed).toBe(true);
      expect(cards[1].cardId).toBe("tool-4"); // eventId=4 → tool-4
      expect(cards[1].completed).toBe(true);
      expect(cards[1].toolUseId).toBe("toolu_bash1");
      expect(cards[1].parentCardId).toBe("t1");
      expect(cards[2].cardId).toBe("t2");
      expect(cards[2].completed).toBe(false); // text_end 미수신
    });
  });

  // === 이벤트 노드 선택 ===

  describe("selectEventNode", () => {
    it("should set selectedEventNodeData and clear card/node selection", () => {
      // 먼저 카드와 노드를 선택해 둠
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

    it("should handle tool_group node data with groupedCardIds", () => {
      const toolGroupData = {
        nodeType: "tool_group",
        label: "Bash x3",
        content: "3 tool calls",
        groupedCardIds: ["tool-1", "tool-2", "tool-3"],
        toolName: "Bash",
        groupCount: 3,
      };
      useDashboardStore.getState().selectEventNode(toolGroupData);

      const state = useDashboardStore.getState();
      expect(state.selectedEventNodeData).toEqual(toolGroupData);
      expect(state.selectedEventNodeData?.groupedCardIds).toHaveLength(3);
      expect(state.selectedEventNodeData?.toolName).toBe("Bash");
      expect(state.selectedEventNodeData?.groupCount).toBe(3);
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

  // === 그룹 접기/펼치기 ===

  describe("toggleGroupCollapse", () => {
    it("should add groupId to collapsedGroups when not present", () => {
      useDashboardStore.getState().toggleGroupCollapse("group-1");
      expect(useDashboardStore.getState().collapsedGroups.has("group-1")).toBe(true);
    });

    it("should remove groupId from collapsedGroups when already present", () => {
      useDashboardStore.getState().toggleGroupCollapse("group-1");
      expect(useDashboardStore.getState().collapsedGroups.has("group-1")).toBe(true);

      useDashboardStore.getState().toggleGroupCollapse("group-1");
      expect(useDashboardStore.getState().collapsedGroups.has("group-1")).toBe(false);
    });

    it("should handle multiple groups independently", () => {
      const { toggleGroupCollapse } = useDashboardStore.getState();
      toggleGroupCollapse("group-a");
      toggleGroupCollapse("group-b");

      const collapsed = useDashboardStore.getState().collapsedGroups;
      expect(collapsed.has("group-a")).toBe(true);
      expect(collapsed.has("group-b")).toBe(true);

      useDashboardStore.getState().toggleGroupCollapse("group-a");
      const updated = useDashboardStore.getState().collapsedGroups;
      expect(updated.has("group-a")).toBe(false);
      expect(updated.has("group-b")).toBe(true);
    });
  });

  // === 세션 생성/재개 ===

  describe("startCompose / cancelCompose", () => {
    it("should reset session state and set isComposing to true", () => {
      // 먼저 세션 상태를 설정
      useDashboardStore.getState().setActiveSession("c1:r1");
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "t1" }, 1);
      useDashboardStore.getState().selectCard("t1");

      useDashboardStore.getState().startCompose();
      const state = useDashboardStore.getState();

      expect(state.isComposing).toBe(true);
      expect(state.resumeTargetKey).toBeNull();
      expect(state.activeSessionKey).toBeNull();
      expect(state.activeSession).toBeNull();
      expect(state.cards).toEqual([]);
      expect(state.graphEvents).toEqual([]);
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
    it("should reset session state, set isComposing, and set resumeTargetKey", () => {
      // 먼저 기존 상태를 설정
      useDashboardStore.getState().setActiveSession("old:session");
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "x" }, 5);

      useDashboardStore.getState().startResume("target:session");
      const state = useDashboardStore.getState();

      expect(state.isComposing).toBe(true);
      expect(state.resumeTargetKey).toBe("target:session");
      expect(state.activeSessionKey).toBeNull();
      expect(state.activeSession).toBeNull();
      expect(state.cards).toEqual([]);
      expect(state.graphEvents).toEqual([]);
      expect(state.lastEventId).toBe(0);
    });

    it("should differ from startCompose only in resumeTargetKey", () => {
      useDashboardStore.getState().startCompose();
      const composeState = { ...useDashboardStore.getState() };

      useDashboardStore.getState().reset();
      useDashboardStore.getState().startResume("key");
      const resumeState = useDashboardStore.getState();

      expect(composeState.isComposing).toBe(resumeState.isComposing);
      expect(composeState.resumeTargetKey).toBeNull();
      expect(resumeState.resumeTargetKey).toBe("key");
    });
  });

  // === graphEvents 필터링 ===

  describe("processEvent - graphEvents filtering", () => {
    it("should add session event to graphEvents", () => {
      const event: SessionEvent = { type: "session", session_id: "s1" };
      useDashboardStore.getState().processEvent(event, 1);
      expect(useDashboardStore.getState().graphEvents).toHaveLength(1);
      expect(useDashboardStore.getState().graphEvents[0]).toEqual(event);
    });

    it("should add complete event to graphEvents", () => {
      const event: CompleteEvent = { type: "complete", result: "done", attachments: [] };
      useDashboardStore.getState().processEvent(event, 1);
      expect(useDashboardStore.getState().graphEvents).toHaveLength(1);
      expect(useDashboardStore.getState().graphEvents[0]).toEqual(event);
    });

    it("should add error event to graphEvents", () => {
      const event: ErrorEvent = { type: "error", message: "something failed" };
      useDashboardStore.getState().processEvent(event, 1);
      expect(useDashboardStore.getState().graphEvents).toHaveLength(1);
      expect(useDashboardStore.getState().graphEvents[0]).toEqual(event);
    });

    it("should add intervention_sent event to graphEvents", () => {
      const event: InterventionSentEvent = {
        type: "intervention_sent",
        user: "admin",
        text: "please stop",
      };
      useDashboardStore.getState().processEvent(event, 1);
      expect(useDashboardStore.getState().graphEvents).toHaveLength(1);
      expect(useDashboardStore.getState().graphEvents[0]).toEqual(event);
    });

    it("should add user_message event to graphEvents", () => {
      const event: UserMessageEvent = {
        type: "user_message",
        user: "user1",
        text: "hello",
      };
      useDashboardStore.getState().processEvent(event, 1);
      expect(useDashboardStore.getState().graphEvents).toHaveLength(1);
      expect(useDashboardStore.getState().graphEvents[0]).toEqual(event);
    });

    it("should NOT add text_start to graphEvents", () => {
      const event: TextStartEvent = { type: "text_start", card_id: "t1" };
      useDashboardStore.getState().processEvent(event, 1);
      expect(useDashboardStore.getState().graphEvents).toHaveLength(0);
    });

    it("should NOT add text_delta to graphEvents", () => {
      // text_start 먼저 추가 (text_delta 처리를 위해)
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "t1" }, 1);
      const event: TextDeltaEvent = { type: "text_delta", card_id: "t1", text: "hi" };
      useDashboardStore.getState().processEvent(event, 2);
      expect(useDashboardStore.getState().graphEvents).toHaveLength(0);
    });

    it("should NOT add tool_start to graphEvents", () => {
      const event: ToolStartEvent = {
        type: "tool_start",
        card_id: "c1",
        tool_name: "Bash",
        tool_input: {},
      };
      useDashboardStore.getState().processEvent(event, 1);
      expect(useDashboardStore.getState().graphEvents).toHaveLength(0);
    });

    it("should NOT add progress to graphEvents", () => {
      const event: ProgressEvent = { type: "progress", text: "working..." };
      useDashboardStore.getState().processEvent(event, 1);
      expect(useDashboardStore.getState().graphEvents).toHaveLength(0);
    });

    it("should NOT add memory to graphEvents", () => {
      const event: MemoryEvent = { type: "memory", used_gb: 1.5, total_gb: 8, percent: 18.75 };
      useDashboardStore.getState().processEvent(event, 1);
      expect(useDashboardStore.getState().graphEvents).toHaveLength(0);
    });

    it("should accumulate only graph-relevant events in mixed sequence", () => {
      const { processEvent } = useDashboardStore.getState();
      processEvent({ type: "session", session_id: "s1" } as SessionEvent, 1);
      processEvent({ type: "text_start", card_id: "t1" }, 2);
      processEvent({ type: "text_delta", card_id: "t1", text: "hi" } as TextDeltaEvent, 3);
      processEvent({ type: "intervention_sent", user: "u", text: "stop" } as InterventionSentEvent, 4);
      processEvent({ type: "text_end", card_id: "t1" }, 5);
      processEvent({ type: "complete", result: "ok", attachments: [] } as CompleteEvent, 6);

      const graphEvents = useDashboardStore.getState().graphEvents;
      expect(graphEvents).toHaveLength(3);
      expect(graphEvents[0].type).toBe("session");
      expect(graphEvents[1].type).toBe("intervention_sent");
      expect(graphEvents[2].type).toBe("complete");
    });
  });

  // === clearCards ===

  describe("clearCards", () => {
    it("should clear cards and related state", () => {
      const { processEvent, selectCard, toggleGroupCollapse } =
        useDashboardStore.getState();

      // 상태를 채움
      processEvent({ type: "text_start", card_id: "t1" }, 1);
      processEvent({ type: "text_delta", card_id: "t1", text: "content" } as TextDeltaEvent, 2);
      processEvent({ type: "session", session_id: "s1" } as SessionEvent, 3);
      selectCard("t1", "node-t1");
      useDashboardStore.getState().selectEventNode({
        nodeType: "user",
        label: "msg",
        content: "hello",
      });
      toggleGroupCollapse("group-1");

      // 상태가 채워졌는지 확인
      expect(useDashboardStore.getState().cards.length).toBeGreaterThan(0);
      expect(useDashboardStore.getState().graphEvents.length).toBeGreaterThan(0);
      expect(useDashboardStore.getState().lastEventId).toBeGreaterThan(0);

      useDashboardStore.getState().clearCards();
      const state = useDashboardStore.getState();

      expect(state.cards).toEqual([]);
      expect(state.graphEvents).toEqual([]);
      expect(state.collapsedGroups.size).toBe(0);
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
      useDashboardStore.getState().processEvent({ type: "text_start", card_id: "t1" }, 1);

      useDashboardStore.getState().clearCards();

      // sessions과 activeSessionKey는 유지되어야 함
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
      processEvent({ type: "text_start", card_id: "x" }, 1);
      selectCard("x");

      useDashboardStore.getState().reset();
      const state = useDashboardStore.getState();

      expect(state.sessions).toEqual([]);
      expect(state.activeSessionKey).toBeNull();
      expect(state.cards).toEqual([]);
      expect(state.selectedCardId).toBeNull();
      expect(state.lastEventId).toBe(0);
    });
  });
});
