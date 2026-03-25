/**
 * Renderer 단위 테스트
 *
 * 각 렌더러 함수가 LayoutContext를 통해 올바르게 노드/엣지를 생성하는지 검증합니다.
 * LayoutContext를 직접 생성하여 전달하므로 독립 단위 테스트가 가능합니다.
 */

import { describe, it, expect } from "vitest";
import type { EventTreeNode, ToolNode, ResultNode, InputRequestNodeDef } from "../../shared/types";
import { createLayoutContext, type LayoutContext } from "../layout-context";

/** toolTreeNode 팩토리 옵션 */
interface ToolNodeOpts {
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  isError?: boolean;
  completed?: boolean;
  toolUseId?: string;
  children?: EventTreeNode[];
}

/** resultTreeNode 팩토리 옵션 */
interface ResultNodeOpts {
  content?: string;
  durationMs?: number;
  usage?: { input_tokens: number; output_tokens: number };
  totalCostUsd?: number;
}
import {
  dispatchRenderer,
  getRegisteredTypes,
  renderUserMessageTurn,
  renderInterventionTurn,
  renderTextNode,
  renderToolNode,
  renderCompletionNode,
  renderCompactNode,
  renderResultNode,
  renderInputRequestNode,
  processChildNodes,
} from "./index";

// === Helper: 트리 노드 팩토리 ===

function makeCtx(overrides?: Partial<LayoutContext>): LayoutContext {
  const base = createLayoutContext(
    { nodeIds: new Set(), entryIds: new Set(), exitIds: new Set() },
    new Set(),
  );
  return { ...base, ...overrides };
}

function textTreeNode(id: string, content: string, completed = true, children: EventTreeNode[] = []): EventTreeNode {
  return { id, type: "text", children, content, completed };
}

function toolTreeNode(
  id: string,
  toolName: string,
  opts: ToolNodeOpts = {},
): EventTreeNode {
  return {
    id,
    type: "tool",
    children: opts.children ?? [],
    content: "",
    toolName,
    toolInput: opts.toolInput ?? { command: "test" },
    toolResult: opts.toolResult,
    isError: opts.isError,
    completed: opts.completed ?? true,
    toolUseId: opts.toolUseId,
  } as ToolNode;
}

function userMsgNode(id: string, text: string, children: EventTreeNode[] = []): EventTreeNode {
  return { id, type: "user_message", children, content: text, completed: true, user: "user" };
}

function interventionTreeNode(id: string, text: string, children: EventTreeNode[] = []): EventTreeNode {
  return { id, type: "intervention", children, content: text, completed: true, user: "admin" };
}

function compactTreeNode(id: string, content = "Context compaction occurred"): EventTreeNode {
  return { id, type: "compact", children: [], content, completed: true };
}

function completeTreeNode(id: string, content = "done"): EventTreeNode {
  return { id, type: "complete", children: [], content, completed: true };
}

function errorTreeNode(id: string, message: string): EventTreeNode {
  return { id, type: "error", children: [], content: message, completed: true, isError: true };
}

function resultTreeNode(id: string, opts: ResultNodeOpts = {}): EventTreeNode {
  return {
    id,
    type: "result",
    children: [],
    content: opts.content ?? "Session completed",
    completed: true,
    durationMs: opts.durationMs,
    usage: opts.usage,
    totalCostUsd: opts.totalCostUsd,
  } as ResultNode;
}

// === Tests ===

describe("renderer registry", () => {
  it("has renderers for all expected EventTreeNodeTypes", () => {
    const types = getRegisteredTypes();
    expect(types).toContain("user_message");
    expect(types).toContain("intervention");
    expect(types).toContain("thinking");
    expect(types).toContain("text");
    expect(types).toContain("tool");
    expect(types).toContain("compact");
    expect(types).toContain("complete");
    expect(types).toContain("error");
    expect(types).toContain("result");
    expect(types).toContain("input_request");
  });

  it("dispatches to the correct renderer via dispatchRenderer", () => {
    const ctx = makeCtx();
    const node = textTreeNode("t1", "hello");
    const result = dispatchRenderer(node, null, ctx);
    expect(ctx.nodes.length).toBeGreaterThan(0);
    expect(ctx.nodes[0].data.nodeType).toBe("text");
    expect(result).toBe(ctx.nodes[0].id);
  });

  it("silently ignores unknown node types", () => {
    const ctx = makeCtx();
    const unknownNode: EventTreeNode = {
      id: "unk",
      type: "session" as any, // session type not in registry
      children: [],
      content: "",
      completed: true,
    };
    dispatchRenderer(unknownNode, null, ctx);
    expect(ctx.nodes).toHaveLength(0);
    expect(ctx.edges).toHaveLength(0);
  });
});

describe("renderUserMessageTurn", () => {
  it("creates a user node and returns its id", () => {
    const ctx = makeCtx();
    const node = userMsgNode("u1", "Hello world");
    const result = renderUserMessageTurn(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("user");
    expect(ctx.nodes[0].data.content).toContain("Hello world");
    expect(result).toBe(ctx.nodes[0].id);
  });

  it("returns null if content is empty", () => {
    const ctx = makeCtx();
    const node = userMsgNode("u1", "");
    const result = renderUserMessageTurn(node, null, ctx);

    expect(ctx.nodes).toHaveLength(0);
    expect(result).toBeNull();
  });

  it("processes child text nodes", () => {
    const ctx = makeCtx();
    const node = userMsgNode("u1", "Hi", [textTreeNode("t1", "thinking...")]);
    renderUserMessageTurn(node, null, ctx);

    // user node + text node
    expect(ctx.nodes.length).toBe(2);
    expect(ctx.nodes[0].data.nodeType).toBe("user");
    expect(ctx.nodes[1].data.nodeType).toBe("text");
    // processChildNodes creates edge: user → text
    const edge = ctx.edges.find(e => e.target === ctx.nodes[1].id);
    expect(edge?.source).toBe(ctx.nodes[0].id);
  });
});

describe("renderInterventionTurn", () => {
  it("creates an intervention node and returns its id", () => {
    const ctx = makeCtx();
    const node = interventionTreeNode("intv1", "Stop!");
    const result = renderInterventionTurn(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("intervention");
    expect(ctx.nodes[0].data.content).toContain("Stop!");
    expect(result).toBe(ctx.nodes[0].id);
  });

  it("skips children when node is collapsed", () => {
    const collapsed = new Set(["intv1"]);
    const ctx = makeCtx({ collapsedNodeIds: collapsed });
    const node = interventionTreeNode("intv1", "Stop!", [textTreeNode("t1", "child")]);
    const result = renderInterventionTurn(node, null, ctx);

    // Only intervention node, no child
    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("intervention");
    expect(ctx.nodes[0].data.collapsed).toBe(true);
    expect(result).toBe(ctx.nodes[0].id);
  });
});

describe("renderTextNode", () => {
  it("creates a text node and returns its id", () => {
    const ctx = makeCtx();
    const node = textTreeNode("t1", "I'm thinking...");
    const result = renderTextNode(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("text");
    expect(result).toBe(ctx.nodes[0].id);
  });

  it("does not create edges (processChildNodes handles that)", () => {
    const ctx = makeCtx();
    const node = textTreeNode("t1", "streaming...", false);
    renderTextNode(node, null, ctx);

    // text renderer no longer creates edges
    expect(ctx.edges.length).toBe(0);
  });

  it("processes child tool nodes via processChildNodes", () => {
    const ctx = makeCtx();
    const tool = toolTreeNode("tool1", "Bash", { toolResult: "ok" });
    const node = textTreeNode("t1", "thinking", true, [tool]);
    renderTextNode(node, null, ctx);

    // text node + tool_call
    expect(ctx.nodes.length).toBe(2);
    expect(ctx.nodes[0].data.nodeType).toBe("text");
    expect(ctx.nodes[1].data.nodeType).toBe("tool_call");
    // tool creates horizontal edge from text to tool
    const toolEdge = ctx.edges.find(e => e.target === ctx.nodes[1].id);
    expect(toolEdge?.sourceHandle).toBe("right");
    expect(toolEdge?.targetHandle).toBe("left");
  });

  it("skips children when collapsed but still returns id", () => {
    const collapsed = new Set(["t1"]);
    const ctx = makeCtx({ collapsedNodeIds: collapsed });
    const tool = toolTreeNode("tool1", "Bash", { toolResult: "ok" });
    const node = textTreeNode("t1", "thinking", true, [tool]);
    const result = renderTextNode(node, null, ctx);

    // Only text node
    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.collapsed).toBe(true);
    expect(result).toBe(ctx.nodes[0].id);
  });

  it("sets isPlanMode when node is in plan mode range", () => {
    const ctx = makeCtx({
      planMode: {
        nodeIds: new Set(["t1"]),
        entryIds: new Set(),
        exitIds: new Set(),
      },
    });
    const node = textTreeNode("t1", "planning...");
    renderTextNode(node, null, ctx);

    expect(ctx.nodes[0].data.isPlanMode).toBe(true);
  });
});

describe("renderToolNode", () => {
  it("creates tool_call node (edge handled by child-processor)", () => {
    const ctx = makeCtx();
    const node = toolTreeNode("tool1", "Read", { toolResult: "file content" });
    renderToolNode(node, "parent-id", ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("tool_call");
    // Edge is created by child-processor, not by renderToolNode
    expect(ctx.edges.length).toBe(0);
  });

  it("streaming tool creates only tool_call node (no edges)", () => {
    const ctx = makeCtx();
    const node = toolTreeNode("tool1", "Bash", { completed: false });
    renderToolNode(node, "parent", ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("tool_call");
    // Edge is created by child-processor, not by renderToolNode
    expect(ctx.edges.length).toBe(0);
  });

  it("streaming tool creates only tool_call node", () => {
    const ctx = makeCtx();
    const node = toolTreeNode("tool1", "Bash", { completed: false, toolResult: undefined });
    renderToolNode(node, "parent", ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("tool_call");
  });

  it("sets plan mode flags correctly", () => {
    const ctx = makeCtx({
      planMode: {
        nodeIds: new Set(["t1"]),
        entryIds: new Set(["t1"]),
        exitIds: new Set(),
      },
    });
    const node = toolTreeNode("t1", "EnterPlanMode");
    renderToolNode(node, "parent", ctx);

    expect(ctx.nodes[0].data.isPlanMode).toBe(true);
    expect(ctx.nodes[0].data.isPlanModeEntry).toBe(true);
    expect(ctx.nodes[0].data.isPlanModeExit).toBe(false);
  });

  it("silently ignores unknown child node types (no renderer registered)", () => {
    const ctx = makeCtx();
    const child: EventTreeNode = {
      id: "unknown1",
      type: "session" as any, // session type not in renderer registry
      children: [],
      content: "",
      completed: false,
    };
    const node = toolTreeNode("tool1", "Task", {
      toolResult: "done",
      children: [child],
    });
    renderToolNode(node, "parent", ctx);

    // tool_call only (unknown child silently skipped)
    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("tool_call");
  });
});

describe("renderCompactNode", () => {
  it("creates a system node for compact type and returns its id", () => {
    const ctx = makeCtx();
    const node: EventTreeNode = {
      id: "compact1",
      type: "compact",
      children: [],
      content: "Context compaction occurred",
      completed: true,
    };
    const result = renderCompactNode(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("system");
    expect(ctx.nodes[0].data.label).toBe("⚡ Context Compaction");
    // No edges created by renderer (processChildNodes handles that)
    expect(ctx.edges.length).toBe(0);
    expect(result).toBe(ctx.nodes[0].id);
  });
});

describe("renderCompletionNode", () => {
  it("creates a system node for complete type and returns its id", () => {
    const ctx = makeCtx();
    const node = completeTreeNode("c1", "All done");
    const result = renderCompletionNode(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("system");
    expect(ctx.nodes[0].data.label).toBe("Complete");
    expect(result).toBe(ctx.nodes[0].id);
  });

  it("creates a system node for error type", () => {
    const ctx = makeCtx();
    const node = errorTreeNode("e1", "Something broke");
    const result = renderCompletionNode(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.label).toBe("Error");
    expect(ctx.nodes[0].data.isError).toBe(true);
    expect(result).toBe(ctx.nodes[0].id);
  });
});

describe("renderResultNode", () => {
  it("creates a result node with duration and cost", () => {
    const ctx = makeCtx();
    const node = resultTreeNode("r1", {
      durationMs: 5000,
      totalCostUsd: 0.0123,
    });
    const result = renderResultNode(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("result");
    expect(ctx.nodes[0].data.content).toContain("5.0s");
    expect(ctx.nodes[0].data.content).toContain("$0.0123");
    expect(result).toBe(ctx.nodes[0].id);
  });
});

describe("processChildNodes", () => {
  it("creates horizontal edges: parent→all children (right→left)", () => {
    const ctx = makeCtx();
    const parent = userMsgNode("u1", "Hi", [
      textTreeNode("t1", "I'm thinking"),
      textTreeNode("t2", "More thoughts"),
    ]);
    processChildNodes(parent, "user-1", ctx);

    // 2 text nodes
    expect(ctx.nodes.length).toBe(2);
    // All children connect horizontally to parent (right→left)
    expect(ctx.edges.length).toBe(2);
    expect(ctx.edges[0].source).toBe("user-1");
    expect(ctx.edges[0].target).toBe(ctx.nodes[0].id);
    expect(ctx.edges[0].sourceHandle).toBe("right");
    expect(ctx.edges[0].targetHandle).toBe("left");
    expect(ctx.edges[1].source).toBe("user-1");
    expect(ctx.edges[1].target).toBe(ctx.nodes[1].id);
    expect(ctx.edges[1].sourceHandle).toBe("right");
    expect(ctx.edges[1].targetHandle).toBe("left");
  });

  it("all children get horizontal edges uniformly (no type distinction)", () => {
    const ctx = makeCtx();
    const parent = userMsgNode("u1", "Hi", [
      textTreeNode("t1", "I'm thinking"),
      toolTreeNode("tool1", "Bash", { toolResult: "ok" }),
    ]);
    processChildNodes(parent, "user-1", ctx);

    // text node + tool_call
    expect(ctx.nodes[0].data.nodeType).toBe("text");
    expect(ctx.nodes[1].data.nodeType).toBe("tool_call");
    // Both connect horizontally to parent
    expect(ctx.edges.length).toBe(2);
    expect(ctx.edges[0].source).toBe("user-1");
    expect(ctx.edges[0].sourceHandle).toBe("right");
    expect(ctx.edges[1].source).toBe("user-1");
    expect(ctx.edges[1].sourceHandle).toBe("right");
  });

  it("tool and thinking are siblings under same parent with horizontal edges", () => {
    const ctx = makeCtx();
    const thinkingChild: EventTreeNode = {
      id: "th1",
      type: "thinking",
      children: [],
      content: "thinking...",
      completed: true,
    };
    const parent = userMsgNode("u1", "Hi", [
      thinkingChild,
      toolTreeNode("tool1", "Bash", { toolResult: "ok" }),
    ]);
    processChildNodes(parent, "user-1", ctx);

    // thinking + tool_call
    expect(ctx.nodes.length).toBe(2);
    const thinkingGraphNode = ctx.nodes[0];
    const toolGraphNode = ctx.nodes[1];

    // Both connect horizontally to parent
    const thinkingEdge = ctx.edges.find(e => e.target === thinkingGraphNode.id);
    expect(thinkingEdge?.source).toBe("user-1");
    expect(thinkingEdge?.sourceHandle).toBe("right");

    const toolEdge = ctx.edges.find(e => e.target === toolGraphNode.id);
    expect(toolEdge?.source).toBe("user-1");
    expect(toolEdge?.sourceHandle).toBe("right");
  });

  it("handles complete/error children with horizontal edges", () => {
    const ctx = makeCtx();
    const parent = userMsgNode("u1", "Hi", [
      textTreeNode("t1", "thinking"),
      completeTreeNode("c1"),
    ]);
    processChildNodes(parent, "parent-node-id", ctx);

    expect(ctx.nodes.length).toBe(2);
    expect(ctx.nodes[1].data.nodeType).toBe("system");
    // Both children connect horizontally to parent
    expect(ctx.edges.length).toBe(2);
    expect(ctx.edges[0].source).toBe("parent-node-id");
    expect(ctx.edges[0].sourceHandle).toBe("right");
    expect(ctx.edges[1].source).toBe("parent-node-id");
    expect(ctx.edges[1].sourceHandle).toBe("right");
  });

  it("all children connect horizontally: text, compact, complete", () => {
    const ctx = makeCtx();
    const parent = userMsgNode("u1", "Hi", [
      textTreeNode("t1", "thinking"),
      compactTreeNode("cpt1"),
      completeTreeNode("c1"),
    ]);
    processChildNodes(parent, "parent-node-id", ctx);

    // text + compact + complete = 3 nodes
    expect(ctx.nodes.length).toBe(3);
    expect(ctx.nodes[1].data.nodeType).toBe("system");
    expect(ctx.nodes[1].data.label).toBe("⚡ Context Compaction");
    // All children connect horizontally to parent
    expect(ctx.edges.length).toBe(3);
    expect(ctx.edges[0].source).toBe("parent-node-id");
    expect(ctx.edges[0].target).toBe(ctx.nodes[0].id);
    expect(ctx.edges[0].sourceHandle).toBe("right");
    expect(ctx.edges[1].source).toBe("parent-node-id");
    expect(ctx.edges[1].target).toBe(ctx.nodes[1].id);
    expect(ctx.edges[1].sourceHandle).toBe("right");
    expect(ctx.edges[2].source).toBe("parent-node-id");
    expect(ctx.edges[2].target).toBe(ctx.nodes[2].id);
    expect(ctx.edges[2].sourceHandle).toBe("right");
  });

  it("no edge when parentGraphNodeId is null", () => {
    const ctx = makeCtx();
    const parent = userMsgNode("u1", "", [
      textTreeNode("t1", "orphan thinking"),
    ]);
    processChildNodes(parent, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    // No edges (no parent to connect to)
    expect(ctx.edges.length).toBe(0);
  });
});

function inputRequestTreeNode(
  id: string,
  question: string,
  responded = false,
): EventTreeNode {
  return {
    id,
    type: "input_request",
    children: [],
    content: question,
    completed: responded,
    requestId: "req-001",
    questions: [{ question, options: [{ label: "A" }, { label: "B" }] }],
    responded,
  } as InputRequestNodeDef;
}

describe("renderInputRequestNode", () => {
  it("creates an input_request node and returns its id", () => {
    const ctx = makeCtx();
    const node = inputRequestTreeNode("ir1", "Which option?");
    const result = renderInputRequestNode(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("input_request");
    expect(ctx.nodes[0].data.content).toContain("Which option?");
    expect(ctx.nodes[0].data.responded).toBe(false);
    // No edges created by renderer (processChildNodes handles that)
    expect(ctx.edges.length).toBe(0);
    expect(result).toBe(ctx.nodes[0].id);
  });

  it("reflects responded=true in graph node data", () => {
    const ctx = makeCtx();
    const node = inputRequestTreeNode("ir3", "Answered question", true);
    const result = renderInputRequestNode(node, null, ctx);

    expect(ctx.nodes[0].data.responded).toBe(true);
    expect(ctx.nodes[0].data.streaming).toBe(false); // completed = true
    expect(result).toBe(ctx.nodes[0].id);
  });
});

describe("Tree-based edge generation", () => {
  it("processChildNodes connects all siblings with horizontal edges", () => {
    const ctx = makeCtx();
    const parent = userMsgNode("u1", "Go", [
      textTreeNode("t1", "first"),
      textTreeNode("t2", "second"),
    ]);
    processChildNodes(parent, "user-node", ctx);

    // All children connect horizontally to parent (right→left)
    expect(ctx.edges.length).toBe(2);
    expect(ctx.edges[0].source).toBe("user-node");
    expect(ctx.edges[0].target).toBe("node-t1");
    expect(ctx.edges[0].sourceHandle).toBe("right");
    expect(ctx.edges[0].targetHandle).toBe("left");
    expect(ctx.edges[1].source).toBe("user-node");
    expect(ctx.edges[1].target).toBe("node-t2");
    expect(ctx.edges[1].sourceHandle).toBe("right");
    expect(ctx.edges[1].targetHandle).toBe("left");
  });

  it("tool edge is created by processChildNodes (not renderToolNode)", () => {
    const ctx = makeCtx();
    // renderToolNode alone does not create edges
    renderToolNode(toolTreeNode("tool1", "Bash", { toolResult: "ok" }), "user-node-id", ctx);
    expect(ctx.edges.length).toBe(0);

    // When called via processChildNodes, edge is created
    const ctx2 = makeCtx();
    const parent = userMsgNode("u1", "Go", [
      toolTreeNode("tool1", "Bash", { toolResult: "ok" }),
    ]);
    processChildNodes(parent, "user-node-id", ctx2);
    const toolEdge = ctx2.edges.find(e => e.target === "node-tool1-call");
    expect(toolEdge?.source).toBe("user-node-id");
    expect(toolEdge?.sourceHandle).toBe("right");
    expect(toolEdge?.targetHandle).toBe("left");
  });

  it("renderers return graph node IDs for processChildNodes to use", () => {
    const ctx = makeCtx();
    const textId = renderTextNode(textTreeNode("t1", "hello"), null, ctx);
    const completeId = renderCompletionNode(completeTreeNode("c1"), null, ctx);
    const toolId = renderToolNode(toolTreeNode("tool1", "Bash"), "parent", ctx);

    expect(textId).toBe("node-t1");
    expect(completeId).toBe("node-c1");
    expect(toolId).toBe("node-tool1-call");
  });
});
