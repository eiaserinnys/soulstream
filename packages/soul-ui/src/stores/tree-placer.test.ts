/**
 * tree-placer 테스트
 *
 * Phase 8: 순수 parent_event_id 기반 배치 로직을 검증합니다.
 * resolveParent, placeInTree, handleTextStart.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { resolveParent, placeInTree, handleTextStart } from "./tree-placer";
import { createProcessingContext, makeNode, registerNode } from "./processing-context";
import type { ProcessingContext } from "./processing-context";
import type {
  EventTreeNode,
  UserMessageEvent,
  InterventionSentEvent,
  ThinkingEvent,
  TextStartEvent,
  ToolStartEvent,
  CompleteEvent,
  ErrorEvent,
  ResultEvent,
  InputRequestEvent,
  SoulSSEEvent,
} from "../../shared/types";

// === Helpers ===

function makeCtxWithRoot(): { ctx: ProcessingContext; root: EventTreeNode } {
  const ctx = createProcessingContext();
  const root = makeNode("root-session", "session", "");
  registerNode(ctx, root);
  return { ctx, root };
}

// === resolveParent ===

describe("resolveParent", () => {
  it("should return root when parentEventId is null", () => {
    const { ctx, root } = makeCtxWithRoot();

    const parent = resolveParent(null, ctx, root);

    expect(parent).toBe(root);
  });

  it("should return root when parentEventId is undefined", () => {
    const { ctx, root } = makeCtxWithRoot();

    const parent = resolveParent(undefined, ctx, root);

    expect(parent).toBe(root);
  });

  it("should return session root when parentEventId is empty string", () => {
    const { ctx, root } = makeCtxWithRoot();

    const parent = resolveParent("", ctx, root);

    expect(parent).toBe(root);
  });

  it("should return tool node directly when parentEventId matches tool_use_id in nodeMap", () => {
    const { ctx, root } = makeCtxWithRoot();
    const toolNode = makeNode("tool-1", "tool", "", { toolUseId: "toolu_abc" });
    registerNode(ctx, toolNode);
    ctx.nodeMap.set("toolu_abc", toolNode);

    const parent = resolveParent("toolu_abc", ctx, root);

    expect(parent).toBe(toolNode);
  });

  it("should return tool node when parentEventId matches but no subagent child", () => {
    const { ctx, root } = makeCtxWithRoot();
    const toolNode = makeNode("tool-1", "tool", "", { toolUseId: "toolu_abc" });
    registerNode(ctx, toolNode);
    ctx.nodeMap.set("toolu_abc", toolNode);

    const parent = resolveParent("toolu_abc", ctx, root);

    expect(parent).toBe(toolNode);
  });

  it("should return root when parentEventId has no match in nodeMap", () => {
    const { ctx, root } = makeCtxWithRoot();

    const parent = resolveParent("toolu_nonexistent", ctx, root);

    expect(parent).toBe(root);
    expect(root.children).toHaveLength(0);
  });

  it("should return root for different unmatched parentEventIds without side effects", () => {
    const { ctx, root } = makeCtxWithRoot();

    const parentA = resolveParent("toolu_a", ctx, root);
    const parentB = resolveParent("toolu_b", ctx, root);

    expect(parentA).toBe(root);
    expect(parentB).toBe(root);
    expect(root.children).toHaveLength(0);
  });
});

// === placeInTree ===

describe("placeInTree", () => {
  describe("user_message", () => {
    it("should place as root child", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("user-msg-1", "user_message", "hello", { completed: true });
      const event: UserMessageEvent = { type: "user_message", user: "alice", text: "hello" };

      placeInTree(node, event, 1, ctx, root);

      expect(root.children).toContain(node);
      expect(ctx.nodeMap.get("user-msg-1")).toBe(node);
    });
  });

  describe("intervention_sent", () => {
    it("should place as root child", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("intervention-2", "intervention", "stop", { completed: true });
      const event: InterventionSentEvent = {
        type: "intervention_sent",
        user: "bob",
        text: "stop",
      };

      placeInTree(node, event, 2, ctx, root);

      expect(root.children).toContain(node);
    });
  });

  describe("thinking", () => {
    it("should place under parent node when parent_event_id matches", () => {
      const { ctx, root } = makeCtxWithRoot();
      // Setup parent node (user_message) registered by eventId
      const parentNode = makeNode("user-msg-1", "user_message", "hello", { completed: true });
      registerNode(ctx, parentNode);
      ctx.nodeMap.set("100", parentNode);
      root.children.push(parentNode);

      const node = makeNode("thinking-3", "thinking", "hmm");
      const event: ThinkingEvent = {
        type: "thinking",
        timestamp: 0,
        thinking: "hmm",
        parent_event_id: "100",
      };

      placeInTree(node, event, 3, ctx, root);

      expect(parentNode.children).toContain(node);
      expect(ctx.nodeMap.get("thinking-3")).toBe(node);
    });

    it("should place under tool node when parent_event_id matches tool_use_id", () => {
      const { ctx, root } = makeCtxWithRoot();

      // Setup tool node registered by tool_use_id in nodeMap
      const toolNode = makeNode("tool-1", "tool", "", { toolUseId: "toolu_abc" });
      registerNode(ctx, toolNode);
      ctx.nodeMap.set("toolu_abc", toolNode);

      const node = makeNode("thinking-4", "thinking", "sub-thinking");
      const event: ThinkingEvent = {
        type: "thinking",
        timestamp: 0,
        thinking: "sub-thinking",
        parent_event_id: "toolu_abc",
      };

      placeInTree(node, event, 4, ctx, root);

      expect(toolNode.children).toContain(node);
    });
  });

  describe("tool_start", () => {
    it("should place under parent node and register in nodeMap", () => {
      const { ctx, root } = makeCtxWithRoot();
      // Setup parent node
      const parentNode = makeNode("user-msg-1", "user_message", "hello", { completed: true });
      registerNode(ctx, parentNode);
      ctx.nodeMap.set("100", parentNode);
      root.children.push(parentNode);

      const node = makeNode("tool-5", "tool", "", {
        toolUseId: "toolu_001",
      });
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_001",
        parent_event_id: "100",
      };

      placeInTree(node, event, 5, ctx, root);

      expect(parentNode.children).toContain(node);
      expect(ctx.nodeMap.get("toolu_001")).toBe(node);
      expect(ctx.nodeMap.get("tool-5")).toBe(node);
    });

    it("should place under parent tool node when parent_event_id matches", () => {
      const { ctx, root } = makeCtxWithRoot();

      const parentTool = makeNode("tool-parent", "tool", "", { toolUseId: "toolu_parent" });
      registerNode(ctx, parentTool);
      ctx.nodeMap.set("toolu_parent", parentTool);

      const node = makeNode("tool-child", "tool", "", { toolUseId: "toolu_child" });
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "toolu_child",
        parent_event_id: "toolu_parent",
      };

      placeInTree(node, event, 6, ctx, root);

      expect(parentTool.children).toContain(node);
      expect(ctx.nodeMap.get("toolu_child")).toBe(node);
    });

    it("should not register tool_use_id key in nodeMap when tool_use_id is undefined", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("tool-7", "tool", "");
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: {},
      };

      placeInTree(node, event, 7, ctx, root);

      // tool_use_id가 없으므로 toolu_ 키로 nodeMap에 등록되지 않아야 함
      const toolUseKeys = [...ctx.nodeMap.keys()].filter((k) => k.startsWith("toolu_"));
      expect(toolUseKeys).toHaveLength(0);
      // root 직하 배치 (no parent_event_id)
      expect(root.children).toContain(node);
    });
  });

  describe("complete", () => {
    it("should place under parent when parent_event_id is set", () => {
      const { ctx, root } = makeCtxWithRoot();
      const parentNode = makeNode("user-msg-1", "user_message", "hello", { completed: true });
      registerNode(ctx, parentNode);
      ctx.nodeMap.set("100", parentNode);
      root.children.push(parentNode);

      const node = makeNode("complete-12", "complete", "Done", { completed: true });
      const event: CompleteEvent = {
        type: "complete",
        result: "Done",
        attachments: [],
        parent_event_id: "100",
      };

      placeInTree(node, event, 12, ctx, root);

      expect(parentNode.children).toContain(node);
    });

    it("should place under root when no parent_event_id", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("complete-13", "complete", "Done", { completed: true });
      const event: CompleteEvent = {
        type: "complete",
        result: "Done",
        attachments: [],
      };

      placeInTree(node, event, 13, ctx, root);

      expect(root.children).toContain(node);
    });
  });

  describe("error", () => {
    it("should place under parent when parent_event_id is set", () => {
      const { ctx, root } = makeCtxWithRoot();
      const parentNode = makeNode("user-msg-1", "user_message", "hello", { completed: true });
      registerNode(ctx, parentNode);
      ctx.nodeMap.set("100", parentNode);
      root.children.push(parentNode);

      const node = makeNode("error-14", "error", "boom", { completed: true, isError: true });
      const event: ErrorEvent = { type: "error", message: "boom", parent_event_id: "100" };

      placeInTree(node, event, 14, ctx, root);

      expect(parentNode.children).toContain(node);
    });

    it("should place under root when no parent_event_id", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("error-15", "error", "boom", { completed: true, isError: true });
      const event: ErrorEvent = { type: "error", message: "boom" };

      placeInTree(node, event, 15, ctx, root);

      expect(root.children).toContain(node);
    });
  });

  describe("result", () => {
    it("should place under root when no parent_event_id", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("result-16", "result", "output", { completed: true });
      const event: ResultEvent = {
        type: "result",
        timestamp: 0,
        success: true,
        output: "output",
      };

      placeInTree(node, event, 16, ctx, root);

      expect(root.children).toContain(node);
    });

    it("should place under tool node via resolveParent when parent_event_id matches", () => {
      const { ctx, root } = makeCtxWithRoot();

      const toolNode = makeNode("tool-1", "tool", "", { toolUseId: "toolu_res" });
      registerNode(ctx, toolNode);
      ctx.nodeMap.set("toolu_res", toolNode);

      const node = makeNode("result-17", "result", "sub-output", { completed: true });
      const event: ResultEvent = {
        type: "result",
        timestamp: 0,
        success: true,
        output: "sub-output",
        parent_event_id: "toolu_res",
      };

      placeInTree(node, event, 17, ctx, root);

      expect(toolNode.children).toContain(node);
    });
  });

  describe("input_request", () => {
    it("should place under root when no parent_event_id", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("input-request-20", "input_request", "Select option", {
        requestId: "req-001",
        responded: false,
      });
      const event: InputRequestEvent = {
        type: "input_request",
        timestamp: 1700000000,
        request_id: "req-001",
        questions: [{ question: "Select option", options: [{ label: "A" }] }],
      };

      placeInTree(node, event, 20, ctx, root);

      expect(root.children).toContain(node);
      expect(ctx.nodeMap.get("input-request-20")).toBe(node);
    });

    it("should place under tool node via resolveParent when parent_event_id matches", () => {
      const { ctx, root } = makeCtxWithRoot();

      const toolNode = makeNode("tool-1", "tool", "", { toolUseId: "toolu_ask" });
      registerNode(ctx, toolNode);
      ctx.nodeMap.set("toolu_ask", toolNode);

      const node = makeNode("input-request-21", "input_request", "Choose", {
        requestId: "req-002",
        responded: false,
      });
      const event: InputRequestEvent = {
        type: "input_request",
        timestamp: 1700000001,
        request_id: "req-002",
        questions: [{ question: "Choose", options: [{ label: "X" }] }],
        parent_event_id: "toolu_ask",
      };

      placeInTree(node, event, 21, ctx, root);

      expect(toolNode.children).toContain(node);
    });
  });

  describe("default (unknown creation event)", () => {
    it("should place under root when no parent_event_id", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("unknown-19", "text", "fallback");
      const event = { type: "some_future_type" } as unknown as SoulSSEEvent;

      placeInTree(node, event, 19, ctx, root);

      expect(root.children).toContain(node);
    });
  });

  describe("nodeMap registration", () => {
    it("should register every placed node in nodeMap by node.id", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("user-msg-99", "user_message", "test");
      const event: UserMessageEvent = { type: "user_message", user: "u", text: "test" };

      placeInTree(node, event, 99, ctx, root);

      expect(ctx.nodeMap.get("user-msg-99")).toBe(node);
    });

    it("should register node by String(eventId) in nodeMap", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("user-msg-1", "user_message", "test");
      const event: UserMessageEvent = { type: "user_message", user: "u", text: "test" };

      placeInTree(node, event, 42, ctx, root);

      expect(ctx.nodeMap.get("42")).toBe(node);
    });

    it("should register tool_use_id in nodeMap for tool_start", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("tool-1", "tool", "", { toolUseId: "toolu_xyz" });
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "toolu_xyz",
      };

      placeInTree(node, event, 10, ctx, root);

      // Three registrations: node.id, String(eventId), tool_use_id
      expect(ctx.nodeMap.get("tool-1")).toBe(node);
      expect(ctx.nodeMap.get("10")).toBe(node);
      expect(ctx.nodeMap.get("toolu_xyz")).toBe(node);
    });
  });
});

// === handleTextStart ===

describe("handleTextStart", () => {
  it("should always create an independent text node (even when thinking exists)", () => {
    const { ctx, root } = makeCtxWithRoot();
    const thinkingNode = makeNode("thinking-1", "thinking", "inner thoughts", {
      completed: true,
    });
    registerNode(ctx, thinkingNode);
    root.children.push(thinkingNode);

    const event: TextStartEvent = { type: "text_start", timestamp: 0 };
    const changed = handleTextStart(event, 10, ctx, root);

    expect(changed).toBe(true);
    expect(ctx.activeTextTarget).not.toBeNull();
    expect(ctx.activeTextTarget!.id).toBe("text-10");
    expect(ctx.activeTextTarget!.type).toBe("text");
    // text node is a sibling of thinking, not merged into it
    expect(root.children).toContain(ctx.activeTextTarget);
    expect(root.children).toContain(thinkingNode);
  });

  it("should create an independent text node under resolved parent", () => {
    const { ctx, root } = makeCtxWithRoot();

    const event: TextStartEvent = { type: "text_start", timestamp: 0 };
    const changed = handleTextStart(event, 12, ctx, root);

    expect(changed).toBe(true);
    expect(ctx.activeTextTarget).not.toBeNull();
    expect(ctx.activeTextTarget!.id).toBe("text-12");
    expect(ctx.activeTextTarget!.type).toBe("text");
    expect(ctx.nodeMap.has("text-12")).toBe(true);
    // Should be child of root (no parent_event_id)
    expect(root.children).toContain(ctx.activeTextTarget);
  });

  it("should place text node under parent when parent_event_id is set", () => {
    const { ctx, root } = makeCtxWithRoot();
    // Setup parent node registered by eventId
    const parentNode = makeNode("user-msg-1", "user_message", "hello", { completed: true });
    registerNode(ctx, parentNode);
    ctx.nodeMap.set("100", parentNode);
    root.children.push(parentNode);

    const event: TextStartEvent = { type: "text_start", timestamp: 0, parent_event_id: "100" };
    handleTextStart(event, 13, ctx, root);

    expect(parentNode.children).toContain(ctx.activeTextTarget);
  });
});
