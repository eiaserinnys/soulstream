/**
 * session-updater 테스트
 *
 * shouldNotify와 deriveSessionStatus의 이벤트 타입별 반환값을 검증합니다.
 */

import { describe, it, expect } from "vitest";
import { shouldNotify, deriveSessionStatus } from "./session-updater";
import type {
  SoulSSEEvent,
  CompleteEvent,
  ErrorEvent,
  InterventionSentEvent,
  UserMessageEvent,
  SessionEvent,
  ThinkingEvent,
  TextStartEvent,
  TextDeltaEvent,
  TextEndEvent,
  ToolStartEvent,
  ToolResultEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  ResultEvent,
  ProgressEvent,
  MemoryEvent,
  DebugEvent,
} from "../../shared/types";

// === shouldNotify ===

describe("shouldNotify", () => {
  describe("events that should trigger notification", () => {
    it("should return true for complete", () => {
      const event: CompleteEvent = {
        type: "complete",
        result: "done",
        attachments: [],
      };
      expect(shouldNotify(event)).toBe(true);
    });

    it("should return true for error", () => {
      const event: ErrorEvent = {
        type: "error",
        message: "something broke",
      };
      expect(shouldNotify(event)).toBe(true);
    });

    it("should return true for intervention_sent", () => {
      const event: InterventionSentEvent = {
        type: "intervention_sent",
        user: "alice",
        text: "stop",
      };
      expect(shouldNotify(event)).toBe(true);
    });
  });

  describe("events that should NOT trigger notification", () => {
    it("should return false for user_message", () => {
      const event: UserMessageEvent = {
        type: "user_message",
        user: "alice",
        text: "hello",
      };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for session", () => {
      const event: SessionEvent = { type: "session", session_id: "s1" };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for thinking", () => {
      const event: ThinkingEvent = {
        type: "thinking",
        timestamp: 0,
        thinking: "hmm",
      };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for text_start", () => {
      const event: TextStartEvent = { type: "text_start", timestamp: 0 };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for text_delta", () => {
      const event: TextDeltaEvent = {
        type: "text_delta",
        timestamp: 0,
        text: "hi",
      };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for text_end", () => {
      const event: TextEndEvent = { type: "text_end", timestamp: 0 };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for tool_start", () => {
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: {},
      };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for tool_result", () => {
      const event: ToolResultEvent = {
        type: "tool_result",
        timestamp: 0,
        tool_name: "Bash",
        result: "ok",
        is_error: false,
      };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for subagent_start", () => {
      const event: SubagentStartEvent = {
        type: "subagent_start",
        timestamp: 0,
        agent_id: "a1",
        agent_type: "task",
        parent_event_id: "toolu_1",
      };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for subagent_stop", () => {
      const event: SubagentStopEvent = {
        type: "subagent_stop",
        timestamp: 0,
        agent_id: "a1",
      };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for result", () => {
      const event: ResultEvent = {
        type: "result",
        timestamp: 0,
        success: true,
        output: "done",
      };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for progress", () => {
      const event: ProgressEvent = { type: "progress", text: "loading" };
      expect(shouldNotify(event)).toBe(false);
    });

    it("should return false for memory", () => {
      const event: MemoryEvent = {
        type: "memory",
        used_gb: 2,
        total_gb: 8,
        percent: 25,
      };
      expect(shouldNotify(event)).toBe(false);
    });
  });
});

// === deriveSessionStatus ===

describe("deriveSessionStatus", () => {
  describe("events that derive 'completed'", () => {
    it("should return 'completed' for complete event", () => {
      const event: CompleteEvent = {
        type: "complete",
        result: "done",
        attachments: [],
      };
      expect(deriveSessionStatus(event)).toBe("completed");
    });

    it("should return 'completed' for result event", () => {
      const event: ResultEvent = {
        type: "result",
        timestamp: 0,
        success: true,
        output: "finished",
      };
      expect(deriveSessionStatus(event)).toBe("completed");
    });
  });

  describe("events that derive 'error'", () => {
    it("should return 'error' for error event", () => {
      const event: ErrorEvent = {
        type: "error",
        message: "crash",
      };
      expect(deriveSessionStatus(event)).toBe("error");
    });
  });

  describe("events that derive 'running'", () => {
    it("should return 'running' for user_message", () => {
      const event: UserMessageEvent = {
        type: "user_message",
        user: "alice",
        text: "go",
      };
      expect(deriveSessionStatus(event)).toBe("running");
    });

    it("should return 'running' for intervention_sent", () => {
      const event: InterventionSentEvent = {
        type: "intervention_sent",
        user: "bob",
        text: "resume",
      };
      expect(deriveSessionStatus(event)).toBe("running");
    });
  });

  describe("events that derive null (no status change)", () => {
    it("should return null for session", () => {
      const event: SessionEvent = { type: "session", session_id: "s1" };
      expect(deriveSessionStatus(event)).toBeNull();
    });

    it("should return null for thinking", () => {
      const event: ThinkingEvent = {
        type: "thinking",
        timestamp: 0,
        thinking: "...",
      };
      expect(deriveSessionStatus(event)).toBeNull();
    });

    it("should return null for text_start", () => {
      const event: TextStartEvent = { type: "text_start", timestamp: 0 };
      expect(deriveSessionStatus(event)).toBeNull();
    });

    it("should return null for text_delta", () => {
      const event: TextDeltaEvent = {
        type: "text_delta",
        timestamp: 0,
        text: "x",
      };
      expect(deriveSessionStatus(event)).toBeNull();
    });

    it("should return null for text_end", () => {
      const event: TextEndEvent = { type: "text_end", timestamp: 0 };
      expect(deriveSessionStatus(event)).toBeNull();
    });

    it("should return null for tool_start", () => {
      const event: ToolStartEvent = {
        type: "tool_start",
        timestamp: 0,
        tool_name: "Bash",
        tool_input: {},
      };
      expect(deriveSessionStatus(event)).toBeNull();
    });

    it("should return null for tool_result", () => {
      const event: ToolResultEvent = {
        type: "tool_result",
        timestamp: 0,
        tool_name: "Bash",
        result: "ok",
        is_error: false,
      };
      expect(deriveSessionStatus(event)).toBeNull();
    });

    it("should return null for subagent_start", () => {
      const event: SubagentStartEvent = {
        type: "subagent_start",
        timestamp: 0,
        agent_id: "a1",
        agent_type: "task",
        parent_event_id: "toolu_1",
      };
      expect(deriveSessionStatus(event)).toBeNull();
    });

    it("should return null for subagent_stop", () => {
      const event: SubagentStopEvent = {
        type: "subagent_stop",
        timestamp: 0,
        agent_id: "a1",
      };
      expect(deriveSessionStatus(event)).toBeNull();
    });

    it("should return null for progress", () => {
      const event: ProgressEvent = { type: "progress", text: "loading" };
      expect(deriveSessionStatus(event)).toBeNull();
    });

    it("should return null for memory", () => {
      const event: MemoryEvent = {
        type: "memory",
        used_gb: 2,
        total_gb: 8,
        percent: 25,
      };
      expect(deriveSessionStatus(event)).toBeNull();
    });

    it("should return null for debug", () => {
      const event: DebugEvent = { type: "debug", message: "info" };
      expect(deriveSessionStatus(event)).toBeNull();
    });
  });
});
