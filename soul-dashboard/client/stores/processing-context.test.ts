/**
 * processing-context 테스트
 *
 * ProcessingContext 생성, makeNode, registerNode, ensureRoot, insertOrphanError를 검증합니다.
 */

import { describe, it, expect } from "vitest";
import {
  createProcessingContext,
  makeNode,
  registerNode,
  ensureRoot,
  insertOrphanError,
} from "./processing-context";
import type { ProcessingContext } from "./processing-context";
import type { EventTreeNode } from "../../shared/types";

describe("createProcessingContext", () => {
  it("should return a context with all empty Maps and null fields", () => {
    const ctx = createProcessingContext();

    expect(ctx.nodeMap).toBeInstanceOf(Map);
    expect(ctx.nodeMap.size).toBe(0);

    expect(ctx.toolUseMap).toBeInstanceOf(Map);
    expect(ctx.toolUseMap.size).toBe(0);

    expect(ctx.lastThinkingByParent).toBeInstanceOf(Map);
    expect(ctx.lastThinkingByParent.size).toBe(0);

    expect(ctx.activeTextTarget).toBeNull();
    expect(ctx.currentTurnNodeId).toBeNull();
  });

  it("should return independent contexts on multiple calls", () => {
    const ctx1 = createProcessingContext();
    const ctx2 = createProcessingContext();

    ctx1.nodeMap.set("a", makeNode("a", "text", "hello"));
    expect(ctx2.nodeMap.size).toBe(0);
  });
});

describe("makeNode", () => {
  it("should create a node with required fields", () => {
    const node = makeNode("node-1", "text", "hello world");

    expect(node.id).toBe("node-1");
    expect(node.type).toBe("text");
    expect(node.content).toBe("hello world");
    expect(node.children).toEqual([]);
    expect(node.completed).toBe(false);
  });

  it("should apply extra partial overrides", () => {
    const node = makeNode("err-1", "error", "something broke", {
      completed: true,
      isError: true,
    });

    expect(node.completed).toBe(true);
    expect(node.isError).toBe(true);
  });

  it("should allow overriding children via extra", () => {
    const child = makeNode("child-1", "text", "child");
    const parent = makeNode("parent-1", "session", "", {
      children: [child],
    });

    expect(parent.children).toHaveLength(1);
    expect(parent.children[0].id).toBe("child-1");
  });

  it("should set tool-specific fields via extra", () => {
    const node = makeNode("tool-1", "tool", "", {
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseId: "toolu_abc",
      parentToolUseId: "toolu_parent",
      timestamp: 1700000000,
    });

    expect(node.toolName).toBe("Bash");
    expect(node.toolInput).toEqual({ command: "ls" });
    expect(node.toolUseId).toBe("toolu_abc");
    expect(node.parentToolUseId).toBe("toolu_parent");
    expect(node.timestamp).toBe(1700000000);
  });

  it("should set subagent-specific fields via extra", () => {
    const node = makeNode("agent-1", "subagent", "", {
      agentId: "agent-1",
      agentType: "task",
    });

    expect(node.agentId).toBe("agent-1");
    expect(node.agentType).toBe("task");
  });
});

describe("registerNode", () => {
  it("should add node to nodeMap", () => {
    const ctx = createProcessingContext();
    const node = makeNode("n1", "text", "hello");

    registerNode(ctx, node);

    expect(ctx.nodeMap.get("n1")).toBe(node);
  });

  it("should overwrite existing node with same id", () => {
    const ctx = createProcessingContext();
    const node1 = makeNode("n1", "text", "first");
    const node2 = makeNode("n1", "text", "second");

    registerNode(ctx, node1);
    registerNode(ctx, node2);

    expect(ctx.nodeMap.get("n1")).toBe(node2);
    expect(ctx.nodeMap.size).toBe(1);
  });
});

describe("ensureRoot", () => {
  it("should return existing tree if not null", () => {
    const ctx = createProcessingContext();
    const existing = makeNode("my-root", "session", "existing");

    const result = ensureRoot(existing, ctx);

    expect(result).toBe(existing);
    // should NOT register the existing tree again
    expect(ctx.nodeMap.has("my-root")).toBe(false);
  });

  it("should create and register root node if tree is null", () => {
    const ctx = createProcessingContext();

    const result = ensureRoot(null, ctx);

    expect(result.id).toBe("root-session");
    expect(result.type).toBe("session");
    expect(result.content).toBe("");
    expect(result.children).toEqual([]);
    expect(result.completed).toBe(false);
    expect(ctx.nodeMap.get("root-session")).toBe(result);
  });

  it("should return the same root on repeated calls with the created root", () => {
    const ctx = createProcessingContext();

    const root1 = ensureRoot(null, ctx);
    const root2 = ensureRoot(root1, ctx);

    expect(root1).toBe(root2);
  });
});

describe("insertOrphanError", () => {
  it("should create an error node and prepend to root.children", () => {
    const ctx = createProcessingContext();
    const root = makeNode("root-session", "session", "");
    const existingChild = makeNode("existing", "text", "already here");
    root.children.push(existingChild);

    insertOrphanError(root, ctx, "tool_start", 42, "missing parent");

    // error node should be at the front
    expect(root.children).toHaveLength(2);
    expect(root.children[0].id).toBe("orphan-error-42");
    expect(root.children[0].type).toBe("error");
    expect(root.children[0].completed).toBe(true);
    expect(root.children[0].isError).toBe(true);
    expect(root.children[0].content).toContain("[tool_start]");
    expect(root.children[0].content).toContain("missing parent");

    // existing child should be pushed to second position
    expect(root.children[1]).toBe(existingChild);
  });

  it("should register the error node in nodeMap", () => {
    const ctx = createProcessingContext();
    const root = makeNode("root-session", "session", "");

    insertOrphanError(root, ctx, "resolveParent", 99, "no match");

    expect(ctx.nodeMap.has("orphan-error-99")).toBe(true);
  });

  it("should create multiple error nodes with different IDs", () => {
    const ctx = createProcessingContext();
    const root = makeNode("root-session", "session", "");

    insertOrphanError(root, ctx, "type1", 1, "detail1");
    insertOrphanError(root, ctx, "type2", 2, "detail2");

    expect(root.children).toHaveLength(2);
    // most recent should be at front (unshift)
    expect(root.children[0].id).toBe("orphan-error-2");
    expect(root.children[1].id).toBe("orphan-error-1");
  });
});
