/**
 * 통합 테스트: JSONL 픽스처 기반 시나리오 검증
 *
 * Phase 1~5 핵심 기능을 JSONL 픽스처 → store.processEvent → buildGraph 파이프라인으로 검증합니다.
 *
 * 시나리오:
 * - basic-flow: thinking → thinking → complete (기본 플로우)
 * - tree-layout: thinking → tool_call → thinking → tool_call → thinking (트리 분기)
 * - intervention-flow: 중간에 사용자 개입 포함
 * - multi-tool: 다중 tool 호출 + result (running 상태 해제)
 * - complete-flow: 세션 완료 시 thinking 노드 + complete 노드
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  useDashboardStore,
  findTreeNode,
  type SoulSSEEvent,
  type EventRecord,
  type EventTreeNode,
} from "@seosoyoung/soul-ui";
import {
  buildGraph,
  type GraphNode,
} from "@seosoyoung/soul-ui";

// === Fixture Loader ===

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");

function loadFixture(name: string): EventRecord[] {
  const content = readFileSync(join(FIXTURES_DIR, `${name}.jsonl`), "utf-8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as EventRecord);
}

/**
 * 픽스처의 이벤트를 store.processEvent로 순차 재생합니다.
 * 재생 후 store의 tree, treeVersion을 반환합니다.
 */
function replayFixture(name: string) {
  const records = loadFixture(name);
  const { processEvent } = useDashboardStore.getState();

  // 활성 세션 설정 (store가 동작하려면 필요)
  useDashboardStore.getState().setActiveSession("test:fixture");

  for (const record of records) {
    processEvent(record.event as unknown as SoulSSEEvent, record.id);
  }

  const state = useDashboardStore.getState();
  return {
    tree: state.tree,
    treeVersion: state.treeVersion,
    lastEventId: state.lastEventId,
    records,
  };
}

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

// === Test Suites ===

describe("JSONL Fixture Integration Tests", () => {
  beforeEach(() => {
    useDashboardStore.getState().reset();
  });

  // === basic-flow: thinking → thinking → complete ===

  describe("basic-flow: 기본 텍스트 플로우", () => {
    it("텍스트 노드 2개가 생성된다", () => {
      const { tree } = replayFixture("basic-flow");
      const textNodes = collectNodes(tree, (n) => n.type === "text");
      expect(textNodes).toHaveLength(2);
    });

    it("모든 텍스트 노드가 completed 상태이다", () => {
      const { tree } = replayFixture("basic-flow");
      const textNodes = collectNodes(tree, (n) => n.type === "text");
      expect(textNodes.every((n) => n.completed)).toBe(true);
    });

    it("텍스트 델타가 올바르게 누적된다", () => {
      const { tree } = replayFixture("basic-flow");
      const textNodes = collectNodes(tree, (n) => n.type === "text");
      expect(textNodes[0].content).toContain("Let me analyze the code...");
      expect(textNodes[0].content).toContain("React component");
      expect(textNodes[1].content).toContain("three panels");
    });

    it("complete 노드가 트리에 포함된다", () => {
      const { tree } = replayFixture("basic-flow");
      const completeNodes = collectNodes(tree, (n) => n.type === "complete");
      expect(completeNodes.length).toBeGreaterThanOrEqual(1);
    });

    it("buildGraph에서 모든 텍스트가 text 노드가 된다 (thinking/text 분리)", () => {
      const { tree } = replayFixture("basic-flow");
      const { nodes } = buildGraph(tree);

      // response 노드 타입은 더 이상 사용되지 않음
      const responseNodes = nodes.filter((n) => n.type === "response");
      expect(responseNodes).toHaveLength(0);

      // text tree 노드는 text graph 노드로
      const textNodes = nodes.filter((n) => n.type === "text");
      expect(textNodes.length).toBeGreaterThanOrEqual(1);
    });

    it("buildGraph에서 user_message가 user 노드로 생성된다", () => {
      const { tree } = replayFixture("basic-flow");
      const { nodes } = buildGraph(tree);

      const userNodes = nodes.filter((n) => n.type === "user");
      expect(userNodes).toHaveLength(1);
      expect(userNodes[0].data.content).toContain("Analyze this code");
    });

    it("buildGraph에서 complete system 노드가 생성된다", () => {
      const { tree } = replayFixture("basic-flow");
      const { nodes } = buildGraph(tree);

      const systemNodes = nodes.filter((n) => n.type === "system");
      const completeNode = systemNodes.find((n) => n.data.label === "Complete");
      expect(completeNode).toBeDefined();
    });

    it("buildGraph에서 엣지가 노드를 올바르게 연결한다", () => {
      const { tree } = replayFixture("basic-flow");
      const { nodes, edges } = buildGraph(tree);

      // 노드 수 검증: user + thinking(들) + complete
      expect(nodes.length).toBeGreaterThanOrEqual(4);
      // 엣지는 노드를 연결
      expect(edges.length).toBeGreaterThanOrEqual(nodes.length - 2);
    });
  });

  // === tree-layout: thinking → tool → thinking → tool → thinking ===

  describe("tree-layout: 트리 분기 레이아웃", () => {
    it("텍스트 3개 + 도구 2개 노드가 생성된다", () => {
      const { tree } = replayFixture("tree-layout");
      const textNodes = collectNodes(tree, (n) => n.type === "text");
      const toolNodes = collectNodes(tree, (n) => n.type === "tool");
      expect(textNodes).toHaveLength(3);
      expect(toolNodes).toHaveLength(2);
    });

    it("도구 노드에 toolName과 toolResult가 올바르게 설정된다", () => {
      const { tree } = replayFixture("tree-layout");
      const toolNodes = collectNodes(tree, (n) => n.type === "tool");
      expect(toolNodes[0].toolName).toBe("Read");
      expect(toolNodes[0].toolResult).toContain("App()");
      expect(toolNodes[0].completed).toBe(true);
      expect(toolNodes[1].toolName).toBe("Read");
      expect(toolNodes[1].toolResult).toContain("import { App }");
    });

    it("buildGraph에서 tool_call 노드가 생성된다", () => {
      const { tree } = replayFixture("tree-layout");
      const { nodes } = buildGraph(tree);

      const toolCallNodes = nodes.filter((n) => n.type === "tool_call");
      expect(toolCallNodes).toHaveLength(2);
    });

    it("buildGraph에서 tool 노드는 메인 흐름에서 수평 분기한다", () => {
      const { tree } = replayFixture("tree-layout");
      const { edges, nodes } = buildGraph(tree);

      // thinking 또는 메인 흐름 노드에서 tool_call로의 엣지에 sourceHandle="right" 확인
      const toolCallEdges = edges.filter((e) =>
        nodes.find((n) => n.id === e.target && n.type === "tool_call"),
      );
      expect(toolCallEdges.length).toBeGreaterThanOrEqual(1);
      // 수평 분기 엣지는 right→left handle 사용
      const horizontalEdges = toolCallEdges.filter(
        (e) => e.sourceHandle === "right" || e.targetHandle === "left",
      );
      expect(horizontalEdges.length).toBeGreaterThanOrEqual(1);
    });
  });

  // === intervention-flow: 중간 개입 포함 ===

  describe("intervention-flow: 사용자 개입 시나리오", () => {
    it("개입 노드가 트리에 포함된다", () => {
      const { tree } = replayFixture("intervention-flow");
      const interventionNodes = collectNodes(
        tree,
        (n) => n.type === "intervention",
      );
      expect(interventionNodes.length).toBeGreaterThanOrEqual(1);
    });

    it("개입 전후의 노드가 모두 존재한다", () => {
      const { tree } = replayFixture("intervention-flow");
      const textNodes = collectNodes(tree, (n) => n.type === "text");
      const toolNodes = collectNodes(tree, (n) => n.type === "tool");
      // 개입 전후로 텍스트와 도구 노드가 존재
      expect(textNodes.length).toBeGreaterThanOrEqual(2);
      expect(toolNodes.length).toBeGreaterThanOrEqual(1);
    });

    it("buildGraph에서 intervention 노드가 생성된다", () => {
      const { tree } = replayFixture("intervention-flow");
      const { nodes } = buildGraph(tree);

      const interventionNodes = nodes.filter((n) => n.type === "intervention");
      expect(interventionNodes).toHaveLength(1);
      expect(interventionNodes[0].data.content).toContain("src/client");
    });

    it("buildGraph에서 intervention 노드가 부모에 연결된다", () => {
      const { tree } = replayFixture("intervention-flow");
      const { edges, nodes } = buildGraph(tree);

      // intervention 노드에 incoming 엣지가 있어야 함 (부모→intervention)
      const interventionNode = nodes.find((n) => n.type === "intervention");
      expect(interventionNode).toBeDefined();

      const incomingEdges = edges.filter(
        (e) => e.target === interventionNode!.id,
      );
      // horizontal layout: intervention connects to parent (incoming only)
      // outgoing edge is optional (depends on whether intervention has children)
      expect(incomingEdges.length).toBeGreaterThanOrEqual(1);
    });
  });

  // === multi-tool: 다중 도구 호출 + running 상태 해제 ===

  describe("multi-tool: 다중 도구 호출", () => {
    it("4개의 도구 노드가 생성된다", () => {
      const { tree } = replayFixture("multi-tool");
      const toolNodes = collectNodes(tree, (n) => n.type === "tool");
      expect(toolNodes).toHaveLength(4);
    });

    it("모든 도구 노드가 completed + toolResult을 갖는다", () => {
      const { tree } = replayFixture("multi-tool");
      const toolNodes = collectNodes(tree, (n) => n.type === "tool");
      for (const node of toolNodes) {
        expect(node.completed).toBe(true);
        expect(node.toolResult).toBeDefined();
      }
    });

    it("도구 노드의 streaming 상태가 모두 해제된다 (buildGraph)", () => {
      const { tree } = replayFixture("multi-tool");
      const { nodes } = buildGraph(tree);

      const toolCallNodes = nodes.filter((n) => n.type === "tool_call");
      for (const node of toolCallNodes) {
        expect(node.data.streaming).toBe(false);
      }
    });

    it("연속 tool 호출이 부모 노드에서 수평 분기된다", () => {
      const { tree } = replayFixture("multi-tool");
      const { edges, nodes } = buildGraph(tree);

      const toolCallNodes = nodes.filter((n) => n.type === "tool_call");

      // tool_call→tool_call 직접 연결은 없어야 함
      const chainEdges = edges.filter((e) => {
        const source = nodes.find((n) => n.id === e.source);
        const target = nodes.find((n) => n.id === e.target);
        return source?.type === "tool_call" && target?.type === "tool_call";
      });
      expect(chainEdges.length).toBe(0);

      // 모든 tool_call에 수평 엣지(right→left)가 있어야 함
      const branchEdges = edges.filter((e) => {
        const target = nodes.find((n) => n.id === e.target);
        return target?.type === "tool_call" && e.sourceHandle === "right" && e.targetHandle === "left";
      });
      expect(branchEdges.length).toBeGreaterThanOrEqual(toolCallNodes.length);
    });

    it("lastEventId가 마지막 이벤트 ID와 일치한다", () => {
      const { lastEventId, records } = replayFixture("multi-tool");
      expect(lastEventId).toBe(records[records.length - 1].id);
    });
  });

  // === complete-flow: complete 카드 + thinking 노드 ===

  describe("complete-flow: 세션 완료 + text 노드", () => {
    it("모든 텍스트 노드가 text 타입이다 (thinking/text 분리)", () => {
      const { tree } = replayFixture("complete-flow");
      const { nodes } = buildGraph(tree);

      const responseNodes = nodes.filter((n) => n.type === "response");
      expect(responseNodes).toHaveLength(0);

      const textNodes = nodes.filter((n) => n.type === "text");
      expect(textNodes.length).toBeGreaterThanOrEqual(1);
    });

    it("마지막 text 노드는 streaming=false 이다", () => {
      const { tree } = replayFixture("complete-flow");
      const { nodes } = buildGraph(tree);

      const textNodes = nodes.filter((n) => n.type === "text");
      const lastText = textNodes[textNodes.length - 1];
      expect(lastText.data.streaming).toBe(false);
    });

    it("complete system 노드가 그래프 끝에 위치한다", () => {
      const { tree } = replayFixture("complete-flow");
      const { nodes, edges } = buildGraph(tree);

      const completeNode = nodes.find(
        (n) => n.type === "system" && n.data.label === "Complete",
      );
      expect(completeNode).toBeDefined();

      // complete 노드에서 나가는 엣지가 없어야 함 (마지막 노드)
      const outgoing = edges.filter((e) => e.source === completeNode!.id);
      expect(outgoing).toHaveLength(0);
    });

    it("text와 complete 노드가 같은 부모에 연결된다", () => {
      const { tree } = replayFixture("complete-flow");
      const { nodes, edges } = buildGraph(tree);

      const textNodes = nodes.filter((n) => n.type === "text");
      const lastText = textNodes[textNodes.length - 1];
      const completeNode = nodes.find(
        (n) => n.type === "system" && n.data.label === "Complete",
      )!;

      // Horizontal layout: text and complete are siblings (both connect to same parent)
      // Find the parent of text node
      const textIncomingEdge = edges.find((e) => e.target === lastText.id);
      const completeIncomingEdge = edges.find((e) => e.target === completeNode.id);
      expect(textIncomingEdge).toBeDefined();
      expect(completeIncomingEdge).toBeDefined();
      // Both should connect from the same parent
      expect(textIncomingEdge!.source).toBe(completeIncomingEdge!.source);
    });

    it("전체 노드 수가 올바르다", () => {
      const { tree } = replayFixture("complete-flow");
      const { nodes } = buildGraph(tree);

      // 트리 기반: user + thinking(들) + tool_call + complete
      expect(nodes.length).toBeGreaterThanOrEqual(5);
    });

    it("dagre 레이아웃이 적용되어 모든 노드에 position이 설정된다", () => {
      const { tree } = replayFixture("complete-flow");
      const { nodes } = buildGraph(tree);

      for (const node of nodes) {
        expect(node.position).toBeDefined();
        expect(typeof node.position.x).toBe("number");
        expect(typeof node.position.y).toBe("number");
      }
    });
  });

  // === 공통 검증: 모든 픽스처 ===

  describe("공통: 모든 픽스처에 대한 기본 검증", () => {
    const fixtures = [
      "basic-flow",
      "tree-layout",
      "intervention-flow",
      "multi-tool",
      "complete-flow",
    ];

    for (const name of fixtures) {
      it(`${name}: buildGraph가 에러 없이 실행된다`, () => {
        useDashboardStore.getState().reset();
        const { tree } = replayFixture(name);
        expect(() => buildGraph(tree)).not.toThrow();
      });

      it(`${name}: 모든 노드에 유효한 id가 있다`, () => {
        useDashboardStore.getState().reset();
        const { tree } = replayFixture(name);
        const { nodes } = buildGraph(tree);
        for (const node of nodes) {
          expect(node.id).toBeTruthy();
          expect(typeof node.id).toBe("string");
        }
      });

      it(`${name}: 모든 엣지의 source/target이 존재하는 노드 ID이다`, () => {
        useDashboardStore.getState().reset();
        const { tree } = replayFixture(name);
        const { nodes, edges } = buildGraph(tree);
        const nodeIds = new Set(nodes.map((n) => n.id));
        for (const edge of edges) {
          expect(nodeIds.has(edge.source)).toBe(true);
          expect(nodeIds.has(edge.target)).toBe(true);
        }
      });

      it(`${name}: 엣지 ID가 고유하다`, () => {
        useDashboardStore.getState().reset();
        const { tree } = replayFixture(name);
        const { edges } = buildGraph(tree);
        const edgeIds = edges.map((e) => e.id);
        expect(new Set(edgeIds).size).toBe(edgeIds.length);
      });
    }
  });
});
