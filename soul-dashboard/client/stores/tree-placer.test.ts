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
  SubagentStartEvent,
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
  it("should return turn root when parentToolUseId is null and currentTurnNodeId is set", () => {
    const { ctx, root } = makeCtxWithRoot();
    const turnNode = setupTurnRoot(ctx, root);

    const parent = resolveParent(null, ctx, root);

    expect(parent).toBe(turnNode);
  });

  it("should return turn root when parentToolUseId is undefined", () => {
    const { ctx, root } = makeCtxWithRoot();
    const turnNode = setupTurnRoot(ctx, root);

    const parent = resolveParent(undefined, ctx, root);

    expect(parent).toBe(turnNode);
  });

  it("should return session root when parentToolUseId is null and no currentTurnNodeId", () => {
    const { ctx, root } = makeCtxWithRoot();

    const parent = resolveParent(null, ctx, root);

    expect(parent).toBe(root);
  });

  it("should return session root when parentToolUseId is empty string", () => {
    const { ctx, root } = makeCtxWithRoot();

    const parent = resolveParent("", ctx, root);

    expect(parent).toBe(root);
  });

  it("should return subagent child of tool node when parentToolUseId matches", () => {
    const { ctx, root } = makeCtxWithRoot();
    const toolNode = makeNode("tool-1", "tool", "", { toolUseId: "toolu_abc" });
    registerNode(ctx, toolNode);
    ctx.toolUseMap.set("toolu_abc", toolNode);

    const subagentNode = makeNode("agent-1", "subagent", "", { agentId: "agent-1" });
    toolNode.children.push(subagentNode);

    const parent = resolveParent("toolu_abc", ctx, root);

    expect(parent).toBe(subagentNode);
  });

  it("should return tool node when parentToolUseId matches but no subagent child", () => {
    const { ctx, root } = makeCtxWithRoot();
    const toolNode = makeNode("tool-1", "tool", "", { toolUseId: "toolu_abc" });
    registerNode(ctx, toolNode);
    ctx.toolUseMap.set("toolu_abc", toolNode);

    const parent = resolveParent("toolu_abc", ctx, root);

    expect(parent).toBe(toolNode);
  });

  it("should insert orphan error and return root when parentToolUseId has no match", () => {
    const { ctx, root } = makeCtxWithRoot();

    const parent = resolveParent("toolu_nonexistent", ctx, root);

    expect(parent).toBe(root);
    // Should have inserted an error node with unique ID based on parentToolUseId
    expect(root.children).toHaveLength(1);
    expect(root.children[0].type).toBe("error");
    expect(root.children[0].id).toBe("orphan-error-resolve-toolu_nonexistent");
    expect(root.children[0].content).toContain("toolu_nonexistent");
    expect(root.children[0].content).toContain("toolUseMap");
  });

  it("should create unique orphan error IDs for different parentToolUseIds", () => {
    const { ctx, root } = makeCtxWithRoot();

    resolveParent("toolu_a", ctx, root);
    resolveParent("toolu_b", ctx, root);

    // 서로 다른 parentToolUseId → 서로 다른 에러 노드 ID
    expect(root.children).toHaveLength(2);
    expect(root.children[0].id).toBe("orphan-error-resolve-toolu_b");
    expect(root.children[1].id).toBe("orphan-error-resolve-toolu_a");
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

    it("should place under subagent when parent_tool_use_id matches tool with subagent", () => {
      const { ctx, root } = makeCtxWithRoot();
      setupTurnRoot(ctx, root);

      // Setup tool -> subagent hierarchy
      const toolNode = makeNode("tool-1", "tool", "", { toolUseId: "toolu_abc" });
      registerNode(ctx, toolNode);
      ctx.toolUseMap.set("toolu_abc", toolNode);
      const subNode = makeNode("agent-1", "subagent", "");
      toolNode.children.push(subNode);

      const node = makeNode("thinking-4", "thinking", "sub-thinking");
      const event: ThinkingEvent = {
        type: "thinking",
        timestamp: 0,
        thinking: "sub-thinking",
        parent_tool_use_id: "toolu_abc",
      };

      placeInTree(node, event, 4, ctx, root);

      expect(subNode.children).toContain(node);
      expect(ctx.lastThinkingByParent.get("toolu_abc")).toBe(node);
    });
  });

  describe("tool_start", () => {
    it("should place under turn root and register in toolUseMap", () => {
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
      expect(ctx.toolUseMap.get("toolu_001")).toBe(node);
      expect(ctx.nodeMap.get("tool-5")).toBe(node);
    });

    it("should place under subagent when parent_tool_use_id matches", () => {
      const { ctx, root } = makeCtxWithRoot();
      setupTurnRoot(ctx, root);

      const parentTool = makeNode("tool-parent", "tool", "", { toolUseId: "toolu_parent" });
      registerNode(ctx, parentTool);
      ctx.toolUseMap.set("toolu_parent", parentTool);
      const subNode = makeNode("agent-1", "subagent", "");
      parentTool.children.push(subNode);

      const node = makeNode("tool-child", "tool", "", { toolUseId: "toolu_child" });
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "toolu_child",
        parent_tool_use_id: "toolu_parent",
      };

      placeInTree(node, event, 6, ctx, root);

      expect(subNode.children).toContain(node);
      expect(ctx.toolUseMap.get("toolu_child")).toBe(node);
    });

    it("should not register in toolUseMap when tool_use_id is undefined", () => {
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
      expect(ctx.toolUseMap.size).toBe(0);
    });
  });

  describe("subagent_start", () => {
    it("should place under turn root when parent_tool_use_id is empty", () => {
      const { ctx, root } = makeCtxWithRoot();
      const turnNode = setupTurnRoot(ctx, root);
      const node = makeNode("agent-1", "subagent", "", {
        agentId: "agent-1",
        agentType: "task",
        parentToolUseId: "",
      });
      const event: SubagentStartEvent = {
        type: "subagent_start",
        timestamp: 0,
        agent_id: "agent-1",
        agent_type: "task",
        parent_tool_use_id: "",
      };

      placeInTree(node, event, 8, ctx, root);

      expect(turnNode.children).toContain(node);
      expect(ctx.subagentMap.get("agent-1")).toBe(node);
    });

    it("should place under root when no currentTurnNodeId and empty parent_tool_use_id", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("agent-2", "subagent", "", {
        agentId: "agent-2",
        agentType: "task",
      });
      const event: SubagentStartEvent = {
        type: "subagent_start",
        timestamp: 0,
        agent_id: "agent-2",
        agent_type: "task",
        parent_tool_use_id: "",
      };

      placeInTree(node, event, 9, ctx, root);

      expect(root.children).toContain(node);
      expect(ctx.subagentMap.get("agent-2")).toBe(node);
    });

    it("should reparent children from tool to subagent when parent_tool_use_id matches", () => {
      const { ctx, root } = makeCtxWithRoot();
      setupTurnRoot(ctx, root);

      // Setup parent tool with an existing child that has same parentToolUseId
      const parentTool = makeNode("tool-parent", "tool", "", { toolUseId: "toolu_xyz" });
      registerNode(ctx, parentTool);
      ctx.toolUseMap.set("toolu_xyz", parentTool);

      const orphanChild = makeNode("thinking-orphan", "thinking", "I was here first", {
        parentToolUseId: "toolu_xyz",
      });
      parentTool.children.push(orphanChild);

      const nonMatchChild = makeNode("other-child", "text", "unrelated");
      parentTool.children.push(nonMatchChild);

      const node = makeNode("agent-3", "subagent", "", {
        agentId: "agent-3",
        agentType: "task",
        parentToolUseId: "toolu_xyz",
      });
      const event: SubagentStartEvent = {
        type: "subagent_start",
        timestamp: 0,
        agent_id: "agent-3",
        agent_type: "task",
        parent_tool_use_id: "toolu_xyz",
      };

      placeInTree(node, event, 10, ctx, root);

      // parentTool should now have [nonMatchChild, node]
      expect(parentTool.children).toHaveLength(2);
      expect(parentTool.children[0]).toBe(nonMatchChild);
      expect(parentTool.children[1]).toBe(node);

      // orphanChild should be reparented under node
      expect(node.children).toContain(orphanChild);
    });

    it("should insert orphan error and place under root when parent_tool_use_id has no match", () => {
      const { ctx, root } = makeCtxWithRoot();
      const node = makeNode("agent-4", "subagent", "", {
        agentId: "agent-4",
        agentType: "task",
        parentToolUseId: "toolu_missing",
      });
      const event: SubagentStartEvent = {
        type: "subagent_start",
        timestamp: 0,
        agent_id: "agent-4",
        agent_type: "task",
        parent_tool_use_id: "toolu_missing",
      };

      placeInTree(node, event, 11, ctx, root);

      // Should have error node + subagent node in root.children
      expect(root.children.some((c) => c.type === "error")).toBe(true);
      expect(root.children).toContain(node);
      expect(ctx.subagentMap.get("agent-4")).toBe(node);
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
    it("should place under turn root via resolveParent when no parent_tool_use_id", () => {
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

    it("should place under subagent via resolveParent when parent_tool_use_id matches", () => {
      const { ctx, root } = makeCtxWithRoot();
      setupTurnRoot(ctx, root);

      const toolNode = makeNode("tool-1", "tool", "", { toolUseId: "toolu_res" });
      registerNode(ctx, toolNode);
      ctx.toolUseMap.set("toolu_res", toolNode);
      const subNode = makeNode("agent-1", "subagent", "");
      toolNode.children.push(subNode);

      const node = makeNode("result-17", "result", "sub-output", { completed: true });
      const event: ResultEvent = {
        type: "result",
        timestamp: 0,
        success: true,
        output: "sub-output",
        parent_tool_use_id: "toolu_res",
      };

      placeInTree(node, event, 17, ctx, root);

      expect(subNode.children).toContain(node);
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

    it("should match thinking by parent_tool_use_id", () => {
      const { ctx, root } = makeCtxWithRoot();
      const thinkingNode = makeNode("thinking-2", "thinking", "sub thinking");
      ctx.lastThinkingByParent.set("toolu_parent", thinkingNode);

      const event: TextStartEvent = {
        type: "text_start",
        timestamp: 0,
        parent_tool_use_id: "toolu_parent",
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
