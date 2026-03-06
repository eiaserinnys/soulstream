/**
 * Renderer 단위 테스트
 *
 * 각 렌더러 함수가 LayoutContext를 통해 올바르게 노드/엣지를 생성하는지 검증합니다.
 * LayoutContext를 직접 생성하여 전달하므로 독립 단위 테스트가 가능합니다.
 */

import { describe, it, expect } from "vitest";
import type { EventTreeNode } from "@shared/types";
import { createLayoutContext, type LayoutContext } from "../layout-context";
import {
  dispatchRenderer,
  getRegisteredTypes,
  renderUserMessageTurn,
  renderInterventionTurn,
  renderTextNode,
  renderToolNode,
  renderSubagentNode,
  renderCompletionNode,
  renderResultNode,
  processChildNodes,
} from "./index";

// === Helper: 트리 노드 팩토리 ===

function makeCtx(overrides?: Partial<LayoutContext>): LayoutContext {
  const ctx = createLayoutContext(
    { nodeIds: new Set(), entryIds: new Set(), exitIds: new Set() },
    new Set(),
  );
  if (overrides) Object.assign(ctx, overrides);
  return ctx;
}

function textTreeNode(id: string, content: string, completed = true, children: EventTreeNode[] = []): EventTreeNode {
  return { id, type: "text", children, content, completed };
}

function toolTreeNode(
  id: string,
  toolName: string,
  opts: Partial<EventTreeNode> = {},
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
  };
}

function userMsgNode(id: string, text: string, children: EventTreeNode[] = []): EventTreeNode {
  return { id, type: "user_message", children, content: text, completed: true, user: "user" };
}

function interventionTreeNode(id: string, text: string, children: EventTreeNode[] = []): EventTreeNode {
  return { id, type: "intervention", children, content: text, completed: true, user: "admin" };
}

function completeTreeNode(id: string, content = "done"): EventTreeNode {
  return { id, type: "complete", children: [], content, completed: true };
}

function errorTreeNode(id: string, message: string): EventTreeNode {
  return { id, type: "error", children: [], content: message, completed: true, isError: true };
}

function resultTreeNode(id: string, opts: Partial<EventTreeNode> = {}): EventTreeNode {
  return {
    id,
    type: "result",
    children: [],
    content: opts.content ?? "Session completed",
    completed: true,
    durationMs: opts.durationMs,
    usage: opts.usage,
    totalCostUsd: opts.totalCostUsd,
  };
}

function subagentTreeNode(
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
  };
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
    expect(types).toContain("subagent");
    expect(types).toContain("complete");
    expect(types).toContain("error");
    expect(types).toContain("result");
  });

  it("dispatches to the correct renderer via dispatchRenderer", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "prev" });
    const node = textTreeNode("t1", "hello");
    dispatchRenderer(node, null, ctx);
    expect(ctx.nodes.length).toBeGreaterThan(0);
    expect(ctx.nodes[0].data.nodeType).toBe("thinking");
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
  it("creates a user node and connects to prevMainFlowNodeId", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "session-node" });
    const node = userMsgNode("u1", "Hello world");
    renderUserMessageTurn(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("user");
    expect(ctx.nodes[0].data.content).toContain("Hello world");
    expect(ctx.edges.length).toBe(1);
    expect(ctx.edges[0].source).toBe("session-node");
    expect(ctx.edges[0].target).toBe(ctx.nodes[0].id);
    expect(ctx.prevMainFlowNodeId).toBe(ctx.nodes[0].id);
  });

  it("skips user node creation if content is empty", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "session-node" });
    const node = userMsgNode("u1", "");
    renderUserMessageTurn(node, null, ctx);

    expect(ctx.nodes).toHaveLength(0);
  });

  it("processes child text nodes", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "session-node" });
    const node = userMsgNode("u1", "Hi", [textTreeNode("t1", "thinking...")]);
    renderUserMessageTurn(node, null, ctx);

    // user node + text node
    expect(ctx.nodes.length).toBe(2);
    expect(ctx.nodes[0].data.nodeType).toBe("user");
    expect(ctx.nodes[1].data.nodeType).toBe("thinking");
  });
});

describe("renderInterventionTurn", () => {
  it("creates an intervention node with collapse info", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "prev" });
    const node = interventionTreeNode("intv1", "Stop!");
    renderInterventionTurn(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("intervention");
    expect(ctx.nodes[0].data.content).toContain("Stop!");
    expect(ctx.prevMainFlowNodeId).toBe(ctx.nodes[0].id);
  });

  it("skips children when node is collapsed", () => {
    const collapsed = new Set(["intv1"]);
    const ctx = makeCtx({
      prevMainFlowNodeId: "prev",
      collapsedNodeIds: collapsed,
    });
    const node = interventionTreeNode("intv1", "Stop!", [textTreeNode("t1", "child")]);
    renderInterventionTurn(node, null, ctx);

    // Only intervention node, no child
    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("intervention");
    expect(ctx.nodes[0].data.collapsed).toBe(true);
  });
});

describe("renderTextNode", () => {
  it("creates a thinking node and updates prevMainFlowNodeId", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "prev" });
    const node = textTreeNode("t1", "I'm thinking...");
    renderTextNode(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("thinking");
    expect(ctx.prevMainFlowNodeId).toBe(ctx.nodes[0].id);
    expect(ctx.lastThinkingNodeId).toBe(ctx.nodes[0].id);
  });

  it("creates animated edge for streaming text", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "prev" });
    const node = textTreeNode("t1", "streaming...", false);
    renderTextNode(node, null, ctx);

    expect(ctx.edges.length).toBe(1);
    expect(ctx.edges[0].animated).toBe(true);
  });

  it("processes child tool nodes", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "prev" });
    const tool = toolTreeNode("tool1", "Bash", { toolResult: "ok" });
    const node = textTreeNode("t1", "thinking", true, [tool]);
    renderTextNode(node, null, ctx);

    // text node + tool_call + tool_result
    expect(ctx.nodes.length).toBe(3);
    expect(ctx.nodes[0].data.nodeType).toBe("thinking");
    expect(ctx.nodes[1].data.nodeType).toBe("tool_call");
    expect(ctx.nodes[2].data.nodeType).toBe("tool_result");
  });

  it("skips children when collapsed", () => {
    const collapsed = new Set(["t1"]);
    const ctx = makeCtx({ prevMainFlowNodeId: "prev", collapsedNodeIds: collapsed });
    const tool = toolTreeNode("tool1", "Bash", { toolResult: "ok" });
    const node = textTreeNode("t1", "thinking", true, [tool]);
    renderTextNode(node, null, ctx);

    // Only text node
    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.collapsed).toBe(true);
  });

  it("sets isPlanMode when node is in plan mode range", () => {
    const ctx = makeCtx({
      prevMainFlowNodeId: "prev",
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
  it("creates tool_call and tool_result nodes with horizontal edges", () => {
    const ctx = makeCtx();
    const node = toolTreeNode("tool1", "Read", { toolResult: "file content" });
    renderToolNode(node, "parent-id", ctx);

    expect(ctx.nodes.length).toBe(2);
    expect(ctx.nodes[0].data.nodeType).toBe("tool_call");
    expect(ctx.nodes[1].data.nodeType).toBe("tool_result");

    // Edge from parent to call (horizontal)
    expect(ctx.edges[0].sourceHandle).toBe("right");
    expect(ctx.edges[0].targetHandle).toBe("left");

    // Edge from call to result (horizontal)
    expect(ctx.edges[1].sourceHandle).toBe("right");
    expect(ctx.edges[1].targetHandle).toBe("left");
  });

  it("creates animated edge for streaming tool", () => {
    const ctx = makeCtx();
    const node = toolTreeNode("tool1", "Bash", { completed: false });
    renderToolNode(node, "parent", ctx);

    expect(ctx.edges[0].animated).toBe(true);
  });

  it("skips result node when tool_result is waiting", () => {
    const ctx = makeCtx();
    const node = toolTreeNode("tool1", "Bash", { completed: false, toolResult: undefined });
    renderToolNode(node, "parent", ctx);

    // tool_call + tool_result (waiting state)
    expect(ctx.nodes.length).toBe(2);
    expect(ctx.nodes[1].data.content).toContain("waiting");
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

  it("processes child subagent nodes", () => {
    const ctx = makeCtx();
    const child = subagentTreeNode("sa1", "explore");
    const node = toolTreeNode("tool1", "Task", {
      toolResult: "done",
      children: [child],
    });
    renderToolNode(node, "parent", ctx);

    // tool_call + tool_result + subagent
    expect(ctx.nodes.length).toBe(3);
    expect(ctx.nodes[2].data.nodeType).toBe("subagent");
  });
});

describe("renderSubagentNode", () => {
  it("creates a subagent node with horizontal edge from parent", () => {
    const ctx = makeCtx();
    const node = subagentTreeNode("sa1", "explore");
    renderSubagentNode(node, "parent-id", ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("subagent");
    expect(ctx.edges[0].sourceHandle).toBe("right");
    expect(ctx.edges[0].targetHandle).toBe("left");
  });

  it("processes child text and tool nodes", () => {
    const ctx = makeCtx();
    const children = [
      textTreeNode("t1", "thinking in subagent"),
      toolTreeNode("tool1", "Bash", { toolResult: "ok" }),
    ];
    const node = subagentTreeNode("sa1", "explore", children);
    renderSubagentNode(node, "parent", ctx);

    // subagent + text child + tool_call + tool_result
    expect(ctx.nodes.length).toBe(4);
    expect(ctx.nodes[0].data.nodeType).toBe("subagent");
    expect(ctx.nodes[1].data.nodeType).toBe("thinking");
    expect(ctx.nodes[2].data.nodeType).toBe("tool_call");
    expect(ctx.nodes[3].data.nodeType).toBe("tool_result");
  });

  it("skips children when collapsed", () => {
    const collapsed = new Set(["sa1"]);
    const ctx = makeCtx({ collapsedNodeIds: collapsed });
    const children = [textTreeNode("t1", "hidden")];
    const node = subagentTreeNode("sa1", "explore", children);
    renderSubagentNode(node, "parent", ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.collapsed).toBe(true);
  });
});

describe("renderCompletionNode", () => {
  it("creates a system node for complete type", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "prev" });
    const node = completeTreeNode("c1", "All done");
    renderCompletionNode(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("system");
    expect(ctx.nodes[0].data.label).toBe("Complete");
    expect(ctx.prevMainFlowNodeId).toBe(ctx.nodes[0].id);
  });

  it("creates a system node for error type", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "prev" });
    const node = errorTreeNode("e1", "Something broke");
    renderCompletionNode(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.label).toBe("Error");
    expect(ctx.nodes[0].data.isError).toBe(true);
  });
});

describe("renderResultNode", () => {
  it("creates a result node with duration and cost", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "prev" });
    const node = resultTreeNode("r1", {
      durationMs: 5000,
      totalCostUsd: 0.0123,
    });
    renderResultNode(node, null, ctx);

    expect(ctx.nodes.length).toBe(1);
    expect(ctx.nodes[0].data.nodeType).toBe("result");
    expect(ctx.nodes[0].data.content).toContain("5.0s");
    expect(ctx.nodes[0].data.content).toContain("$0.0123");
    expect(ctx.prevMainFlowNodeId).toBe(ctx.nodes[0].id);
  });
});

describe("processChildNodes", () => {
  it("inserts virtual thinking node when tools appear before text", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "prev" });
    const parent = userMsgNode("u1", "Hi", [
      toolTreeNode("tool1", "Bash", { toolResult: "ok" }),
    ]);
    processChildNodes(parent, ctx);

    // virtual thinking + tool_call + tool_result
    expect(ctx.nodes.length).toBe(3);
    expect(ctx.nodes[0].data.label).toBe("Initial Tools");
    expect(ctx.nodes[0].data.content).toContain("tools invoked before first thinking");
    expect(ctx.nodes[1].data.nodeType).toBe("tool_call");
  });

  it("does not insert virtual thinking when text appears first", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "prev" });
    const parent = userMsgNode("u1", "Hi", [
      textTreeNode("t1", "I'm thinking"),
      toolTreeNode("tool1", "Bash", { toolResult: "ok" }),
    ]);
    processChildNodes(parent, ctx);

    // text node + tool_call + tool_result (no virtual)
    expect(ctx.nodes[0].data.nodeType).toBe("thinking");
    expect(ctx.nodes[0].data.label).toBe("Thinking");
  });

  it("handles complete/error children in processChildNodes", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "prev" });
    const parent = userMsgNode("u1", "Hi", [
      textTreeNode("t1", "thinking"),
      completeTreeNode("c1"),
    ]);
    processChildNodes(parent, ctx);

    expect(ctx.nodes.length).toBe(2);
    expect(ctx.nodes[1].data.nodeType).toBe("system");
  });
});

describe("LayoutContext state management", () => {
  it("prevMainFlowNodeId is updated by text nodes in sequence", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "start" });
    renderTextNode(textTreeNode("t1", "first"), null, ctx);
    renderTextNode(textTreeNode("t2", "second"), null, ctx);

    expect(ctx.prevMainFlowNodeId).toBe("node-t2");
    // Verify chain: start → t1 → t2
    expect(ctx.edges[0].source).toBe("start");
    expect(ctx.edges[0].target).toBe("node-t1");
    expect(ctx.edges[1].source).toBe("node-t1");
    expect(ctx.edges[1].target).toBe("node-t2");
  });

  it("lastThinkingNodeId is used as tool parent", () => {
    const ctx = makeCtx({ prevMainFlowNodeId: "start" });
    renderTextNode(textTreeNode("t1", "thinking"), null, ctx);
    // Now lastThinkingNodeId should be node-t1
    expect(ctx.lastThinkingNodeId).toBe("node-t1");

    // Tool should connect to lastThinkingNodeId
    renderToolNode(toolTreeNode("tool1", "Bash", { toolResult: "ok" }), ctx.lastThinkingNodeId, ctx);
    // Find the edge from thinking to tool
    const toolEdge = ctx.edges.find(e => e.target === "node-tool1-call");
    expect(toolEdge?.source).toBe("node-t1");
  });
});
