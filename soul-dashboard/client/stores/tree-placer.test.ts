/**
 * tree-placer 테스트
 *
 * resolveParent와 placeInTree의 이벤트 타입별 배치 로직을 검증합니다.
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
  SoulSSEEvent,
} from "../../shared/types";

// === Helpers ===

function makeCtxWithRoot(): { ctx: ProcessingContext; root: EventTreeNode } {
  const ctx = createProcessingContext();
  const root = makeNode("root-session", "session", "");
  registerNode(ctx, root);
  return { ctx, root };
}

/** Turn root를 세팅하는 헬퍼 */
function setupTurnRoot(ctx: ProcessingContext, root: EventTreeNode): EventTreeNode {
  const turnNode = makeNode("user-msg-1", "user_message", "hello", { completed: true });
  registerNode(ctx, turnNode);
  root.children.push(turnNode);
  ctx.currentTurnNodeId = "user-msg-1";
  return turnNode;
}

// === resolveParent ===

describe("resolveParent", () => {
  it("should return turn root when parentEventId is null and currentTurnNodeId is set", () => {
    const { ctx, root } = makeCtxWithRoot();
    const turnNode = setupTurnRoot(ctx, root);

    const parent = resolveParent(null, ctx, root);

    expect(parent).toBe(turnNode);
  });

  it("should return turn root when parentEventId is undefined", () => {
    const { ctx, root } = makeCtxWithRoot();
    const turnNode = setupTurnRoot(ctx, root);

    const parent = resolveParent(undefined, ctx, root);

    expect(parent).toBe(turnNode);
  });

  it("should return session root when parentEventId is null and no currentTurnNodeId", () => {
    const { ctx, root } = makeCtxWithRoot();

    const parent = resolveParent(null, ctx, root);

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
    // Phase 6: 더 이상 orphan error를 삽입하지 않음
    expect(root.children).toHaveLength(0);
  });

  it("should return root for different unmatched parentEventIds without side effects", () => {
    const { ctx, root } = makeCtxWithRoot();

    const parentA = resolveParent("toolu_a", ctx, root);
    const parentB = resolveParent("toolu_b", ctx, root);

    // Phase 6: 매칭 실패 시 orphan error 없이 root 반환
    expect(parentA).toBe(root);
    expect(parentB).toBe(root);
    expect(root.children).toHaveLength(0);
  });
});

// === placeInTree ===

describe("placeInTree", () => {
  describe("user_message", () => {
    it("should place as root child and set currentTurnNodeId", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("user-msg-1", "user_message", "hello", { completed: true });
      const event: UserMessageEvent = { type: "user_message", user: "alice", text: "hello" };

      placeInTree(node, event, 1, ctx, root);

      expect(root.children).toContain(node);
      expect(ctx.currentTurnNodeId).toBe("user-msg-1");
      expect(ctx.nodeMap.get("user-msg-1")).toBe(node);
    });
  });

  describe("intervention_sent", () => {
    it("should place as root child and update currentTurnNodeId", () => {
      const { ctx, root } = makeCtxWithRoot();
      setupTurnRoot(ctx, root);
      const node = makeNode("intervention-2", "intervention", "stop", { completed: true });
      const event: InterventionSentEvent = {
        type: "intervention_sent",
        user: "bob",
        text: "stop",
      };

      placeInTree(node, event, 2, ctx, root);

      expect(root.children).toContain(node);
      expect(ctx.currentTurnNodeId).toBe("intervention-2");
    });
  });

  describe("thinking", () => {
    it("should place under turn root and register in lastThinkingByParent", () => {
      const { ctx, root } = makeCtxWithRoot();
      const turnNode = setupTurnRoot(ctx, root);
      const node = makeNode("thinking-3", "thinking", "hmm");
      const event: ThinkingEvent = {
        type: "thinking",
        timestamp: 0,
        thinking: "hmm",
      };

      placeInTree(node, event, 3, ctx, root);

      expect(turnNode.children).toContain(node);
      expect(ctx.lastThinkingByParent.get("")).toBe(node);
      expect(ctx.nodeMap.get("thinking-3")).toBe(node);
    });

    it("should place under tool node when parent_event_id matches tool_use_id", () => {
      const { ctx, root } = makeCtxWithRoot();
      setupTurnRoot(ctx, root);

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

      // Phase 6: nodeMap에서 직접 조회하므로 tool 노드 아래에 배치
      expect(toolNode.children).toContain(node);
      expect(ctx.lastThinkingByParent.get("toolu_abc")).toBe(node);
    });
  });

  describe("tool_start", () => {
    it("should place under turn root and register in nodeMap", () => {
      const { ctx, root } = makeCtxWithRoot();
      const turnNode = setupTurnRoot(ctx, root);
      const node = makeNode("tool-5", "tool", "", {
        toolUseId: "toolu_001",
      });
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_001",
      };

      placeInTree(node, event, 5, ctx, root);

      expect(turnNode.children).toContain(node);
      expect(ctx.nodeMap.get("toolu_001")).toBe(node);
      expect(ctx.nodeMap.get("tool-5")).toBe(node);
    });

    it("should place under parent tool node when parent_event_id matches", () => {
      const { ctx, root } = makeCtxWithRoot();
      setupTurnRoot(ctx, root);

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

      // Phase 6: nodeMap에서 직접 조회하므로 부모 tool 노드 아래에 배치
      expect(parentTool.children).toContain(node);
      expect(ctx.nodeMap.get("toolu_child")).toBe(node);
    });

    it("should not register tool_use_id key in nodeMap when tool_use_id is undefined", () => {
      const { ctx, root } = makeCtxWithRoot();
      const turnNode = setupTurnRoot(ctx, root);
      const node = makeNode("tool-7", "tool", "");
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: {},
      };

      placeInTree(node, event, 7, ctx, root);

      expect(turnNode.children).toContain(node);
      // tool_use_id가 없으므로 toolu_ 키로 nodeMap에 등록되지 않아야 함
      const toolUseKeys = [...ctx.nodeMap.keys()].filter((k) => k.startsWith("toolu_"));
      expect(toolUseKeys).toHaveLength(0);
    });
  });

  describe("complete", () => {
    it("should place under turn root when currentTurnNodeId is set", () => {
      const { ctx, root } = makeCtxWithRoot();
      const turnNode = setupTurnRoot(ctx, root);
      const node = makeNode("complete-12", "complete", "Done", { completed: true });
      const event: CompleteEvent = {
        type: "complete",
        result: "Done",
        attachments: [],
      };

      placeInTree(node, event, 12, ctx, root);

      expect(turnNode.children).toContain(node);
    });

    it("should place under root when no currentTurnNodeId", () => {
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
    it("should place under turn root when available", () => {
      const { ctx, root } = makeCtxWithRoot();
      const turnNode = setupTurnRoot(ctx, root);
      const node = makeNode("error-14", "error", "boom", { completed: true, isError: true });
      const event: ErrorEvent = { type: "error", message: "boom" };

      placeInTree(node, event, 14, ctx, root);

      expect(turnNode.children).toContain(node);
    });

    it("should place under root when no turn root", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("error-15", "error", "boom", { completed: true, isError: true });
      const event: ErrorEvent = { type: "error", message: "boom" };

      placeInTree(node, event, 15, ctx, root);

      expect(root.children).toContain(node);
    });
  });

  describe("result", () => {
    it("should place under turn root via resolveParent when no parent_event_id", () => {
      const { ctx, root } = makeCtxWithRoot();
      const turnNode = setupTurnRoot(ctx, root);
      const node = makeNode("result-16", "result", "output", { completed: true });
      const event: ResultEvent = {
        type: "result",
        timestamp: 0,
        success: true,
        output: "output",
      };

      placeInTree(node, event, 16, ctx, root);

      expect(turnNode.children).toContain(node);
    });

    it("should place under tool node via resolveParent when parent_event_id matches", () => {
      const { ctx, root } = makeCtxWithRoot();
      setupTurnRoot(ctx, root);

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

      // Phase 6: nodeMap에서 직접 조회하므로 tool 노드 아래에 배치
      expect(toolNode.children).toContain(node);
    });
  });

  describe("default (unknown creation event)", () => {
    it("should place under turn root when available", () => {
      const { ctx, root } = makeCtxWithRoot();
      const turnNode = setupTurnRoot(ctx, root);
      const node = makeNode("unknown-18", "text", "fallback");

      // Simulate an unknown event type that somehow got a node created
      const event = { type: "some_future_type" } as unknown as SoulSSEEvent;

      placeInTree(node, event, 18, ctx, root);

      expect(turnNode.children).toContain(node);
    });

    it("should place under root when no turn root", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("unknown-19", "text", "fallback");
      const event = { type: "some_future_type" } as unknown as SoulSSEEvent;

      placeInTree(node, event, 19, ctx, root);

      expect(root.children).toContain(node);
    });
  });

  describe("nodeMap registration", () => {
    it("should register every placed node in nodeMap", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("user-msg-99", "user_message", "test");
      const event: UserMessageEvent = { type: "user_message", user: "u", text: "test" };

      placeInTree(node, event, 99, ctx, root);

      expect(ctx.nodeMap.get("user-msg-99")).toBe(node);
    });
  });
});

// === handleTextStart ===

describe("handleTextStart", () => {
  describe("with matching thinking node", () => {
    it("should set activeTextTarget to the thinking node and clear lastThinkingByParent", () => {
      const { ctx, root } = makeCtxWithRoot();
      const thinkingNode = makeNode("thinking-1", "thinking", "inner thoughts", {
        completed: true,
      });
      registerNode(ctx, thinkingNode);
      root.children.push(thinkingNode);
      // Register thinking at root level (parentKey = "")
      ctx.lastThinkingByParent.set("", thinkingNode);

      const event: TextStartEvent = { type: "text_start", timestamp: 0 };
      const changed = handleTextStart(event, 10, ctx, root);

      expect(changed).toBe(true);
      expect(ctx.activeTextTarget).toBe(thinkingNode);
      expect(ctx.lastThinkingByParent.has("")).toBe(false);
    });

    it("should match thinking by parent_event_id", () => {
      const { ctx, root } = makeCtxWithRoot();
      const thinkingNode = makeNode("thinking-2", "thinking", "sub thinking");
      ctx.lastThinkingByParent.set("toolu_parent", thinkingNode);

      const event: TextStartEvent = {
        type: "text_start",
        timestamp: 0,
        parent_event_id: "toolu_parent",
      };
      const changed = handleTextStart(event, 11, ctx, root);

      expect(changed).toBe(true);
      expect(ctx.activeTextTarget).toBe(thinkingNode);
      expect(ctx.lastThinkingByParent.has("toolu_parent")).toBe(false);
    });
  });

  describe("without matching thinking node", () => {
    it("should create an independent text node under resolved parent", () => {
      const { ctx, root } = makeCtxWithRoot();

      const event: TextStartEvent = { type: "text_start", timestamp: 0 };
      const changed = handleTextStart(event, 12, ctx, root);

      expect(changed).toBe(true);
      expect(ctx.activeTextTarget).not.toBeNull();
      expect(ctx.activeTextTarget!.id).toBe("text-12");
      expect(ctx.activeTextTarget!.type).toBe("text");
      expect(ctx.nodeMap.has("text-12")).toBe(true);
      // Should be child of root (no currentTurnNodeId)
      expect(root.children).toContain(ctx.activeTextTarget);
    });

    it("should place independent text node under turn root when set", () => {
      const { ctx, root } = makeCtxWithRoot();
      const turnNode = setupTurnRoot(ctx, root);

      const event: TextStartEvent = { type: "text_start", timestamp: 0 };
      handleTextStart(event, 13, ctx, root);

      expect(turnNode.children).toContain(ctx.activeTextTarget);
    });
  });
});
