/**
 * viewport-graph-builder 테스트
 *
 * buildViewportGraph가 ViewportEvent[]를 올바르게 GraphNode/GraphEdge로
 * 변환하는지 검증한다.
 */
import { describe, test, expect } from "vitest";
import {
  buildViewportGraph,
  type ViewportEvent,
} from "./viewport-graph-builder";
import { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT } from "./layout-engine";
import { TREE_H_GAP } from "./tree-layout";

// === Helpers ===

function makeEvent(
  overrides: Partial<ViewportEvent> & { id: number; event_type: string },
): ViewportEvent {
  return {
    parent_event_id: null,
    depth: 0,
    y_start: 1,
    y_end: 1,
    payload: {},
    ...overrides,
  };
}

// === Tests ===

describe("buildViewportGraph", () => {
  test("빈 배열 → 빈 결과", () => {
    const { nodes, edges } = buildViewportGraph([]);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  test("session 이벤트 → session 노드 생성", () => {
    const events: ViewportEvent[] = [
      makeEvent({
        id: 1,
        event_type: "session",
        payload: { agent_session_id: "sess-abc" },
      }),
    ];
    const { nodes, edges } = buildViewportGraph(events);
    expect(nodes).toHaveLength(1);
    expect(edges).toHaveLength(0);
    expect(nodes[0].id).toBe("node-session-1");
    expect(nodes[0].type).toBe("session");
    expect(nodes[0].data.content).toContain("sess-abc");
  });

  test("노드 위치: depth와 y_start로 계산", () => {
    const events: ViewportEvent[] = [
      makeEvent({ id: 1, event_type: "session", depth: 0, y_start: 1 }),
      makeEvent({
        id: 2,
        event_type: "thinking",
        depth: 2,
        y_start: 5,
        parent_event_id: 1,
        payload: { content: "hmm", completed: true },
      }),
    ];
    const { nodes } = buildViewportGraph(events);

    // session: x=MARGIN+0*(W+GAP), y=MARGIN+0*H
    expect(nodes[0].position).toEqual({ x: 20, y: 20 });

    // thinking: x=MARGIN+2*(W+GAP), y=MARGIN+4*H
    const expectedX = 20 + 2 * (DEFAULT_NODE_WIDTH + TREE_H_GAP);
    const expectedY = 20 + 4 * DEFAULT_NODE_HEIGHT;
    expect(nodes[1].position).toEqual({ x: expectedX, y: expectedY });
  });

  describe("Node ID가 SSE builder(node-factory)와 일치", () => {
    test("user_message → node-user-msg-{id}", () => {
      const events = [
        makeEvent({
          id: 42,
          event_type: "user_message",
          payload: { content: "hello", user: "test" },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].id).toBe("node-user-msg-42");
      expect(nodes[0].data.cardId).toBe("user-msg-42");
    });

    test("system_message → node-system-msg-{id}", () => {
      const events = [
        makeEvent({
          id: 10,
          event_type: "system_message",
          payload: { content: "system info" },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].id).toBe("node-system-msg-10");
    });

    test("input_request → node-input-request-{id}", () => {
      const events = [
        makeEvent({
          id: 7,
          event_type: "input_request",
          payload: {
            questions: [{ question: "Choose one" }],
            completed: false,
          },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].id).toBe("node-input-request-7");
    });

    test("assistant_message → node-asst-msg-{id}", () => {
      const events = [
        makeEvent({
          id: 20,
          event_type: "assistant_message",
          payload: { content: "hi" },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].id).toBe("node-asst-msg-20");
    });

    test("assistant_error → node-asst-error-{id}", () => {
      const events = [
        makeEvent({
          id: 30,
          event_type: "assistant_error",
          payload: { error_type: "timeout" },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].id).toBe("node-asst-error-30");
    });

    test("away_summary → node-away-summary-{id}", () => {
      const events = [
        makeEvent({
          id: 50,
          event_type: "away_summary",
          payload: { content: "summary" },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].id).toBe("node-away-summary-50");
    });

    test("thinking → node-thinking-{id} (매핑 불필요, 그대로 사용)", () => {
      const events = [
        makeEvent({
          id: 3,
          event_type: "thinking",
          payload: { content: "hmm", completed: true },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].id).toBe("node-thinking-3");
    });

    test("tool/tool_use → node-tool-{id}-call (call suffix)", () => {
      const events = [
        makeEvent({
          id: 5,
          event_type: "tool",
          payload: { name: "Read", completed: true },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].id).toBe("node-tool-5-call");
      expect(nodes[0].data.cardId).toBe("tool-5");
    });

    test("tool_use event_type도 tool prefix 사용", () => {
      const events = [
        makeEvent({
          id: 8,
          event_type: "tool_use",
          payload: { name: "Grep", completed: true },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].id).toBe("node-tool-8-call");
    });
  });

  describe("엣지 생성", () => {
    test("parent_event_id로 부모-자식 엣지 생성", () => {
      const events = [
        makeEvent({ id: 1, event_type: "session" }),
        makeEvent({
          id: 2,
          event_type: "user_message",
          parent_event_id: 1,
          payload: { content: "hello", user: "u" },
        }),
      ];
      const { edges } = buildViewportGraph(events);
      expect(edges).toHaveLength(1);
      expect(edges[0].source).toBe("node-session-1");
      expect(edges[0].target).toBe("node-user-msg-2");
    });

    test("tool 부모 → -call suffix 엣지로 연결", () => {
      const events = [
        makeEvent({
          id: 1,
          event_type: "tool",
          payload: { name: "Agent", completed: true },
        }),
        makeEvent({
          id: 2,
          event_type: "thinking",
          parent_event_id: 1,
          payload: { content: "sub-think", completed: true },
        }),
      ];
      const { edges } = buildViewportGraph(events);
      expect(edges).toHaveLength(1);
      expect(edges[0].source).toBe("node-tool-1-call");
    });

    test("viewport 범위 밖 부모 → 엣지 생략 (orphan)", () => {
      const events = [
        makeEvent({
          id: 100,
          event_type: "thinking",
          parent_event_id: 50,
          payload: { content: "orphan", completed: true },
        }),
      ];
      const { nodes, edges } = buildViewportGraph(events);
      expect(nodes).toHaveLength(1);
      expect(edges).toHaveLength(0);
    });
  });

  describe("스트리밍 델타 이벤트 스킵", () => {
    test("text_delta, thinking_delta, subtree_update 등 → 노드 생성 안 함", () => {
      const events = [
        makeEvent({ id: 1, event_type: "text_delta" }),
        makeEvent({ id: 2, event_type: "thinking_delta" }),
        makeEvent({ id: 3, event_type: "history_sync" }),
        makeEvent({ id: 4, event_type: "subtree_update" }),
        makeEvent({ id: 5, event_type: "session_updated" }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes).toHaveLength(0);
    });
  });

  describe("이벤트 유형별 노드 속성", () => {
    test("thinking — streaming 상태는 completed 기반", () => {
      const events = [
        makeEvent({
          id: 1,
          event_type: "thinking",
          payload: { content: "thinking...", completed: false },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].data.streaming).toBe(true);
    });

    test("thinking — completed: true → streaming: false", () => {
      const events = [
        makeEvent({
          id: 1,
          event_type: "thinking",
          payload: { content: "done", completed: true },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].data.streaming).toBe(false);
    });

    test("tool — toolCategory 감지: Skill → skill, Agent → sub-agent", () => {
      const skill = makeEvent({
        id: 1,
        event_type: "tool",
        payload: { name: "Skill", completed: true },
      });
      const agent = makeEvent({
        id: 2,
        event_type: "tool",
        payload: { name: "Agent", completed: true },
      });
      const normal = makeEvent({
        id: 3,
        event_type: "tool",
        payload: { name: "Read", completed: true },
      });

      const r1 = buildViewportGraph([skill]);
      expect(r1.nodes[0].data.toolCategory).toBe("skill");

      const r2 = buildViewportGraph([agent]);
      expect(r2.nodes[0].data.toolCategory).toBe("sub-agent");

      const r3 = buildViewportGraph([normal]);
      expect(r3.nodes[0].data.toolCategory).toBeUndefined();
    });

    test("error 노드 — isError: true", () => {
      const events = [
        makeEvent({
          id: 1,
          event_type: "error",
          payload: { content: "boom" },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].data.isError).toBe(true);
    });

    test("result 노드 — duration/cost 포맷", () => {
      const events = [
        makeEvent({
          id: 1,
          event_type: "result",
          payload: {
            duration_ms: 12500,
            total_cost_usd: 0.0342,
            usage: { input_tokens: 1000, output_tokens: 500 },
          },
        }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes[0].data.content).toContain("12.5s");
      expect(nodes[0].data.content).toContain("$0.0342");
    });

    test("미지 이벤트 타입 → system 노드로 fallback", () => {
      const events = [
        makeEvent({ id: 1, event_type: "future_event_type" }),
      ];
      const { nodes } = buildViewportGraph(events);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].type).toBe("system");
      expect(nodes[0].data.content).toContain("future_event_type");
    });
  });
});
