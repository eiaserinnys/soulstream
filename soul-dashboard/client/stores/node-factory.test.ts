/**
 * node-factory 테스트
 *
 * createNodeFromEvent (생성형/업데이트형 분류) 및 applyUpdate를 검증합니다.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createNodeFromEvent, applyUpdate } from "./node-factory";
import { createProcessingContext, makeNode, registerNode } from "./processing-context";
import type { ProcessingContext } from "./processing-context";
import type {
  EventTreeNode,
  UserMessageEvent,
  InterventionSentEvent,
  ThinkingEvent,
  SubagentStartEvent,
  ToolStartEvent,
  CompleteEvent,
  ErrorEvent,
  ResultEvent,
  SessionEvent,
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ToolResultEvent,
  SubagentStopEvent,
  ProgressEvent,
  MemoryEvent,
  ToolNode,
  UserMessageNode,
  InterventionNode,
  ErrorNode,
  ResultNode,
  SessionNode,
  TextNode,
  InputRequestEvent,
  InputRequestNodeDef,
} from "../../shared/types";

// === Helpers ===

function makeCtxWithRoot(): { ctx: ProcessingContext; root: EventTreeNode } {
  const ctx = createProcessingContext();
  const root = makeNode("root-session", "session", "");
  registerNode(ctx, root);
  return { ctx, root };
}

// === createNodeFromEvent ===

describe("createNodeFromEvent", () => {
  describe("creation events (returns non-null)", () => {
    it("should create node for user_message", () => {
      const event: UserMessageEvent = {
        type: "user_message",
        user: "alice",
        text: "Hello, world!",
      };

      const node = createNodeFromEvent(event, 1);

      expect(node).not.toBeNull();
      expect(node!.id).toBe("user-msg-1");
      expect(node!.type).toBe("user_message");
      expect(node!.content).toBe("Hello, world!");
      expect(node!.completed).toBe(true);
      expect((node as UserMessageNode).user).toBe("alice");
      expect(node!.children).toEqual([]);
    });

    it("should create node for intervention_sent", () => {
      const event: InterventionSentEvent = {
        type: "intervention_sent",
        user: "bob",
        text: "Please stop",
      };

      const node = createNodeFromEvent(event, 5);

      expect(node).not.toBeNull();
      expect(node!.id).toBe("intervention-5");
      expect(node!.type).toBe("intervention");
      expect(node!.content).toBe("Please stop");
      expect(node!.completed).toBe(true);
      expect((node as InterventionNode).user).toBe("bob");
    });

    it("should create node for thinking", () => {
      const event: ThinkingEvent = {
        type: "thinking",
        timestamp: 1700000000,
        thinking: "Let me consider...",
        parent_event_id: "toolu_abc",
      };

      const node = createNodeFromEvent(event, 10);

      expect(node).not.toBeNull();
      expect(node!.id).toBe("thinking-10");
      expect(node!.type).toBe("thinking");
      expect(node!.content).toBe("Let me consider...");
      expect(node!.completed).toBe(true);
    });

    it("should return null for subagent_start (R4: ignored)", () => {
      const event: SubagentStartEvent = {
        type: "subagent_start",
        timestamp: 1700000000,
        agent_id: "agent-uuid-123",
        agent_type: "task",
        parent_event_id: "toolu_xyz",
      };

      const node = createNodeFromEvent(event, 20);

      expect(node).toBeNull();
    });

    it("should create node for tool_start", () => {
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 1700000001,
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
        tool_use_id: "toolu_001",
        parent_event_id: "toolu_parent",
      };

      const node = createNodeFromEvent(event, 30);

      expect(node).not.toBeNull();
      expect(node!.id).toBe("tool-30");
      expect(node!.type).toBe("tool");
      expect(node!.content).toBe("");
      expect(node!.completed).toBe(false);
      expect((node as ToolNode).toolName).toBe("Bash");
      expect((node as ToolNode).toolInput).toEqual({ command: "ls -la" });
      expect((node as ToolNode).toolUseId).toBe("toolu_001");
      expect(node!.parentEventId).toBe("toolu_parent");
      expect(node!.timestamp).toBe(1700000001);
    });

    it("should create node for complete", () => {
      const event: CompleteEvent = {
        type: "complete",
        result: "All done!",
        attachments: [],
      };

      const node = createNodeFromEvent(event, 40);

      expect(node).not.toBeNull();
      expect(node!.id).toBe("complete-40");
      expect(node!.type).toBe("complete");
      expect(node!.content).toBe("All done!");
      expect(node!.completed).toBe(true);
    });

    it("should keep empty string content for complete when result is empty", () => {
      const event: CompleteEvent = {
        type: "complete",
        result: "",
        attachments: [],
      };

      const node = createNodeFromEvent(event, 41);

      // ?? only catches null/undefined, not empty string
      expect(node!.content).toBe("");
    });

    it("should create node for error", () => {
      const event: ErrorEvent = {
        type: "error",
        message: "Something went wrong",
        error_code: "INTERNAL",
      };

      const node = createNodeFromEvent(event, 50);

      expect(node).not.toBeNull();
      expect(node!.id).toBe("error-50");
      expect(node!.type).toBe("error");
      expect(node!.content).toBe("Something went wrong");
      expect(node!.completed).toBe(true);
      expect((node as ErrorNode).isError).toBe(true);
    });

    it("should create node for result", () => {
      const event: ResultEvent = {
        type: "result",
        timestamp: 1700000010,
        success: true,
        output: "Task finished",
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.005,
      };

      const node = createNodeFromEvent(event, 60);

      expect(node).not.toBeNull();
      expect(node!.id).toBe("result-60");
      expect(node!.type).toBe("result");
      expect(node!.content).toBe("Task finished");
      expect(node!.completed).toBe(true);
      expect(node!.timestamp).toBe(1700000010);
      expect((node as ResultNode).usage).toEqual({ input_tokens: 100, output_tokens: 50 });
      expect((node as ResultNode).totalCostUsd).toBe(0.005);
    });

    it("should preserve empty string content for result when output is empty", () => {
      const event: ResultEvent = {
        type: "result",
        timestamp: 1700000010,
        success: true,
        output: "",
      };

      const node = createNodeFromEvent(event, 61);

      // ?? only catches null/undefined, consistent with complete event behavior
      expect(node!.content).toBe("");
    });

    it("should create node for input_request", () => {
      const event: InputRequestEvent = {
        type: "input_request",
        timestamp: 1700000020,
        request_id: "req-001",
        tool_use_id: "toolu_ask",
        questions: [
          {
            question: "Which database should we use?",
            options: [
              { label: "PostgreSQL", description: "Relational DB" },
              { label: "MongoDB", description: "Document DB" },
            ],
          },
        ],
        parent_event_id: "toolu_parent",
      };

      const node = createNodeFromEvent(event, 70);

      expect(node).not.toBeNull();
      expect(node!.id).toBe("input-request-70");
      expect(node!.type).toBe("input_request");
      expect(node!.content).toBe("Which database should we use?");
      expect(node!.completed).toBe(false);
      expect(node!.parentEventId).toBe("toolu_parent");
      expect(node!.timestamp).toBe(1700000020);
      const irNode = node as InputRequestNodeDef;
      expect(irNode.requestId).toBe("req-001");
      expect(irNode.toolUseId).toBe("toolu_ask");
      expect(irNode.questions).toHaveLength(1);
      expect(irNode.responded).toBe(false);
    });

    it("should use fallback content when input_request has no questions", () => {
      const event: InputRequestEvent = {
        type: "input_request",
        timestamp: 1700000021,
        request_id: "req-002",
        questions: [],
      };

      const node = createNodeFromEvent(event, 71);

      expect(node).not.toBeNull();
      expect(node!.content).toBe("Input requested");
    });
  });

  describe("update events (returns null)", () => {
    it("should return null for session", () => {
      const event: SessionEvent = { type: "session", session_id: "sess-1" };
      expect(createNodeFromEvent(event, 1)).toBeNull();
    });

    it("should return null for text_start", () => {
      const event: TextStartEvent = { type: "text_start", timestamp: 0 };
      expect(createNodeFromEvent(event, 2)).toBeNull();
    });

    it("should return null for text_delta", () => {
      const event: TextDeltaEvent = { type: "text_delta", timestamp: 0, text: "hi" };
      expect(createNodeFromEvent(event, 3)).toBeNull();
    });

    it("should return null for text_end", () => {
      const event: TextEndEvent = { type: "text_end", timestamp: 0 };
      expect(createNodeFromEvent(event, 4)).toBeNull();
    });

    it("should return null for tool_result", () => {
      const event: ToolResultEvent = {
        type: "tool_result",
        timestamp: 0,
        tool_name: "Bash",
        result: "ok",
        is_error: false,
      };
      expect(createNodeFromEvent(event, 5)).toBeNull();
    });

    it("should return null for subagent_stop", () => {
      const event: SubagentStopEvent = {
        type: "subagent_stop",
        timestamp: 0,
        agent_id: "agent-1",
      };
      expect(createNodeFromEvent(event, 6)).toBeNull();
    });

    it("should return null for progress", () => {
      const event: ProgressEvent = { type: "progress", text: "loading" };
      expect(createNodeFromEvent(event, 7)).toBeNull();
    });

    it("should return null for memory", () => {
      const event: MemoryEvent = {
        type: "memory",
        used_gb: 1,
        total_gb: 8,
        percent: 12.5,
      };
      expect(createNodeFromEvent(event, 8)).toBeNull();
    });
  });
});

// === applyUpdate ===

describe("applyUpdate", () => {
  describe("session event", () => {
    it("should set sessionId and content on root", () => {
      const { ctx, root } = makeCtxWithRoot();
      const event: SessionEvent = { type: "session", session_id: "sess-abc" };

      const changed = applyUpdate(event, 1, ctx, root);

      expect(changed).toBe(true);
      expect((root as SessionNode).sessionId).toBe("sess-abc");
      expect(root.content).toBe("sess-abc");
    });

    it("should return false when root is null", () => {
      const ctx = createProcessingContext();
      const event: SessionEvent = { type: "session", session_id: "sess-abc" };

      const changed = applyUpdate(event, 1, ctx, null);

      expect(changed).toBe(false);
    });
  });

  describe("text lifecycle (text_delta / text_end)", () => {
    // text_start tests are in tree-placer.test.ts (handleTextStart)

    describe("text_delta", () => {
      it("should append to text node's content", () => {
        const { ctx, root } = makeCtxWithRoot();
        const textNode = makeNode("text-1", "text", "");
        ctx.activeTextTarget = textNode as TextNode;

        const event1: TextDeltaEvent = { type: "text_delta", timestamp: 0, text: "Hello " };
        const changed1 = applyUpdate(event1, 20, ctx, root);
        expect(changed1).toBe(true);
        expect(textNode.content).toBe("Hello ");

        const event2: TextDeltaEvent = { type: "text_delta", timestamp: 0, text: "world" };
        applyUpdate(event2, 21, ctx, root);
        expect(textNode.content).toBe("Hello world");
      });

      it("should return false when no activeTextTarget", () => {
        const { ctx, root } = makeCtxWithRoot();

        const event: TextDeltaEvent = { type: "text_delta", timestamp: 0, text: "lost" };
        const changed = applyUpdate(event, 23, ctx, root);

        expect(changed).toBe(false);
      });
    });

    describe("text_end", () => {
      it("should mark text target as both textCompleted and completed", () => {
        const { ctx, root } = makeCtxWithRoot();
        const textNode = makeNode("text-1", "text", "content");
        ctx.activeTextTarget = textNode as TextNode;

        const event: TextEndEvent = { type: "text_end", timestamp: 0 };
        const changed = applyUpdate(event, 30, ctx, root);

        expect(changed).toBe(true);
        expect((textNode as TextNode).textCompleted).toBe(true);
        expect(textNode.completed).toBe(true);
        expect(ctx.activeTextTarget).toBeNull();
      });

      it("should return false when no activeTextTarget", () => {
        const { ctx, root } = makeCtxWithRoot();

        const event: TextEndEvent = { type: "text_end", timestamp: 0 };
        const changed = applyUpdate(event, 32, ctx, root);

        expect(changed).toBe(false);
      });
    });
  });

  describe("tool_result", () => {
    it("should update matching tool node with result, isError, completed", () => {
      const { ctx, root } = makeCtxWithRoot();
      const toolNode = makeNode("tool-1", "tool", "", {
        toolUseId: "toolu_abc",
        timestamp: 1700000000,
      });
      registerNode(ctx, toolNode);
      ctx.nodeMap.set("toolu_abc", toolNode);

      const event: ToolResultEvent = {
        type: "tool_result",
        timestamp: 1700000002,
        tool_name: "Bash",
        result: "success output",
        is_error: false,
        tool_use_id: "toolu_abc",
      };

      const changed = applyUpdate(event, 40, ctx, root);

      expect(changed).toBe(true);
      expect((toolNode as ToolNode).toolResult).toBe("success output");
      expect((toolNode as ToolNode).isError).toBe(false);
      expect(toolNode.completed).toBe(true);
      expect((toolNode as ToolNode).durationMs).toBe(2000); // (2) * 1000
    });

    it("should set isError=true for error results", () => {
      const { ctx, root } = makeCtxWithRoot();
      const toolNode = makeNode("tool-2", "tool", "", {
        toolUseId: "toolu_err",
        timestamp: 1700000000,
      });
      ctx.nodeMap.set("toolu_err", toolNode);

      const event: ToolResultEvent = {
        type: "tool_result",
        timestamp: 1700000001,
        tool_name: "Bash",
        result: "command failed",
        is_error: true,
        tool_use_id: "toolu_err",
      };

      applyUpdate(event, 41, ctx, root);

      expect((toolNode as ToolNode).isError).toBe(true);
    });

    it("should return false when tool_use_id has no match", () => {
      const { ctx, root } = makeCtxWithRoot();

      const event: ToolResultEvent = {
        type: "tool_result",
        timestamp: 0,
        tool_name: "Read",
        result: "orphan",
        is_error: false,
        tool_use_id: "toolu_nonexistent",
      };

      const changed = applyUpdate(event, 42, ctx, root);

      expect(changed).toBe(false);
    });

    it("should return false when tool_use_id is undefined", () => {
      const { ctx, root } = makeCtxWithRoot();

      const event: ToolResultEvent = {
        type: "tool_result",
        timestamp: 0,
        tool_name: "Read",
        result: "no id",
        is_error: false,
      };

      const changed = applyUpdate(event, 43, ctx, root);

      expect(changed).toBe(false);
    });

    it("should not compute durationMs when timestamps are missing", () => {
      const { ctx, root } = makeCtxWithRoot();
      const toolNode = makeNode("tool-3", "tool", "", {
        toolUseId: "toolu_notime",
      });
      ctx.nodeMap.set("toolu_notime", toolNode);

      const event: ToolResultEvent = {
        type: "tool_result",
        timestamp: 1700000005,
        tool_name: "Bash",
        result: "ok",
        is_error: false,
        tool_use_id: "toolu_notime",
      };

      applyUpdate(event, 44, ctx, root);

      // toolNode.timestamp is undefined, so durationMs should not be set
      expect((toolNode as ToolNode).durationMs).toBeUndefined();
    });
  });

  describe("subagent_stop (R4: ignored)", () => {
    it("should always return false (subagent_stop is ignored)", () => {
      const { ctx, root } = makeCtxWithRoot();

      const event: SubagentStopEvent = {
        type: "subagent_stop",
        timestamp: 0,
        agent_id: "agent-1",
      };

      const changed = applyUpdate(event, 50, ctx, root);

      expect(changed).toBe(false);
    });
  });

  describe("unhandled event types", () => {
    it("should return false for progress event", () => {
      const { ctx, root } = makeCtxWithRoot();
      const event: ProgressEvent = { type: "progress", text: "loading" };

      const changed = applyUpdate(event, 99, ctx, root);

      expect(changed).toBe(false);
    });
  });
});
