/**
 * 클라이언트 스토어 통합 테스트: 장시간 세션 + 컴팩트 렌더링
 *
 * 체크리스트 항목:
 * - [6] 장시간 세션 (컴팩트 발생) 정상 렌더링
 * - [7] 에러 케이스 정상 표시
 *
 * dashboard-store와 layout-engine의 복합 시나리오를 검증합니다.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  useDashboardStore,
  findTreeNode,
  type SoulSSEEvent,
  type EventTreeNode,
  type TextStartEvent,
  type TextDeltaEvent,
  type TextEndEvent,
  type ToolStartEvent,
  type ToolResultEvent,
  type CompactEvent,
  type ContextUsageEvent,
  type ErrorEvent,
  type CompleteEvent,
} from "@seosoyoung/soul-ui";
import { buildGraph } from "../../client/lib/layout-engine";

/** 트리에서 모든 노드를 수집합니다. */
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

describe("Store + Layout: Long Session Rendering", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  // === [6] 장시간 세션 ===

  describe("[체크리스트 6] 장시간 세션 정상 렌더링", () => {
    it("100개 노드 처리 후 스토어 상태 일관성", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();
      setActiveSession("test:long");
      let eventId = 1;

      // user_message 추가 (트리의 턴 노드)
      processEvent({ type: "user_message", text: "Long session", user: "test" } as SoulSSEEvent, eventId++);

      // 50개의 text + 50개의 tool 노드 생성
      for (let i = 0; i < 50; i++) {
        processEvent({ type: "text_start" } as TextStartEvent, eventId++);
        processEvent({ type: "text_delta", text: `Content ${i}` } as TextDeltaEvent, eventId++);
        processEvent({ type: "text_end" } as TextEndEvent, eventId++);

        const toolUseId = `toolu_long_${i}`;
        processEvent({
          type: "tool_start",
          tool_name: "Bash",
          tool_input: { command: `echo ${i}` },
          tool_use_id: toolUseId,
        } as ToolStartEvent, eventId++);
        processEvent({
          type: "tool_result",
          tool_name: "Bash",
          result: `output ${i}`,
          is_error: false,
          tool_use_id: toolUseId,
        } as ToolResultEvent, eventId++);
      }

      const state = useDashboardStore.getState();

      // 100개 노드(50 text + 50 tool)가 정확히 생성되었는지
      const textNodes = collectNodes(state.tree, (n) => n.type === "text");
      const toolNodes = collectNodes(state.tree, (n) => n.type === "tool");
      expect(textNodes).toHaveLength(50);
      expect(toolNodes).toHaveLength(50);

      // 모든 노드가 완료 상태
      expect(textNodes.every((n) => n.completed)).toBe(true);
      expect(toolNodes.every((n) => n.completed)).toBe(true);

      // lastEventId가 정확한지
      expect(state.lastEventId).toBe(eventId - 1);
    });

    it("100개 노드에서 그래프 노드/엣지 생성 성능", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();
      setActiveSession("test:perf");
      let eventId = 1;

      // user_message 추가
      processEvent({ type: "user_message", text: "Perf test", user: "test" } as SoulSSEEvent, eventId++);

      for (let i = 0; i < 50; i++) {
        processEvent({ type: "text_start" } as TextStartEvent, eventId++);
        processEvent({ type: "text_delta", text: `Content ${i}` } as TextDeltaEvent, eventId++);
        processEvent({ type: "text_end" } as TextEndEvent, eventId++);

        const toolUseId = `toolu_perf_${i}`;
        processEvent({
          type: "tool_start",
          tool_name: "Read",
          tool_input: { file_path: `/path/file${i}.ts` },
          tool_use_id: toolUseId,
        } as ToolStartEvent, eventId++);
        processEvent({
          type: "tool_result",
          tool_name: "Read",
          result: `content of file${i}`,
          is_error: false,
          tool_use_id: toolUseId,
        } as ToolResultEvent, eventId++);
      }

      const tree = useDashboardStore.getState().tree;

      // 그래프 빌드 시간 측정
      const start = performance.now();
      const { nodes, edges } = buildGraph(tree);
      const elapsed = performance.now() - start;

      // 노드가 생성되었는지
      expect(nodes.length).toBeGreaterThan(0);
      expect(edges.length).toBeGreaterThan(0);

      // 100개 노드 기준 500ms 이내에 그래프 빌드 완료
      expect(elapsed).toBeLessThan(500);
    });

    it("컴팩트 이벤트 전후로 노드가 정상 누적", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();
      setActiveSession("test:compact");
      let eventId = 1;

      // user_message 추가 (eventId=1)
      processEvent({ type: "user_message", text: "Compact test", user: "test" } as SoulSSEEvent, eventId++);

      // 컴팩트 전 텍스트 (text_start eventId=2 → node "text-2")
      processEvent({ type: "text_start" } as TextStartEvent, eventId++);
      processEvent({ type: "text_delta", text: "Before compact" } as TextDeltaEvent, eventId++);
      processEvent({ type: "text_end" } as TextEndEvent, eventId++);

      // 컨텍스트 사용량 이벤트 (eventId=5)
      processEvent({
        type: "context_usage",
        used_tokens: 180000,
        max_tokens: 200000,
        percent: 90,
      } as ContextUsageEvent, eventId++);

      // 컴팩트 이벤트 (eventId=6)
      processEvent({
        type: "compact",
        trigger: "auto",
        message: "Compacted: 180K → 50K tokens",
      } as CompactEvent, eventId++);

      // 컴팩트 후 텍스트 (text_start eventId=7 → node "text-7")
      processEvent({ type: "text_start" } as TextStartEvent, eventId++);
      processEvent({ type: "text_delta", text: "After compact" } as TextDeltaEvent, eventId++);
      processEvent({ type: "text_end" } as TextEndEvent, eventId++);

      const state = useDashboardStore.getState();

      // 컴팩트 전후 텍스트 노드가 모두 존재
      const textNodes = collectNodes(state.tree, (n) => n.type === "text");
      expect(textNodes).toHaveLength(2);

      const before = findTreeNode(state.tree, "text-2");
      expect(before).not.toBeNull();
      expect(before!.content).toBe("Before compact");

      const after = findTreeNode(state.tree, "text-7");
      expect(after).not.toBeNull();
      expect(after!.content).toBe("After compact");
    });

    it("컴팩트 이벤트가 포함된 세션에서 그래프가 정상 빌드됨", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();
      setActiveSession("test:compact-graph");
      let eventId = 1;

      // 트리 구축 (eventId 1 = user_message)
      processEvent({ type: "user_message", text: "Test", user: "test" } as SoulSSEEvent, eventId++);
      processEvent({ type: "text_start", parent_event_id: "1" } as TextStartEvent, eventId++);
      processEvent({ type: "text_delta", text: "Before" } as TextDeltaEvent, eventId++);
      processEvent({ type: "text_end" } as TextEndEvent, eventId++);
      processEvent({ type: "compact", trigger: "auto", message: "Compacted" } as CompactEvent, eventId++);
      processEvent({ type: "text_start", parent_event_id: "1" } as TextStartEvent, eventId++);
      processEvent({ type: "text_delta", text: "After" } as TextDeltaEvent, eventId++);
      processEvent({ type: "text_end" } as TextEndEvent, eventId++);
      processEvent({ type: "complete", result: "Done", attachments: [], parent_event_id: "1" } as CompleteEvent, eventId++);

      const tree = useDashboardStore.getState().tree;
      const { nodes, edges } = buildGraph(tree);

      // 텍스트 노드 2개 + complete 시스템 노드가 존재
      expect(nodes.length).toBeGreaterThanOrEqual(2);

      // complete 이벤트는 시스템 노드로 표시됨
      const systemNodes = nodes.filter((n) => n.type === "system");
      const completeNode = systemNodes.find((n) => n.data.label.includes("Complete"));
      expect(completeNode).toBeDefined();

      // compact 이벤트도 시스템 노드로 렌더링됨
      const compactNode = systemNodes.find((n) => n.data.label.includes("Compaction"));
      expect(compactNode).toBeDefined();

      // 엣지가 존재 (노드 간 연결)
      expect(edges.length).toBeGreaterThan(0);
    });
  });

  // === [7] 에러 케이스 렌더링 ===

  describe("[체크리스트 7] 에러 케이스 클라이언트 렌더링", () => {
    it("에러 이벤트 처리 후 스토어 상태", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();
      setActiveSession("test:error");

      // eventId=0→user_message, 1→text_start→"text-1", 2→text_delta, 3→error
      processEvent({ type: "user_message", text: "Error test", user: "test" } as SoulSSEEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Working..." } as TextDeltaEvent, 2);
      processEvent({
        type: "error",
        message: "Rate limit exceeded",
        error_code: "RATE_LIMIT",
      } as ErrorEvent, 3);

      const state = useDashboardStore.getState();

      // 에러 전의 텍스트 노드는 유지 (node ID: "text-1")
      const textNode = findTreeNode(state.tree, "text-1");
      expect(textNode).not.toBeNull();
      expect(textNode!.content).toBe("Working...");
      // text_end를 받지 못했으므로 미완료
      expect(textNode!.completed).toBe(false);
      // lastEventId는 에러 이벤트까지 반영
      expect(state.lastEventId).toBe(3);

      // 에러 노드가 트리에 존재
      const errorNodes = collectNodes(state.tree, (n) => n.type === "error");
      expect(errorNodes.length).toBeGreaterThanOrEqual(1);
    });

    it("에러 이벤트가 그래프에 에러 노드로 표시", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();
      setActiveSession("test:error-graph");

      processEvent({ type: "user_message", text: "Error graph", user: "test" } as SoulSSEEvent, 0);
      processEvent({ type: "text_start" } as TextStartEvent, 1);
      processEvent({ type: "text_delta", text: "Partial work" } as TextDeltaEvent, 2);
      processEvent({ type: "error", message: "Execution failed" } as ErrorEvent, 3);

      const tree = useDashboardStore.getState().tree;
      const { nodes } = buildGraph(tree);
      const systemNodes = nodes.filter((n) => n.type === "system");

      const errorNode = systemNodes.find((n) => n.data.label.includes("Error"));
      expect(errorNode).toBeDefined();
    });

    it("도구 에러 노드가 정상 렌더링", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();
      setActiveSession("test:tool-error");
      let eventId = 1;

      processEvent({ type: "user_message", text: "Tool error", user: "test" } as SoulSSEEvent, eventId++);
      processEvent({ type: "text_start" } as TextStartEvent, eventId++);
      processEvent({ type: "text_end" } as TextEndEvent, eventId++);

      const toolEventId = eventId;
      processEvent({
        type: "tool_start",
        tool_name: "Bash",
        tool_input: { command: "invalid-cmd" },
        tool_use_id: "toolu_err1",
      } as ToolStartEvent, eventId++);

      processEvent({
        type: "tool_result",
        tool_name: "Bash",
        result: "command not found: invalid-cmd",
        is_error: true,
        tool_use_id: "toolu_err1",
      } as ToolResultEvent, eventId++);

      // tool 노드 ID는 `tool-${eventId}` 형식
      const toolNodes = collectNodes(useDashboardStore.getState().tree, (n) => n.type === "tool");
      expect(toolNodes).toHaveLength(1);
      const toolNode = toolNodes[0];
      expect(toolNode.isError).toBe(true);
      expect(toolNode.toolResult).toContain("command not found");

      // 에러 도구 노드가 그래프에서 tool_call로 표시
      const tree = useDashboardStore.getState().tree;
      const { nodes } = buildGraph(tree);

      const toolCallNode = nodes.find((n) => n.type === "tool_call");
      expect(toolCallNode).toBeDefined();
    });

    it("세션 이벤트 순서: progress → text → tool → error", () => {
      const { processEvent, setActiveSession } = useDashboardStore.getState();
      setActiveSession("test:seq");
      let id = 1;

      // id=1→user_message, id=2→text_start→"text-2", id=3→text_delta, id=4→text_end, id=5→tool_start, id=6→error
      processEvent({ type: "user_message", text: "Seq test", user: "test" } as SoulSSEEvent, id++);
      processEvent({ type: "text_start" } as TextStartEvent, id++);
      processEvent({ type: "text_delta", text: "Partial" } as TextDeltaEvent, id++);
      processEvent({ type: "text_end" } as TextEndEvent, id++);
      processEvent({
        type: "tool_start",
        tool_name: "Bash",
        tool_input: { command: "test" },
      } as ToolStartEvent, id++);
      // 타임아웃으로 tool_result 없이 에러
      processEvent({
        type: "error",
        message: "Timed out waiting for tool result",
      } as ErrorEvent, id++);

      const state = useDashboardStore.getState();

      // 텍스트 노드는 완료 (node ID: "text-2")
      const textNode = findTreeNode(state.tree, "text-2");
      expect(textNode).not.toBeNull();
      expect(textNode!.completed).toBe(true);

      // 도구 노드는 미완료 (tool 노드 ID는 tool-${eventId} 형식)
      const toolNodes = collectNodes(state.tree, (n) => n.type === "tool");
      expect(toolNodes).toHaveLength(1);
      expect(toolNodes[0].completed).toBe(false);
      expect(toolNodes[0].type).toBe("tool");
    });
  });
});
