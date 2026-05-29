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
  CompleteNode,
  SessionNode,
  TextNode,
  InputRequestEvent,
  InputRequestNodeDef,
  ToolApprovalRequestedEvent,
  ToolApprovalNodeDef,
  SoulSSEEvent,
} from "../shared/types";

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

    it("should extract content from messages when text is absent (LLM session)", () => {
      const event: UserMessageEvent = {
        type: "user_message",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Translate this" },
        ],
        client_id: "translate",
      };

      const node = createNodeFromEvent(event, 2);

      expect(node).not.toBeNull();
      expect(node!.content).toBe("Translate this");
      expect((node as UserMessageNode).user).toBe("translate");
    });

    it("should fallback to 'llm-proxy' when neither user nor client_id exists", () => {
      const event: UserMessageEvent = {
        type: "user_message",
        messages: [{ role: "user", content: "Hello" }],
      };

      const node = createNodeFromEvent(event, 3);

      expect(node).not.toBeNull();
      expect((node as UserMessageNode).user).toBe("llm-proxy");
    });

    it("should return empty content when messages has no user role", () => {
      const event: UserMessageEvent = {
        type: "user_message",
        messages: [{ role: "system", content: "You are helpful." }],
      };

      const node = createNodeFromEvent(event, 4);

      expect(node).not.toBeNull();
      expect(node!.content).toBe("");
    });

    // === caller_info nested → agentInfo + callerInfo (atom ed3a216d) ===

    it("user_message with nested caller_info source=agent → agentInfo + callerInfo set", () => {
      const event = {
        type: "user_message",
        text: "delegated prompt",
        caller_info: {
          source: "agent",
          display_name: "shay",
          user_id: "shay",
          avatar_url: "/api/agents/shay/portrait",
          agent_node: "eiaserinnys",
          agent_id: "shay",
          agent_name: "Shay",
        },
      } as unknown as UserMessageEvent;

      const node = createNodeFromEvent(event, 100);

      expect(node).not.toBeNull();
      const u = node as UserMessageNode;
      expect(u.agentInfo).toEqual({
        source: "agent",
        agent_node: "eiaserinnys",
        agent_id: "shay",
        agent_name: "Shay",
      });
      expect(u.callerInfo).toBeDefined();
      expect(u.callerInfo?.source).toBe("agent");
      expect(u.callerInfo?.avatar_url).toBe("/api/agents/shay/portrait");
    });

    it("user_message with nested caller_info source=browser → callerInfo only, agentInfo undefined", () => {
      const event = {
        type: "user_message",
        text: "google user prompt",
        caller_info: {
          source: "browser",
          display_name: "Jubok",
          avatar_url: "https://lh3.googleusercontent.com/a/X",
        },
      } as unknown as UserMessageEvent;

      const node = createNodeFromEvent(event, 101);

      const u = node as UserMessageNode;
      expect(u.agentInfo).toBeUndefined();
      expect(u.callerInfo?.source).toBe("browser");
      expect(u.callerInfo?.avatar_url).toBe("https://lh3.googleusercontent.com/a/X");
    });

    it("user_message with nested caller_info source=slack → callerInfo only", () => {
      const event = {
        type: "user_message",
        text: "slack channel observer",
        caller_info: {
          source: "slack",
          display_name: "@channel-user",
          avatar_url: "https://avatars.slack-edge.com/2024/img_192.png",
          slack: { channel_id: "C08", user_id: "U08" },
        },
      } as unknown as UserMessageEvent;

      const node = createNodeFromEvent(event, 102);

      const u = node as UserMessageNode;
      expect(u.agentInfo).toBeUndefined();
      expect(u.callerInfo?.source).toBe("slack");
    });

    it("user_message with legacy top-level source=agent (no caller_info) → agentInfo set, callerInfo undefined", () => {
      // Phase 3 이전 데이터 호환 (atom ed3a216d 도입 전 형식).
      const event = {
        type: "user_message",
        text: "legacy agent message",
        source: "agent",
        agent_node: "node-x",
        agent_id: "alpha",
        agent_name: "Alpha",
      } as unknown as UserMessageEvent;

      const node = createNodeFromEvent(event, 103);

      const u = node as UserMessageNode;
      expect(u.agentInfo).toEqual({
        source: "agent",
        agent_node: "node-x",
        agent_id: "alpha",
        agent_name: "Alpha",
      });
      expect(u.callerInfo).toBeUndefined();
    });

    it("user_message with no caller_info and no top-level source → both undefined", () => {
      const event: UserMessageEvent = {
        type: "user_message",
        text: "plain user prompt",
      };

      const node = createNodeFromEvent(event, 104);

      const u = node as UserMessageNode;
      expect(u.agentInfo).toBeUndefined();
      expect(u.callerInfo).toBeUndefined();
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
      // F-9 fix: caller_info 부재 시 callerInfo/agentInfo 모두 undefined
      expect((node as InterventionNode).callerInfo).toBeUndefined();
      expect((node as InterventionNode).agentInfo).toBeUndefined();
    });

    it("should attach callerInfo from intervention_sent.caller_info (F-9 fix)", () => {
      // 슬랙 발신자 케이스 — 2차+ 메시지가 InterventionSentEvent로 운반됨
      const event: InterventionSentEvent = {
        type: "intervention_sent",
        user: "U_SLACK",
        text: "추가 질문",
        caller_info: {
          source: "slack",
          display_name: "동료 사용자",
          avatar_url: "https://example.com/slack.png",
          user_id: "U_SLACK",
          slack: { channel_id: "C123", thread_ts: "1234.5", user_id: "U_SLACK" },
        },
      };

      const node = createNodeFromEvent(event, 6);
      const n = node as InterventionNode;
      expect(n.callerInfo).toEqual(event.caller_info);
      expect(n.agentInfo).toBeUndefined();  // source=slack은 agent 분기 미해당
    });

    it("should derive agentInfo from intervention_sent.caller_info (F-9 fix, agent source)", () => {
      const event: InterventionSentEvent = {
        type: "intervention_sent",
        user: "agent",
        text: "위임 후속",
        caller_info: {
          source: "agent",
          agent_node: "node-a",
          agent_id: "agent-x",
          agent_name: "Roselin",
          display_name: "Roselin",
          avatar_url: "/api/nodes/node-a/agents/agent-x/portrait",
        },
      };

      const node = createNodeFromEvent(event, 7);
      const n = node as InterventionNode;
      expect(n.callerInfo).toEqual(event.caller_info);
      expect(n.agentInfo).toEqual({
        source: "agent",
        agent_node: "node-a",
        agent_id: "agent-x",
        agent_name: "Roselin",
      });
    });

    it("T-5 (Phase A): intervention_sent.context를 노드에 박음 (atom d7a1ad86 차단)", () => {
      // Phase A context 정본 (Y-7): user_message 분기와 대칭으로 e.context를 노드에 박는다.
      // 본 사이클 이전엔 intervention_sent 분기에 context 박지 않아 Python 측이 보낸 context가
      // 트리 노드에 도달하지 않음 — flatten-tree forward도 막힘.
      const ctxItems = [
        { key: "soulstream_session", label: "Soulstream", content: { folder: "X" } },
      ];
      const event: InterventionSentEvent = {
        type: "intervention_sent",
        user: "u",
        text: "context 운반 intervention",
        context: ctxItems,
      };
      const node = createNodeFromEvent(event, 8);
      const n = node as InterventionNode;
      expect(n.context).toEqual(ctxItems);
    });

    it("T-5b: intervention_sent.context 부재 시 노드 context 도 undefined (회귀 보호)", () => {
      const event: InterventionSentEvent = {
        type: "intervention_sent",
        user: "u",
        text: "context 없는 intervention",
      };
      const node = createNodeFromEvent(event, 9);
      const n = node as InterventionNode;
      expect(n.context).toBeUndefined();
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

    it("should create node for Codex thinking text payload", () => {
      const event: ThinkingEvent = {
        type: "thinking",
        timestamp: 1700000000,
        text: "Inspect the adapter.",
      };

      const node = createNodeFromEvent(event, 11);

      expect(node).not.toBeNull();
      expect(node!.id).toBe("thinking-11");
      expect(node!.type).toBe("thinking");
      expect(node!.content).toBe("Inspect the adapter.");
      expect(node!.completed).toBe(true);
    });

    it("should return null for empty placeholder thinking", () => {
      for (const text of ["", "   ", "...", "{}", "[]"]) {
        const event: ThinkingEvent = {
          type: "thinking",
          timestamp: 1700000000,
          text,
        };

        expect(createNodeFromEvent(event, 12)).toBeNull();
      }
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

    it("should return null for Claude runtime status and signal events (state-only)", () => {
      const events = [
        {
          type: "claude_runtime_task_started",
          task_id: "task-bg-1",
          description: "background task",
          timestamp: 1700000000,
        },
        {
          type: "claude_runtime_notification",
          notification_id: "notif-1",
          source: "hook",
          message: "runtime notification",
          timestamp: 1700000001,
        },
        {
          type: "claude_runtime_remote_trigger",
          trigger_id: "trigger-1",
          source: "message_origin",
          timestamp: 1700000002,
        },
        {
          type: "claude_runtime_transcript_mirror_error",
          error: "cannot extract elements from a scalar",
          timestamp: 1700000003,
        },
      ];

      for (const [index, event] of events.entries()) {
        expect(createNodeFromEvent(event as SoulSSEEvent, 21 + index)).toBeNull();
      }
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
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cached_input_tokens: 25,
          reasoning_output_tokens: 10,
        },
        total_cost_usd: 0.0042,
      };

      const node = createNodeFromEvent(event, 40);

      expect(node).not.toBeNull();
      expect(node!.id).toBe("complete-40");
      expect(node!.type).toBe("complete");
      expect(node!.content).toBe("All done!");
      expect(node!.completed).toBe(true);
      expect((node as CompleteNode).usage).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cached_input_tokens: 25,
        reasoning_output_tokens: 10,
      });
      expect((node as CompleteNode).totalCostUsd).toBe(0.0042);
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
        started_at: 1700000020,
        timeout_sec: 300,
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
        started_at: 1700000021,
        timeout_sec: 300,
        questions: [],
      };

      const node = createNodeFromEvent(event, 71);

      expect(node).not.toBeNull();
      expect(node!.content).toBe("Input requested");
    });

    it("should create node for tool_approval_requested", () => {
      const event: ToolApprovalRequestedEvent = {
        type: "tool_approval_requested",
        timestamp: 1700000022,
        approval_id: "danger-call-1",
        tool_use_id: "danger-call-1",
        tool_name: "drop_rows",
        tool_input: { table: "events" },
        agent_name: "Database specialist",
      };

      const node = createNodeFromEvent(event, 72);

      expect(node).not.toBeNull();
      expect(node!.id).toBe("tool-approval-72");
      expect(node!.type).toBe("tool_approval");
      const approval = node as ToolApprovalNodeDef;
      expect(approval.approvalId).toBe("danger-call-1");
      expect(approval.toolName).toBe("drop_rows");
      expect(approval.toolInput).toEqual({ table: "events" });
      expect(approval.resolved).toBe(false);
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
