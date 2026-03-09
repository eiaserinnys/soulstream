/**
 * D9 수정 검증 테스트: thinking/text 독립 노드 (Phase 7)
 *
 * Phase 7: thinking과 text는 독립적인 형제 노드로 트리에 배치됩니다.
 * text_start는 항상 새 TextNode를 생성합니다.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  useDashboardStore,
  findTreeNode,
} from "../../client/stores/dashboard-store";
import type {
  EventTreeNode,
  SoulSSEEvent,
  ThinkingEvent,
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ToolStartEvent,
  ToolResultEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  CompleteEvent,
} from "../../shared/types";

/** 특정 타입의 모든 노드 수집 */
function collectNodes(
  root: EventTreeNode | null,
  filter?: (n: EventTreeNode) => boolean,
): EventTreeNode[] {
  if (!root) return [];
  const result: EventTreeNode[] = [];
  function walk(node: EventTreeNode) {
    if (!filter || filter(node)) result.push(node);
    for (const child of node.children) walk(child);
  }
  walk(root);
  return result;
}

describe("D9: thinking/text 독립 노드 (Phase 7)", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  // === 핵심 시나리오: thinking과 text가 독립 형제 노드 ===

  it("thinking 후 text_start → text_delta → text_end가 독립 TextNode로 생성", () => {
    const { processEvent, setActiveSession } = useDashboardStore.getState();
    setActiveSession("test:d9-basic");

    processEvent({ type: "user_message", text: "Test", user: "u" } as SoulSSEEvent, 1);
    processEvent({ type: "thinking", thinking: "Let me analyze..." } as ThinkingEvent, 2);
    processEvent({ type: "text_start" } as TextStartEvent, 3);
    processEvent({ type: "text_delta", text: "Here is " } as TextDeltaEvent, 4);
    processEvent({ type: "text_delta", text: "the answer." } as TextDeltaEvent, 5);
    processEvent({ type: "text_end" } as TextEndEvent, 6);

    const tree = useDashboardStore.getState().tree!;
    const thinkingNodes = collectNodes(tree, (n) => n.type === "thinking");
    const textNodes = collectNodes(tree, (n) => n.type === "text");

    expect(thinkingNodes).toHaveLength(1);
    expect(thinkingNodes[0].content).toBe("Let me analyze...");

    // text는 독립 TextNode로 생성
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0].content).toBe("Here is the answer.");
    expect(textNodes[0].completed).toBe(true);
  });

  it("thinking 없이 text만 오면 독립 text 노드 생성", () => {
    const { processEvent, setActiveSession } = useDashboardStore.getState();
    setActiveSession("test:d9-text-only");

    processEvent({ type: "user_message", text: "Test", user: "u" } as SoulSSEEvent, 1);
    processEvent({ type: "text_start" } as TextStartEvent, 2);
    processEvent({ type: "text_delta", text: "Direct response" } as TextDeltaEvent, 3);
    processEvent({ type: "text_end" } as TextEndEvent, 4);

    const tree = useDashboardStore.getState().tree!;
    const textNodes = collectNodes(tree, (n) => n.type === "text");
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0].content).toBe("Direct response");
    expect(textNodes[0].completed).toBe(true);

    const thinkingNodes = collectNodes(tree, (n) => n.type === "thinking");
    expect(thinkingNodes).toHaveLength(0);
  });

  // === 서브에이전트 내부에서도 독립 노드 ===

  it("서브에이전트 내부 thinking과 text가 독립 형제 노드로 생성", () => {
    const { processEvent, setActiveSession } = useDashboardStore.getState();
    setActiveSession("test:d9-subagent");

    processEvent({ type: "user_message", text: "Test", user: "u" } as SoulSSEEvent, 1);

    // tool_start로 tool 노드 생성 (subagent의 부모)
    const toolUseId = "toolu_task_1";
    processEvent({
      type: "tool_start",
      tool_name: "Task",
      tool_input: { prompt: "explore" },
      tool_use_id: toolUseId,
    } as ToolStartEvent, 2);

    // subagent_start
    processEvent({
      type: "subagent_start",
      agent_id: "agent-1",
      agent_type: "Explore",
      parent_event_id: toolUseId,
    } as SubagentStartEvent, 3);

    // 서브에이전트 내부 thinking + text (같은 parent_event_id)
    processEvent({
      type: "thinking",
      thinking: "Subagent thinking...",
      parent_event_id: toolUseId,
    } as ThinkingEvent, 4);
    processEvent({
      type: "text_start",
      parent_event_id: toolUseId,
    } as TextStartEvent, 5);
    processEvent({
      type: "text_delta",
      text: "Subagent response",
    } as TextDeltaEvent, 6);
    processEvent({ type: "text_end" } as TextEndEvent, 7);

    const tree = useDashboardStore.getState().tree!;
    const thinkingNodes = collectNodes(tree, (n) => n.type === "thinking");
    const textNodes = collectNodes(tree, (n) => n.type === "text");

    expect(thinkingNodes).toHaveLength(1);
    expect(thinkingNodes[0].content).toBe("Subagent thinking...");

    expect(textNodes).toHaveLength(1);
    expect(textNodes[0].content).toBe("Subagent response");
    expect(textNodes[0].completed).toBe(true);
  });

  // === 연속 thinking 블록 각각 독립 노드 ===

  it("연속 thinking→text 블록이 각각 독립 노드로 생성", () => {
    const { processEvent, setActiveSession } = useDashboardStore.getState();
    setActiveSession("test:d9-sequential");

    processEvent({ type: "user_message", text: "Test", user: "u" } as SoulSSEEvent, 1);

    // 첫 번째 thinking + text
    processEvent({ type: "thinking", thinking: "First thought" } as ThinkingEvent, 2);
    processEvent({ type: "text_start" } as TextStartEvent, 3);
    processEvent({ type: "text_delta", text: "Response 1" } as TextDeltaEvent, 4);
    processEvent({ type: "text_end" } as TextEndEvent, 5);

    // tool 호출
    processEvent({
      type: "tool_start",
      tool_name: "Read",
      tool_input: { file_path: "/test.ts" },
      tool_use_id: "toolu_1",
    } as ToolStartEvent, 6);
    processEvent({
      type: "tool_result",
      tool_name: "Read",
      result: "file content",
      is_error: false,
      tool_use_id: "toolu_1",
    } as ToolResultEvent, 7);

    // 두 번째 thinking + text
    processEvent({ type: "thinking", thinking: "Second thought" } as ThinkingEvent, 8);
    processEvent({ type: "text_start" } as TextStartEvent, 9);
    processEvent({ type: "text_delta", text: "Response 2" } as TextDeltaEvent, 10);
    processEvent({ type: "text_end" } as TextEndEvent, 11);

    const tree = useDashboardStore.getState().tree!;
    const thinkingNodes = collectNodes(tree, (n) => n.type === "thinking");
    const textNodes = collectNodes(tree, (n) => n.type === "text");

    expect(thinkingNodes).toHaveLength(2);
    expect(thinkingNodes[0].content).toBe("First thought");
    expect(thinkingNodes[1].content).toBe("Second thought");

    expect(textNodes).toHaveLength(2);
    expect(textNodes[0].content).toBe("Response 1");
    expect(textNodes[1].content).toBe("Response 2");
  });

  // === thinking 후 text 없이 다음 thinking이 오는 경우 ===

  it("thinking-only 블록 후 다음 thinking이 와도 올바르게 처리", () => {
    const { processEvent, setActiveSession } = useDashboardStore.getState();
    setActiveSession("test:d9-thinking-only");

    processEvent({ type: "user_message", text: "Test", user: "u" } as SoulSSEEvent, 1);

    // thinking-only (text 없이 바로 tool)
    processEvent({ type: "thinking", thinking: "Planning..." } as ThinkingEvent, 2);
    processEvent({
      type: "tool_start",
      tool_name: "Read",
      tool_input: {},
      tool_use_id: "toolu_1",
    } as ToolStartEvent, 3);
    processEvent({
      type: "tool_result",
      tool_name: "Read",
      result: "ok",
      is_error: false,
      tool_use_id: "toolu_1",
    } as ToolResultEvent, 4);

    // 두 번째 thinking + text
    processEvent({ type: "thinking", thinking: "Analyzing result" } as ThinkingEvent, 5);
    processEvent({ type: "text_start" } as TextStartEvent, 6);
    processEvent({ type: "text_delta", text: "Final answer" } as TextDeltaEvent, 7);
    processEvent({ type: "text_end" } as TextEndEvent, 8);

    const tree = useDashboardStore.getState().tree!;
    const thinkingNodes = collectNodes(tree, (n) => n.type === "thinking");
    const textNodes = collectNodes(tree, (n) => n.type === "text");

    expect(thinkingNodes).toHaveLength(2);
    // 첫 번째 thinking: text 없음 (독립)
    expect(thinkingNodes[0].content).toBe("Planning...");
    // 두 번째 thinking: 역시 독립
    expect(thinkingNodes[1].content).toBe("Analyzing result");

    // text는 독립 TextNode
    expect(textNodes).toHaveLength(1);
    expect(textNodes[0].content).toBe("Final answer");
    expect(textNodes[0].completed).toBe(true);
  });

  // === 완료 후 미완료 노드 없음 확인 ===

  it("정상 완료 후 미완료 노드 없음", () => {
    const { processEvent, setActiveSession } = useDashboardStore.getState();
    setActiveSession("test:d9-incomplete");

    processEvent({ type: "user_message", text: "Test", user: "u" } as SoulSSEEvent, 1);

    // 첫 번째 thinking + text (정상 완료)
    processEvent({ type: "thinking", thinking: "Thought 1" } as ThinkingEvent, 2);
    processEvent({ type: "text_start" } as TextStartEvent, 3);
    processEvent({ type: "text_delta", text: "Response 1" } as TextDeltaEvent, 4);
    processEvent({ type: "text_end" } as TextEndEvent, 5);

    // 두 번째 thinking + text (정상 완료)
    processEvent({ type: "thinking", thinking: "Thought 2" } as ThinkingEvent, 6);
    processEvent({ type: "text_start" } as TextStartEvent, 7);
    processEvent({ type: "text_delta", text: "Response 2" } as TextDeltaEvent, 8);
    processEvent({ type: "text_end" } as TextEndEvent, 9);

    processEvent({ type: "complete", result: "done", attachments: [] } as CompleteEvent, 10);

    const tree = useDashboardStore.getState().tree!;
    const textNodes = collectNodes(tree, (n) => n.type === "text");

    expect(textNodes).toHaveLength(2);
    expect(textNodes[0].content).toBe("Response 1");
    expect(textNodes[1].content).toBe("Response 2");

    // 미완료 노드 없음
    const incompleteNodes = collectNodes(tree, (n) => !n.completed && n.type !== "session");
    expect(incompleteNodes).toHaveLength(0);
  });

  // === card_id가 이벤트 타입에서 제거되었음을 검증 ===

  it("이벤트 타입에 card_id 필드가 존재하지 않음", () => {
    // TypeScript 컴파일 타임 검증과 함께 런타임에서도 확인
    const thinkingEvent: ThinkingEvent = {
      type: "thinking",
      timestamp: 1000,
      thinking: "test",
    };
    expect("card_id" in thinkingEvent).toBe(false);

    const textStartEvent: TextStartEvent = {
      type: "text_start",
      timestamp: 1000,
    };
    expect("card_id" in textStartEvent).toBe(false);

    const textDeltaEvent: TextDeltaEvent = {
      type: "text_delta",
      timestamp: 1000,
      text: "test",
    };
    expect("card_id" in textDeltaEvent).toBe(false);

    const textEndEvent: TextEndEvent = {
      type: "text_end",
      timestamp: 1000,
    };
    expect("card_id" in textEndEvent).toBe(false);

    const toolStartEvent: ToolStartEvent = {
      type: "tool_start",
      timestamp: 1000,
      tool_name: "Read",
      tool_input: {},
    };
    expect("card_id" in toolStartEvent).toBe(false);

    const toolResultEvent: ToolResultEvent = {
      type: "tool_result",
      timestamp: 1000,
      tool_name: "Read",
      result: "ok",
      is_error: false,
    };
    expect("card_id" in toolResultEvent).toBe(false);
  });

  // === 복수 독립 text 블록 ===

  it("thinking 없이 연속 text 블록이 각각 독립 text 노드로 생성", () => {
    const { processEvent, setActiveSession } = useDashboardStore.getState();
    setActiveSession("test:d9-multi-text");

    processEvent({ type: "user_message", text: "Test", user: "u" } as SoulSSEEvent, 1);

    // 첫 번째 text 블록
    processEvent({ type: "text_start" } as TextStartEvent, 2);
    processEvent({ type: "text_delta", text: "First block" } as TextDeltaEvent, 3);
    processEvent({ type: "text_end" } as TextEndEvent, 4);

    // 두 번째 text 블록
    processEvent({ type: "text_start" } as TextStartEvent, 5);
    processEvent({ type: "text_delta", text: "Second block" } as TextDeltaEvent, 6);
    processEvent({ type: "text_end" } as TextEndEvent, 7);

    const tree = useDashboardStore.getState().tree!;
    const textNodes = collectNodes(tree, (n) => n.type === "text");

    expect(textNodes).toHaveLength(2);
    expect(textNodes[0].content).toBe("First block");
    expect(textNodes[0].completed).toBe(true);
    expect(textNodes[1].content).toBe("Second block");
    expect(textNodes[1].completed).toBe(true);
  });

  // === 병렬 서브에이전트에서 각각 독립 thinking/text ===

  it("병렬 서브에이전트의 thinking과 text가 parent_event_id로 올바르게 배치", () => {
    const { processEvent, setActiveSession } = useDashboardStore.getState();
    setActiveSession("test:d9-concurrent-subagents");

    processEvent({ type: "user_message", text: "Test", user: "u" } as SoulSSEEvent, 1);

    // 서브에이전트 A 시작
    processEvent({
      type: "tool_start",
      tool_name: "Task",
      tool_input: { prompt: "explore A" },
      tool_use_id: "toolu_A",
    } as ToolStartEvent, 2);
    processEvent({
      type: "subagent_start",
      agent_id: "agent-A",
      agent_type: "Explore",
      parent_event_id: "toolu_A",
    } as SubagentStartEvent, 3);

    // 서브에이전트 B 시작
    processEvent({
      type: "tool_start",
      tool_name: "Task",
      tool_input: { prompt: "explore B" },
      tool_use_id: "toolu_B",
    } as ToolStartEvent, 4);
    processEvent({
      type: "subagent_start",
      agent_id: "agent-B",
      agent_type: "Plan",
      parent_event_id: "toolu_B",
    } as SubagentStartEvent, 5);

    // A의 thinking
    processEvent({
      type: "thinking",
      thinking: "A is thinking...",
      parent_event_id: "toolu_A",
    } as ThinkingEvent, 6);

    // B의 thinking
    processEvent({
      type: "thinking",
      thinking: "B is thinking...",
      parent_event_id: "toolu_B",
    } as ThinkingEvent, 7);

    // A의 text
    processEvent({
      type: "text_start",
      parent_event_id: "toolu_A",
    } as TextStartEvent, 8);
    processEvent({ type: "text_delta", text: "A response" } as TextDeltaEvent, 9);
    processEvent({ type: "text_end" } as TextEndEvent, 10);

    // B의 text
    processEvent({
      type: "text_start",
      parent_event_id: "toolu_B",
    } as TextStartEvent, 11);
    processEvent({ type: "text_delta", text: "B response" } as TextDeltaEvent, 12);
    processEvent({ type: "text_end" } as TextEndEvent, 13);

    const tree = useDashboardStore.getState().tree!;
    const thinkingNodes = collectNodes(tree, (n) => n.type === "thinking");
    const textNodes = collectNodes(tree, (n) => n.type === "text");

    expect(thinkingNodes).toHaveLength(2);
    expect(thinkingNodes[0].content).toBe("A is thinking...");
    expect(thinkingNodes[1].content).toBe("B is thinking...");

    // text는 독립 TextNode로 각각 생성
    expect(textNodes).toHaveLength(2);
    expect(textNodes[0].content).toBe("A response");
    expect(textNodes[0].completed).toBe(true);
    expect(textNodes[1].content).toBe("B response");
    expect(textNodes[1].completed).toBe(true);
  });
});
