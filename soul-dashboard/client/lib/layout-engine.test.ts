/**
 * layout-engine 테스트
 *
 * buildGraph, applyDagreLayout, detectSubAgents, createEdge 함수를 테스트합니다.
 * EventTreeNode 트리 기반 API를 검증합니다.
 */

import { describe, it, expect } from "vitest";
import type { EventTreeNode } from "@shared/types";
import {
  buildGraph,
  applyDagreLayout,
  detectSubAgents,
  createEdge,
  getNodeDimensions,
  calcToolChainBounds,
  countAllDescendants,
  type GraphNode,
  type ToolChainEntry,
} from "./layout-engine";

// === Helper: 트리 노드 팩토리 ===

function sessionRoot(children: EventTreeNode[] = [], sessionId?: string): EventTreeNode {
  return {
    id: "root-session",
    type: "session",
    children,
    content: sessionId ?? "",
    completed: true,
    sessionId,
  };
}

function userMsg(id: string, text: string, children: EventTreeNode[] = []): EventTreeNode {
  return {
    id,
    type: "user_message",
    children,
    content: text,
    completed: true,
    user: "user",
  };
}

function textNode(id: string, content: string, completed = true, children: EventTreeNode[] = []): EventTreeNode {
  return {
    id,
    type: "text",
    children,
    content,
    completed,
  };
}

function toolNode(
  id: string,
  toolName: string,
  opts: Partial<EventTreeNode> = {},
): EventTreeNode {
  return {
    id,
    type: "tool",
    children: [],
    content: "",
    toolName,
    toolInput: opts.toolInput ?? { command: "test" },
    toolResult: opts.toolResult,
    isError: opts.isError,
    completed: opts.completed ?? true,
    toolUseId: opts.toolUseId,
  };
}

function completeNode(id: string, result = "done"): EventTreeNode {
  return {
    id,
    type: "complete",
    children: [],
    content: result,
    completed: true,
  };
}

function errorNode(id: string, message: string): EventTreeNode {
  return {
    id,
    type: "error",
    children: [],
    content: message,
    completed: true,
    isError: true,
  };
}

function interventionNode(id: string, text: string): EventTreeNode {
  return {
    id,
    type: "intervention",
    children: [],
    content: text,
    completed: true,
    user: "admin",
  };
}

function subagentNode(
  id: string,
  agentType: string,
  children: EventTreeNode[] = [],
  opts: Partial<EventTreeNode> = {},
): EventTreeNode {
  return {
    id,
    type: "subagent",
    children,
    content: "",
    completed: opts.completed ?? false,
    agentId: id,
    agentType,
    parentToolUseId: opts.parentToolUseId,
  };
}

function resultNode(id: string, opts: Partial<EventTreeNode> = {}): EventTreeNode {
  return {
    id,
    type: "result",
    children: [],
    content: opts.content || "Session completed",
    completed: true,
    durationMs: opts.durationMs,
    usage: opts.usage,
    totalCostUsd: opts.totalCostUsd,
  };
}

// === Tests ===

describe("getNodeDimensions", () => {
  it("returns correct dimensions for each node type", () => {
    expect(getNodeDimensions("thinking")).toEqual({ width: 260, height: 84 });
    expect(getNodeDimensions("tool_call")).toEqual({ width: 260, height: 84 });
    expect(getNodeDimensions("system")).toEqual({ width: 260, height: 84 });
    expect(getNodeDimensions("group")).toEqual({ width: 320, height: 100 });
  });
});

describe("createEdge", () => {
  it("creates an edge with correct source and target", () => {
    const edge = createEdge("a", "b");
    expect(edge.source).toBe("a");
    expect(edge.target).toBe("b");
    expect(edge.animated).toBe(false);
    expect(edge.id).toContain("e-a-b");
  });

  it("supports animated edges", () => {
    const edge = createEdge("a", "b", true);
    expect(edge.animated).toBe(true);
  });

  it("supports custom handle IDs", () => {
    const edge = createEdge("a", "b", false, "right", "left");
    expect(edge.sourceHandle).toBe("right");
    expect(edge.targetHandle).toBe("left");
  });

  it("generates deterministic unique IDs (no module-level counter)", () => {
    const e1 = createEdge("a", "b");
    const e2 = createEdge("a", "b");
    expect(e1.id).toBe(e2.id);

    const e3 = createEdge("a", "b", false, "right", "left");
    expect(e3.id).not.toBe(e1.id);
  });
});

describe("detectSubAgents", () => {
  it("returns empty array when no Task tools", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "hello", true, [
          toolNode("tool1", "Bash"),
        ]),
      ]),
    ]);
    expect(detectSubAgents(tree)).toEqual([]);
  });

  it("detects a single sub-agent group from Task tool", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "start", true, [
          toolNode("task1", "Task", {
            toolInput: { description: "Explore codebase", prompt: "..." },
            completed: true,
          }),
          toolNode("t2", "Bash", { completed: true }),
        ]),
      ]),
    ]);

    const groups = detectSubAgents(tree);
    expect(groups).toHaveLength(1);
    expect(groups[0].taskCardId).toBe("task1");
    expect(groups[0].cardIds).toContain("task1");
    expect(groups[0].cardIds).toContain("t2");
    expect(groups[0].label).toContain("Explore codebase");
  });

  it("detects running (incomplete) Task as sub-agent group", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "thinking", true, [
          toolNode("task1", "Task", {
            toolInput: { description: "Long running task" },
            completed: false,
          }),
          toolNode("tool1", "Bash", { completed: false }),
        ]),
      ]),
    ]);

    const groups = detectSubAgents(tree);
    expect(groups).toHaveLength(1);
    expect(groups[0].cardIds).toEqual(["task1", "tool1"]);
  });

  it("truncates long task descriptions", () => {
    const longDesc = "A".repeat(100);
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "thinking", true, [
          toolNode("task1", "Task", {
            toolInput: { description: longDesc },
            completed: true,
          }),
        ]),
      ]),
    ]);

    const groups = detectSubAgents(tree);
    expect(groups[0].label.length).toBeLessThanOrEqual(50);
    expect(groups[0].label).toContain("...");
  });
});

describe("buildGraph", () => {
  it("returns empty graph for null tree", () => {
    const result = buildGraph(null);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("creates thinking node for text node", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Hello world"),
      ]),
    ]);
    const { nodes } = buildGraph(tree);

    const thinkingNodes = nodes.filter((n) => n.type === "thinking");
    expect(thinkingNodes).toHaveLength(1);
    expect(thinkingNodes[0].data.content).toContain("Hello world");
    expect(thinkingNodes[0].data.cardId).toBe("t1");
  });

  it("all text nodes become thinking type (response heuristic removed)", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking..."),
        textNode("t2", "Final response"),
        completeNode("c1"),
      ]),
    ]);
    const { nodes } = buildGraph(tree);

    // response 노드 타입은 더 이상 사용되지 않음 — 모든 text는 thinking
    const responseNodes = nodes.filter((n) => n.type === "response");
    expect(responseNodes).toHaveLength(0);

    const thinkingNodes = nodes.filter((n) => n.type === "thinking");
    expect(thinkingNodes).toHaveLength(2);
    expect(thinkingNodes[0].data.cardId).toBe("t1");
    expect(thinkingNodes[1].data.cardId).toBe("t2");
  });

  it("creates tool_call and tool_result nodes for tool node", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "thinking", true, [
          toolNode("tool1", "Bash", {
            toolInput: { command: "ls" },
            toolResult: "file1.txt\nfile2.txt",
            completed: true,
          }),
        ]),
      ]),
    ]);
    const { nodes, edges } = buildGraph(tree);

    const callNodes = nodes.filter((n) => n.type === "tool_call");
    expect(callNodes).toHaveLength(1);
    expect(callNodes[0].data.toolName).toBe("Bash");

    const resultNodes = nodes.filter((n) => n.type === "tool_result");
    expect(resultNodes).toHaveLength(1);
    expect(resultNodes[0].data.toolResult).toContain("file1.txt");

    const callToResult = edges.find(
      (e) => e.source === "node-tool1-call" && e.target === "node-tool1-result",
    );
    expect(callToResult).toBeDefined();
    expect(callToResult!.sourceHandle).toBe("right");
    expect(callToResult!.targetHandle).toBe("left");
  });

  it("tool_result node includes cardId for DetailView selection", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "thinking", true, [
          toolNode("tool1", "Bash", {
            toolInput: { command: "ls" },
            toolResult: "output",
            completed: true,
          }),
        ]),
      ]),
    ]);
    const { nodes } = buildGraph(tree);
    const resultNode = nodes.find((n) => n.type === "tool_result");
    expect(resultNode).toBeDefined();
    expect(resultNode!.data.cardId).toBe("tool1");
  });

  it("empty tool_result node includes cardId for DetailView selection", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "thinking", true, [
          toolNode("tool1", "Bash", {
            toolInput: { command: "echo" },
            toolResult: undefined,
            completed: true,
          }),
        ]),
      ]),
    ]);
    const { nodes } = buildGraph(tree);
    const resultNode = nodes.find((n) => n.type === "tool_result");
    expect(resultNode).toBeDefined();
    expect(resultNode!.data.cardId).toBe("tool1");
  });

  it("creates system nodes for session and complete", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "hello"),
        completeNode("c1"),
      ]),
    ], "test-session-123");
    const { nodes } = buildGraph(tree);

    const systemNodes = nodes.filter((n) => n.type === "system");
    expect(systemNodes).toHaveLength(2);

    const sessionNode = systemNodes.find((n) => n.data.label.includes("Session"));
    expect(sessionNode).toBeDefined();

    const completeNodeResult = systemNodes.find((n) => n.data.label.includes("Complete"));
    expect(completeNodeResult).toBeDefined();
  });

  it("creates intervention nodes", () => {
    const tree = sessionRoot([
      userMsg("u1", "before", [
        textNode("t1", "thinking"),
      ]),
      interventionNode("i1", "stop that"),
    ]);
    const { nodes } = buildGraph(tree);

    const interventionNodes = nodes.filter((n) => n.type === "intervention");
    expect(interventionNodes).toHaveLength(1);
    expect(interventionNodes[0].data.content).toContain("stop that");
  });

  it("marks streaming nodes correctly", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "partial", false, [
          toolNode("tool1", "Read", { completed: false }),
        ]),
      ]),
    ]);
    const { nodes } = buildGraph(tree);

    const textGraphNode = nodes.find((n) => n.data.cardId === "t1");
    expect(textGraphNode?.data.streaming).toBe(true);

    const toolGraphNode = nodes.find(
      (n) => n.data.cardId === "tool1" && n.type === "tool_call",
    );
    expect(toolGraphNode?.data.streaming).toBe(true);
  });

  it("creates sequential edges between nodes", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "first", true, [
          toolNode("tool1", "Bash", {
            toolResult: "ok",
            completed: true,
          }),
        ]),
        textNode("t2", "last"),
      ]),
    ]);
    const { edges } = buildGraph(tree);
    expect(edges.length).toBeGreaterThanOrEqual(3);
  });

  // === 트리 뷰 레이아웃 구조 검증 ===

  describe("tree view layout (thinking→tool horizontal branch)", () => {
    it("thinking→tool_call uses horizontal edge (right→left)", () => {
      const tree = sessionRoot([
        userMsg("u1", "hi", [
          textNode("t1", "thinking about tools", true, [
            toolNode("tool1", "Bash", { toolResult: "ok", completed: true }),
          ]),
        ]),
      ]);
      const { edges } = buildGraph(tree);

      const thinkingToTool = edges.find(
        (e) => e.source === "node-t1" && e.target === "node-tool1-call",
      );
      expect(thinkingToTool).toBeDefined();
      expect(thinkingToTool!.sourceHandle).toBe("right");
      expect(thinkingToTool!.targetHandle).toBe("left");
    });

    it("thinking→thinking uses vertical edge (no handles)", () => {
      const tree = sessionRoot([
        userMsg("u1", "hi", [
          textNode("t1", "first thinking", true, [
            toolNode("tool1", "Bash", { toolResult: "ok", completed: true }),
          ]),
          textNode("t2", "second thinking"),
        ]),
      ]);
      const { edges } = buildGraph(tree);

      const thinkingToThinking = edges.find(
        (e) => e.source === "node-t1" && e.target === "node-t2",
      );
      expect(thinkingToThinking).toBeDefined();
      expect(thinkingToThinking!.sourceHandle).toBeUndefined();
      expect(thinkingToThinking!.targetHandle).toBeUndefined();
    });

    it("tool nodes do NOT participate in main vertical chain", () => {
      const tree = sessionRoot([
        userMsg("u1", "hi", [
          textNode("t1", "first", true, [
            toolNode("tool1", "Bash", { toolResult: "ok", completed: true }),
          ]),
          textNode("t2", "second"),
        ]),
      ]);
      const { edges } = buildGraph(tree);

      const resultToThinking = edges.find(
        (e) => e.source === "node-tool1-result" && e.target === "node-t2",
      );
      expect(resultToThinking).toBeUndefined();

      const t1ToT2 = edges.find(
        (e) => e.source === "node-t1" && e.target === "node-t2",
      );
      expect(t1ToT2).toBeDefined();
    });

    it("multiple tools from same thinking chain horizontally", () => {
      const tree = sessionRoot([
        userMsg("u1", "hi", [
          textNode("t1", "thinking", true, [
            toolNode("toolA", "Bash", { toolResult: "ok", completed: true }),
            toolNode("toolB", "Read", { toolResult: "content", completed: true }),
          ]),
          textNode("t2", "next"),
        ]),
      ]);
      const { edges } = buildGraph(tree);

      const t1ToA = edges.find(
        (e) => e.source === "node-t1" && e.target === "node-toolA-call",
      );
      expect(t1ToA).toBeDefined();
      expect(t1ToA!.sourceHandle).toBe("right");

      const t1ToB = edges.find(
        (e) => e.source === "node-t1" && e.target === "node-toolB-call",
      );
      expect(t1ToB).toBeDefined();
      expect(t1ToB!.sourceHandle).toBe("right");
      expect(t1ToB!.targetHandle).toBe("left");

      const t1ToT2 = edges.find(
        (e) => e.source === "node-t1" && e.target === "node-t2",
      );
      expect(t1ToT2).toBeDefined();
      expect(t1ToT2!.sourceHandle).toBeUndefined();
    });

    it("tool_call→tool_result uses horizontal edge (right→left)", () => {
      const tree = sessionRoot([
        userMsg("u1", "hi", [
          textNode("t1", "thinking", true, [
            toolNode("tool1", "Bash", { toolResult: "ok", completed: true }),
          ]),
        ]),
      ]);
      const { edges } = buildGraph(tree);

      const callToResult = edges.find(
        (e) => e.source === "node-tool1-call" && e.target === "node-tool1-result",
      );
      expect(callToResult).toBeDefined();
      expect(callToResult!.sourceHandle).toBe("right");
      expect(callToResult!.targetHandle).toBe("left");
    });

    it("complex scenario: thinking→tool→thinking→tool→thinking", () => {
      const tree = sessionRoot([
        userMsg("u1", "hi", [
          textNode("t1", "first thinking", true, [
            toolNode("toolA", "Bash", { toolResult: "ok", completed: true }),
          ]),
          textNode("t2", "second thinking", true, [
            toolNode("toolB", "Read", { toolResult: "file", completed: true }),
          ]),
          textNode("t3", "final response"),
          completeNode("c1"),
        ]),
      ]);
      const { nodes, edges } = buildGraph(tree);

      // Main vertical chain: t1 → t2 → t3
      expect(edges.find((e) => e.source === "node-t1" && e.target === "node-t2")).toBeDefined();
      expect(edges.find((e) => e.source === "node-t2" && e.target === "node-t3")).toBeDefined();

      // Horizontal branches
      const t1ToA = edges.find((e) => e.source === "node-t1" && e.target === "node-toolA-call");
      expect(t1ToA).toBeDefined();
      expect(t1ToA!.sourceHandle).toBe("right");

      const t2ToB = edges.find((e) => e.source === "node-t2" && e.target === "node-toolB-call");
      expect(t2ToB).toBeDefined();
      expect(t2ToB!.sourceHandle).toBe("right");

      // Horizontal tool results
      const aResult = edges.find((e) => e.source === "node-toolA-call" && e.target === "node-toolA-result");
      expect(aResult).toBeDefined();
      expect(aResult!.sourceHandle).toBe("right");
      expect(aResult!.targetHandle).toBe("left");

      const bResult = edges.find((e) => e.source === "node-toolB-call" && e.target === "node-toolB-result");
      expect(bResult).toBeDefined();

      // t3 should be thinking node (response heuristic removed)
      const t3Node = nodes.find((n) => n.id === "node-t3");
      expect(t3Node?.type).toBe("thinking");

      // No tool→thinking vertical edges
      expect(edges.find((e) => e.source === "node-toolA-result" && e.target === "node-t2")).toBeUndefined();
      expect(edges.find((e) => e.source === "node-toolB-result" && e.target === "node-t3")).toBeUndefined();
    });

    it("streaming tool (no result yet) still branches horizontally", () => {
      const tree = sessionRoot([
        userMsg("u1", "hi", [
          textNode("t1", "thinking", true, [
            toolNode("tool1", "Bash", { completed: false }),
          ]),
        ]),
      ]);
      const { edges } = buildGraph(tree);

      const t1ToTool = edges.find(
        (e) => e.source === "node-t1" && e.target === "node-tool1-call",
      );
      expect(t1ToTool).toBeDefined();
      expect(t1ToTool!.sourceHandle).toBe("right");
    });
  });
});

describe("buildGraph layout: tool nodes positioned to the right of thinking", () => {
  it("tool_call node is positioned to the right of its parent thinking node", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "thinking about tools", true, [
          toolNode("tool1", "Bash", { toolResult: "ok", completed: true }),
        ]),
        textNode("t2", "next thinking"),
      ]),
    ]);
    const { nodes } = buildGraph(tree);

    const thinkingNode = nodes.find((n) => n.id === "node-t1")!;
    const toolCallNode = nodes.find((n) => n.id === "node-tool1-call")!;
    expect(toolCallNode.position.x).toBeGreaterThan(thinkingNode.position.x);
  });

  it("tool_result is to the right of its tool_call (same y)", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "thinking", true, [
          toolNode("tool1", "Bash", { toolResult: "output", completed: true }),
        ]),
      ]),
    ]);
    const { nodes } = buildGraph(tree);

    const toolCallNode = nodes.find((n) => n.id === "node-tool1-call")!;
    const toolResultNode = nodes.find((n) => n.id === "node-tool1-result")!;
    expect(toolResultNode.position.x).toBeGreaterThan(toolCallNode.position.x);
    expect(toolResultNode.position.y).toBe(toolCallNode.position.y);
  });

  it("second thinking node is below first thinking node", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "first", true, [
          toolNode("tool1", "Bash", { toolResult: "ok", completed: true }),
          toolNode("tool2", "Read", { toolResult: "content", completed: true }),
        ]),
        textNode("t2", "second"),
      ]),
    ]);
    const { nodes } = buildGraph(tree);

    const t1 = nodes.find((n) => n.id === "node-t1")!;
    const t2 = nodes.find((n) => n.id === "node-t2")!;
    expect(t2.position.y).toBeGreaterThan(t1.position.y);
  });

  it("multiple tool chains are stacked vertically to the right", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "thinking", true, [
          toolNode("toolA", "Bash", { toolResult: "ok", completed: true }),
          toolNode("toolB", "Read", { toolResult: "content", completed: true }),
        ]),
        textNode("t2", "next"),
      ]),
    ]);
    const { nodes } = buildGraph(tree);

    const t1 = nodes.find((n) => n.id === "node-t1")!;
    const toolA = nodes.find((n) => n.id === "node-toolA-call")!;
    const toolB = nodes.find((n) => n.id === "node-toolB-call")!;

    expect(toolA.position.x).toBeGreaterThan(t1.position.x);
    expect(toolB.position.x).toBeGreaterThan(t1.position.x);
    expect(toolB.position.y).toBeGreaterThan(toolA.position.y);
  });

  it("thinking node dagre height accounts for tool chain height (no overlap)", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "first", true, [
          toolNode("toolA", "Bash", { toolResult: "ok", completed: true }),
          toolNode("toolB", "Read", { toolResult: "content", completed: true }),
          toolNode("toolC", "Glob", { toolResult: "files", completed: true }),
        ]),
        textNode("t2", "second"),
      ]),
    ]);
    const { nodes } = buildGraph(tree);

    const t1 = nodes.find((n) => n.id === "node-t1")!;
    const t2 = nodes.find((n) => n.id === "node-t2")!;

    const minSeparation = 3 * 80 + 2 * 16; // 272
    expect(t2.position.y - t1.position.y).toBeGreaterThanOrEqual(minSeparation);
  });
});

// === 도구 개별 표시 테스트 ===

describe("individual tool nodes", () => {
  it("같은 toolName 5개 → 5개 개별 tool_call 노드", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking", true, [
          toolNode("r1", "Read", { toolResult: "c1", completed: true }),
          toolNode("r2", "Read", { toolResult: "c2", completed: true }),
          toolNode("r3", "Read", { toolResult: "c3", completed: true }),
          toolNode("r4", "Read", { toolResult: "c4", completed: true }),
          toolNode("r5", "Read", { toolResult: "c5", completed: true }),
        ]),
      ]),
    ], "s1");
    const { nodes } = buildGraph(tree);

    expect(nodes.filter((n) => n.type === "tool_call")).toHaveLength(5);
    expect(nodes.filter((n) => n.type === "tool_result")).toHaveLength(5);
  });

  it("다른 toolName 혼합 → 각각 개별 노드", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking", true, [
          toolNode("r1", "Read", { toolResult: "c1", completed: true }),
          toolNode("r2", "Read", { toolResult: "c2", completed: true }),
          toolNode("b1", "Bash", { toolResult: "c3", completed: true }),
          toolNode("b2", "Bash", { toolResult: "c4", completed: true }),
          toolNode("s1", "Skill", { toolResult: "c5", completed: true }),
        ]),
      ]),
    ], "s1");
    const { nodes } = buildGraph(tree);

    expect(nodes.filter((n) => n.type === "tool_call")).toHaveLength(5);
    expect(nodes.filter((n) => n.type === "tool_result")).toHaveLength(5);
  });

  it("Skill 도구는 toolCategory=skill 설정", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking", true, [
          toolNode("s1", "Skill", { toolResult: "c1", completed: true }),
        ]),
      ]),
    ], "s1");
    const { nodes } = buildGraph(tree);

    const skillNode = nodes.find((n) => n.id === "node-s1-call");
    expect(skillNode).toBeDefined();
    expect(skillNode!.data.toolCategory).toBe("skill");
  });

  it("Task 도구는 toolCategory=sub-agent 설정", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking", true, [
          toolNode("a1", "Task", { toolResult: "c1", completed: true }),
        ]),
      ]),
    ], "s1");
    const { nodes } = buildGraph(tree);

    const agentNode = nodes.find((n) => n.id === "node-a1-call");
    expect(agentNode).toBeDefined();
    expect(agentNode!.data.toolCategory).toBe("sub-agent");
  });
});

// === virtual thinking 테스트 ===

describe("virtual thinking node", () => {
  it("첫 text 전에 tool이 있으면 가상 thinking 삽입", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        toolNode("tool1", "Read", { toolResult: "c1", completed: true }),
        toolNode("tool2", "Bash", { toolResult: "c2", completed: true }),
        textNode("t1", "Now thinking"),
      ]),
    ], "s1");
    const { nodes, edges } = buildGraph(tree);

    const virtualNode = nodes.find((n) => n.id === "node-virtual-init");
    expect(virtualNode).toBeDefined();
    expect(virtualNode!.type).toBe("thinking");
    expect(virtualNode!.data.label).toBe("Initial Tools");
  });

  it("첫 카드가 text이면 가상 thinking 없음", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "First thinking", true, [
          toolNode("tool1", "Read", { toolResult: "c1", completed: true }),
        ]),
      ]),
    ], "s1");
    const { nodes } = buildGraph(tree);

    expect(nodes.find((n) => n.id === "node-virtual-init")).toBeUndefined();
  });
});

describe("applyDagreLayout", () => {
  it("positions nodes with non-zero coordinates", () => {
    const nodes: GraphNode[] = [
      {
        id: "n1",
        type: "thinking",
        position: { x: 0, y: 0 },
        data: { nodeType: "thinking", label: "A", content: "", streaming: false },
      },
      {
        id: "n2",
        type: "tool_call",
        position: { x: 0, y: 0 },
        data: { nodeType: "tool_call", label: "B", content: "", streaming: false },
      },
    ];

    const edges = [createEdge("n1", "n2")];
    const result = applyDagreLayout(nodes, edges);

    expect(result.nodes).toHaveLength(2);
    const y1 = result.nodes.find((n) => n.id === "n1")!.position.y;
    const y2 = result.nodes.find((n) => n.id === "n2")!.position.y;
    expect(y1).not.toBe(y2);
    expect(y2).toBeGreaterThan(y1);
  });

  it("returns empty arrays for empty input", () => {
    const result = applyDagreLayout([], []);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

// === calcToolChainBounds 테스트 ===

describe("calcToolChainBounds", () => {
  const TOOL_BRANCH_H_GAP = 120;
  const callWidth = getNodeDimensions("tool_call").width;
  const callHeight = getNodeDimensions("tool_call").height;
  const resultWidth = getNodeDimensions("tool_result").width;
  const resultHeight = getNodeDimensions("tool_result").height;
  const V_GAP = 16;

  it("returns zero for empty chain", () => {
    expect(calcToolChainBounds([])).toEqual({ width: 0, height: 0 });
  });

  it("calculates width and height for call + result", () => {
    const chain: ToolChainEntry[] = [
      { callId: "node-t1-call", resultId: "node-t1-result" },
    ];
    const bounds = calcToolChainBounds(chain);
    expect(bounds.width).toBe(TOOL_BRANCH_H_GAP + callWidth + TOOL_BRANCH_H_GAP + resultWidth);
    expect(bounds.height).toBe(Math.max(callHeight, resultHeight));
  });

  it("calculates width for call-only (no result)", () => {
    const chain: ToolChainEntry[] = [{ callId: "node-t1-call" }];
    const bounds = calcToolChainBounds(chain);
    expect(bounds.width).toBe(TOOL_BRANCH_H_GAP + callWidth);
    expect(bounds.height).toBe(callHeight);
  });

  it("stacks multiple entries vertically with V_GAP", () => {
    const chain: ToolChainEntry[] = [
      { callId: "t1-call", resultId: "t1-result" },
      { callId: "t2-call", resultId: "t2-result" },
      { callId: "t3-call" },
    ];
    const bounds = calcToolChainBounds(chain);

    const row1Height = Math.max(callHeight, resultHeight);
    const row2Height = Math.max(callHeight, resultHeight);
    const row3Height = callHeight;
    const expectedHeight = row1Height + V_GAP + row2Height + V_GAP + row3Height;
    expect(bounds.height).toBe(expectedHeight);
  });

  it("handles single tool_call without result", () => {
    const chain: ToolChainEntry[] = [
      { callId: "node-t1" },
    ];
    const bounds = calcToolChainBounds(chain);
    expect(bounds.width).toBe(TOOL_BRANCH_H_GAP + callWidth);
    expect(bounds.height).toBe(callHeight);
  });
});

// === 대규모 세션 레이아웃 검증 ===

describe("large session layout", () => {
  function generateLargeSession(pairCount: number): EventTreeNode {
    const children: EventTreeNode[] = [];
    for (let i = 0; i < pairCount; i++) {
      const toolName = i % 3 === 0 ? "Bash" : i % 3 === 1 ? "Read" : "Glob";
      children.push(
        textNode(`t${i}`, `Thinking step ${i}`, true, [
          toolNode(`tool${i}`, toolName, {
            toolResult: `result ${i}`,
            completed: true,
          }),
        ]),
      );
    }
    children.push(textNode("t-final", "Final response"));
    children.push(completeNode("c-final"));

    return sessionRoot([
      userMsg("u1", "start", children),
    ], `large-${pairCount}`);
  }

  it("25+ 노드 세션: 모든 노드가 양수 좌표", () => {
    const tree = generateLargeSession(10);
    const { nodes } = buildGraph(tree);

    expect(nodes.length).toBeGreaterThanOrEqual(25);
    for (const node of nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("50+ 노드 세션: 모든 노드가 양수 좌표", () => {
    const tree = generateLargeSession(20);
    const { nodes } = buildGraph(tree);

    expect(nodes.length).toBeGreaterThanOrEqual(45);
    for (const node of nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("50+ 노드 세션: 메인 플로우 노드 겹침 없음", () => {
    const tree = generateLargeSession(20);
    const { nodes } = buildGraph(tree);

    const mainFlowX = nodes.find((n) => n.data.nodeType === "thinking")?.position.x;
    if (mainFlowX === undefined) return;

    const mainFlowNodes = nodes.filter((n) => n.position.x === mainFlowX);
    const sorted = [...mainFlowNodes].sort((a, b) => a.position.y - b.position.y);

    for (let i = 1; i < sorted.length; i++) {
      const prevDims = getNodeDimensions(sorted[i - 1].data.nodeType);
      const gap = sorted[i].position.y - sorted[i - 1].position.y;
      expect(gap).toBeGreaterThanOrEqual(prevDims.height);
    }
  });

  it("100+ 노드 세션: 성능 및 좌표 안정성", () => {
    const tree = generateLargeSession(50);

    const start = performance.now();
    const { nodes } = buildGraph(tree);
    const elapsed = performance.now() - start;

    expect(nodes.length).toBeGreaterThanOrEqual(100);

    for (const node of nodes) {
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
    }

    expect(elapsed).toBeLessThan(500);
  });
});

// === Phase 4: 접기(collapse) 기능 및 Subagent 노드 테스트 ===

describe("countAllDescendants", () => {
  it("returns 0 for node with no children", () => {
    const node = textNode("t1", "no children");
    expect(countAllDescendants(node)).toBe(0);
  });

  it("counts direct children", () => {
    const node = textNode("t1", "parent", true, [
      toolNode("tool1", "Bash"),
      toolNode("tool2", "Read"),
    ]);
    expect(countAllDescendants(node)).toBe(2);
  });

  it("counts nested descendants recursively", () => {
    const node = textNode("t1", "parent", true, [
      toolNode("tool1", "Bash", { completed: true }),
      textNode("t2", "child", true, [
        toolNode("tool2", "Read"),
        toolNode("tool3", "Glob"),
      ]),
    ]);
    // 2 direct children + 2 grandchildren = 4
    expect(countAllDescendants(node)).toBe(4);
  });
});

describe("buildGraph with collapsedNodeIds", () => {
  it("접힌 노드의 자식은 렌더링되지 않음", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking", true, [
          toolNode("tool1", "Bash", { toolResult: "ok", completed: true }),
          toolNode("tool2", "Read", { toolResult: "content", completed: true }),
        ]),
      ]),
    ]);

    const collapsedIds = new Set(["t1"]);
    const { nodes } = buildGraph(tree, collapsedIds);

    // t1 노드는 있어야 함
    const thinkingNode = nodes.find((n) => n.data.cardId === "t1");
    expect(thinkingNode).toBeDefined();

    // 자식 tool 노드는 없어야 함
    expect(nodes.find((n) => n.data.cardId === "tool1")).toBeUndefined();
    expect(nodes.find((n) => n.data.cardId === "tool2")).toBeUndefined();
  });

  it("접힌 노드는 collapsed=true, hasChildren=true, childCount 설정됨", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking", true, [
          toolNode("tool1", "Bash", { toolResult: "ok", completed: true }),
          toolNode("tool2", "Read", { toolResult: "content", completed: true }),
        ]),
      ]),
    ]);

    const collapsedIds = new Set(["t1"]);
    const { nodes } = buildGraph(tree, collapsedIds);

    const thinkingNode = nodes.find((n) => n.data.cardId === "t1");
    expect(thinkingNode?.data.collapsed).toBe(true);
    expect(thinkingNode?.data.hasChildren).toBe(true);
    expect(thinkingNode?.data.childCount).toBe(2);
  });

  it("펼쳐진 노드는 hasChildren=true, collapsed=false", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking", true, [
          toolNode("tool1", "Bash", { toolResult: "ok", completed: true }),
        ]),
      ]),
    ]);

    // 빈 Set = 모두 펼쳐진 상태
    const { nodes } = buildGraph(tree, new Set());

    const thinkingNode = nodes.find((n) => n.data.cardId === "t1");
    expect(thinkingNode?.data.collapsed).toBe(false);
    expect(thinkingNode?.data.hasChildren).toBe(true);
    expect(thinkingNode?.data.childCount).toBe(1);
  });

  it("자식이 없는 노드는 hasChildren=false", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking with no tools"),
      ]),
    ]);

    const { nodes } = buildGraph(tree);

    const thinkingNode = nodes.find((n) => n.data.cardId === "t1");
    expect(thinkingNode?.data.hasChildren).toBe(false);
    expect(thinkingNode?.data.childCount).toBe(0);
  });

  it("collapsedNodeIds가 undefined이면 기본 동작 (모두 펼침)", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking", true, [
          toolNode("tool1", "Bash", { toolResult: "ok", completed: true }),
        ]),
      ]),
    ]);

    // collapsedNodeIds 파라미터 생략
    const { nodes } = buildGraph(tree);

    const thinkingNode = nodes.find((n) => n.data.cardId === "t1");
    expect(thinkingNode?.data.collapsed).toBe(false);

    // 자식 tool 노드도 있어야 함
    const toolNode1 = nodes.find((n) => n.data.cardId === "tool1");
    expect(toolNode1).toBeDefined();
  });

  it("중첩된 접기: 부모가 접히면 모든 하위 자손이 숨겨짐", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Parent", true, [
          textNode("t2", "Child", true, [
            toolNode("tool1", "Bash", { toolResult: "ok", completed: true }),
          ]),
        ]),
      ]),
    ]);

    const collapsedIds = new Set(["t1"]);
    const { nodes } = buildGraph(tree, collapsedIds);

    // t1만 있고 t2, tool1은 없어야 함
    expect(nodes.find((n) => n.data.cardId === "t1")).toBeDefined();
    expect(nodes.find((n) => n.data.cardId === "t2")).toBeUndefined();
    expect(nodes.find((n) => n.data.cardId === "tool1")).toBeUndefined();

    // childCount는 모든 자손 수
    const t1Node = nodes.find((n) => n.data.cardId === "t1");
    expect(t1Node?.data.childCount).toBe(2); // t2 + tool1
  });
});

describe("Subagent 노드", () => {
  it("subagent 노드가 올바르게 생성됨", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking", true, [
          toolNode("task1", "Task", {
            toolResult: "done",
            completed: true,
            toolUseId: "toolu_task_1",
          }),
        ]),
      ]),
    ]);

    // task1의 자식으로 subagent 추가
    const taskNode = tree.children[0].children[0].children[0];
    taskNode.children = [
      subagentNode("explore_1", "Explore", [
        textNode("sub-t1", "Subagent thinking", true, [
          toolNode("sub-tool1", "Read", { toolResult: "file content", completed: true }),
        ]),
      ], { parentToolUseId: "toolu_task_1", completed: true }),
    ];

    const { nodes } = buildGraph(tree);

    const subagentGraphNode = nodes.find((n) => n.data.nodeType === "subagent");
    expect(subagentGraphNode).toBeDefined();
    expect(subagentGraphNode?.data.agentType).toBe("Explore");
    expect(subagentGraphNode?.data.agentId).toBe("explore_1");
  });

  it("접힌 subagent의 자식은 렌더링되지 않음", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking", true, [
          toolNode("task1", "Task", {
            completed: true,
            toolUseId: "toolu_task_1",
          }),
        ]),
      ]),
    ]);

    const taskNode = tree.children[0].children[0].children[0];
    taskNode.children = [
      subagentNode("explore_1", "Explore", [
        textNode("sub-t1", "Subagent thinking"),
        toolNode("sub-tool1", "Read", { toolResult: "content", completed: true }),
      ], { parentToolUseId: "toolu_task_1", completed: true }),
    ];

    const collapsedIds = new Set(["explore_1"]);
    const { nodes } = buildGraph(tree, collapsedIds);

    // subagent 노드는 있어야 함
    const subagentGraphNode = nodes.find((n) => n.data.nodeType === "subagent");
    expect(subagentGraphNode).toBeDefined();
    expect(subagentGraphNode?.data.collapsed).toBe(true);

    // subagent 내부 노드는 없어야 함
    expect(nodes.find((n) => n.data.cardId === "sub-t1")).toBeUndefined();
    expect(nodes.find((n) => n.data.cardId === "sub-tool1")).toBeUndefined();
  });
});

describe("Result 노드", () => {
  it("result 노드가 올바르게 생성됨", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi", [
        textNode("t1", "Thinking"),
      ]),
      resultNode("result-1", {
        durationMs: 5000,
        usage: { input_tokens: 1000, output_tokens: 500 },
        totalCostUsd: 0.01,
      }),
    ]);

    const { nodes } = buildGraph(tree);

    const resultGraphNode = nodes.find((n) => n.data.nodeType === "result");
    expect(resultGraphNode).toBeDefined();
    expect(resultGraphNode?.data.label).toBe("Session Complete");
    expect(resultGraphNode?.data.durationMs).toBe(5000);
    expect(resultGraphNode?.data.totalCostUsd).toBe(0.01);
  });

  it("result 노드 content에 시간과 비용 포함", () => {
    const tree = sessionRoot([
      resultNode("result-1", {
        durationMs: 12345,
        totalCostUsd: 0.0234,
      }),
    ]);

    const { nodes } = buildGraph(tree);

    const resultGraphNode = nodes.find((n) => n.data.nodeType === "result");
    expect(resultGraphNode?.data.content).toContain("12.3s");
    expect(resultGraphNode?.data.content).toContain("$0.0234");
  });
});

describe("Intervention 노드 - 기존 호환", () => {
  it("intervention 노드가 nodeType=intervention으로 설정됨", () => {
    const tree = sessionRoot([
      userMsg("u1", "hi"),
      interventionNode("i1", "Please stop"),
    ]);

    const { nodes } = buildGraph(tree);

    const interventionGraphNode = nodes.find((n) => n.data.nodeType === "intervention");
    expect(interventionGraphNode).toBeDefined();
    expect(interventionGraphNode?.data.content).toContain("stop");
  });
});
