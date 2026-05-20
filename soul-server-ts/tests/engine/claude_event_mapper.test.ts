import { describe, expect, it } from "vitest";

import {
  mapClaudeClientEvent,
  type ClaudeClientEvent,
} from "../../src/engine/claude_event_mapper.js";

function eventTypes(events: ReturnType<typeof mapClaudeClientEvent>): string[] {
  return events.map((event) => event.type);
}

describe("Claude event mapper parity with Python EngineEvent.to_sse", () => {
  it("session carries backend session id without timestamp", () => {
    expect(mapClaudeClientEvent({ type: "session", sessionId: "claude-sess-1" })).toEqual([
      { type: "session", session_id: "claude-sess-1" },
    ]);
  });

  it("debug maps Python DebugEvent fields for SDK Notification hooks", () => {
    expect(
      mapClaudeClientEvent({
        type: "debug",
        message: "[info] notification",
        timestamp: 122,
      })[0],
    ).toEqual({
      type: "debug",
      message: "[info] notification",
      timestamp: 122,
    });
  });

  it("Python TextDeltaEngineEvent cardinality: one text client event emits text_start → text_delta → text_end", () => {
    const events = mapClaudeClientEvent({
      type: "text",
      text: "Hello Claude",
      timestamp: 123,
    });

    expect(eventTypes(events)).toEqual(["text_start", "text_delta", "text_end"]);
    expect(events[0]).toEqual({ type: "text_start", timestamp: 123 });
    expect(events[1]).toEqual({ type: "text_delta", text: "Hello Claude", timestamp: 123 });
    expect(events[2]).toEqual({ type: "text_end", timestamp: 123 });
  });

  it("thinking preserves thinking text and signature", () => {
    expect(
      mapClaudeClientEvent({
        type: "thinking",
        thinking: "considering",
        signature: "sig",
        timestamp: 124,
      })[0],
    ).toEqual({
      type: "thinking",
      thinking: "considering",
      signature: "sig",
      timestamp: 124,
    });
  });

  it("tool_start and tool_result use Python wire keys and stringify non-string tool results", () => {
    expect(
      mapClaudeClientEvent({
        type: "tool_start",
        toolName: "Read",
        toolInput: { file_path: "a.ts" },
        toolUseId: "toolu_1",
        timestamp: 125,
      })[0],
    ).toEqual({
      type: "tool_start",
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
      tool_use_id: "toolu_1",
      timestamp: 125,
    });

    expect(
      mapClaudeClientEvent({
        type: "tool_result",
        toolName: "Read",
        result: { ok: true },
        isError: false,
        toolUseId: "toolu_1",
        timestamp: 126,
      })[0],
    ).toEqual({
      type: "tool_result",
      tool_name: "Read",
      result: "{\"ok\":true}",
      is_error: false,
      tool_use_id: "toolu_1",
      timestamp: 126,
    });
  });

  it("result maps Python ResultEngineEvent fields without collapsing into complete", () => {
    expect(
      mapClaudeClientEvent({
        type: "result",
        success: true,
        output: "final answer",
        usage: { input_tokens: 1, output_tokens: 2 },
        totalCostUsd: 0.01,
        stopReason: "end_turn",
        errors: ["warn"],
        modelUsage: { opus: 1 },
        permissionDenials: ["Bash"],
        timestamp: 127,
      })[0],
    ).toEqual({
      type: "result",
      success: true,
      output: "final answer",
      usage: { input_tokens: 1, output_tokens: 2 },
      total_cost_usd: 0.01,
      stop_reason: "end_turn",
      errors: ["warn"],
      model_usage: { opus: 1 },
      permission_denials: ["Bash"],
      timestamp: 127,
    });
  });

  it("complete uses explicit result first and fallback text only when result is absent", () => {
    expect(
      mapClaudeClientEvent(
        { type: "complete", result: "explicit", timestamp: 128 },
        { fallbackResult: "fallback" },
      )[0],
    ).toEqual({
      type: "complete",
      result: "explicit",
      timestamp: 128,
    });

    expect(
      mapClaudeClientEvent(
        { type: "complete", usage: { input_tokens: 1 }, timestamp: 129 },
        { fallbackResult: "fallback" },
      )[0],
    ).toEqual({
      type: "complete",
      result: "fallback",
      usage: { input_tokens: 1 },
      timestamp: 129,
    });
  });

  it("error maps fatal flag and does not synthesize complete", () => {
    expect(
      mapClaudeClientEvent({
        type: "error",
        message: "boom",
        fatal: true,
        timestamp: 130,
      }),
    ).toEqual([{ type: "error", message: "boom", fatal: true, timestamp: 130 }]);
  });

  it("prompt_suggestion is persisted as its own SSE event for chip state", () => {
    expect(
      mapClaudeClientEvent({
        type: "prompt_suggestion",
        text: "Try a follow-up",
        timestamp: 131,
      })[0],
    ).toEqual({
      type: "prompt_suggestion",
      text: "Try a follow-up",
      timestamp: 131,
    });
  });

  it("input_request family preserves Python AskUserQuestion wire keys", () => {
    expect(
      mapClaudeClientEvent({
        type: "input_request",
        requestId: "req-ask-1",
        toolUseId: "toolu_ask",
        questions: [
          {
            question: "배포할까요?",
            header: "확인",
            options: [{ label: "진행", description: "deploy" }],
            multiSelect: false,
          },
        ],
        startedAt: 1779264000,
        timeoutSec: 300,
        timestamp: 136,
      })[0],
    ).toEqual({
      type: "input_request",
      request_id: "req-ask-1",
      tool_use_id: "toolu_ask",
      questions: [
        {
          question: "배포할까요?",
          header: "확인",
          options: [{ label: "진행", description: "deploy" }],
          multiSelect: false,
        },
      ],
      started_at: 1779264000,
      timeout_sec: 300,
      timestamp: 136,
    });

    expect(
      mapClaudeClientEvent({
        type: "input_request_expired",
        requestId: "req-ask-1",
        timestamp: 137,
      })[0],
    ).toEqual({
      type: "input_request_expired",
      request_id: "req-ask-1",
      timestamp: 137,
    });

    expect(
      mapClaudeClientEvent({
        type: "input_request_responded",
        requestId: "req-ask-1",
        timestamp: 138,
      })[0],
    ).toEqual({
      type: "input_request_responded",
      request_id: "req-ask-1",
      timestamp: 138,
    });
  });

  it("rate_limit maps to existing credential_alert SSE wire", () => {
    expect(
      mapClaudeClientEvent({
        type: "rate_limit",
        status: "rate_limited",
        resetsAt: "2026-05-20T09:00:00Z",
        rateLimitType: "five_hour",
        utilization: 0.98,
        timestamp: 132,
      })[0],
    ).toEqual({
      type: "credential_alert",
      status: "rate_limited",
      resets_at: "2026-05-20T09:00:00Z",
      rate_limit_type: "five_hour",
      utilization: 0.98,
      timestamp: 132,
    });
  });

  it("compact is an explicit SSE event, not a silent no-op", () => {
    expect(
      mapClaudeClientEvent({
        type: "compact",
        trigger: "auto",
        message: "context compacted",
        timestamp: 133,
      })[0],
    ).toEqual({
      type: "compact",
      trigger: "auto",
      message: "context compacted",
      timestamp: 133,
    });
  });

  it("assistant_error preserves Python wire keys for dashboard classification (auth/billing/rate_limit)", () => {
    // Python `message_processor._handle_assistant_message` L172-187 + `AssistantErrorEngineEvent`
    // emit `assistant_error` SSE with error_type / model / message_id keys.
    expect(
      mapClaudeClientEvent({
        type: "assistant_error",
        errorType: "authentication_failed",
        model: "claude-sonnet-4-5",
        messageId: "msg_01ABC",
        timestamp: 140,
      })[0],
    ).toEqual({
      type: "assistant_error",
      error_type: "authentication_failed",
      model: "claude-sonnet-4-5",
      message_id: "msg_01ABC",
      timestamp: 140,
    });
  });

  it("assistant_error omits optional model/message_id when not provided", () => {
    expect(
      mapClaudeClientEvent({
        type: "assistant_error",
        errorType: "billing_error",
        timestamp: 141,
      })[0],
    ).toEqual({
      type: "assistant_error",
      error_type: "billing_error",
      timestamp: 141,
    });
  });

  it("away_summary carries content for session-resume UX (Python AwaySummaryEngineEvent parity)", () => {
    expect(
      mapClaudeClientEvent({
        type: "away_summary",
        content: "이전 세션에서 X 작업을 진행했습니다.",
        timestamp: 142,
      })[0],
    ).toEqual({
      type: "away_summary",
      content: "이전 세션에서 X 작업을 진행했습니다.",
      timestamp: 142,
    });
  });

  it("subagent events carry agent_id, not session_id", () => {
    const events = [
      ...mapClaudeClientEvent({
        type: "subagent_start",
        agentId: "sub-1",
        agentType: "explorer",
        timestamp: 134,
      }),
      ...mapClaudeClientEvent({
        type: "subagent_stop",
        agentId: "sub-1",
        timestamp: 135,
      }),
    ];

    expect(events).toEqual([
      {
        type: "subagent_start",
        agent_id: "sub-1",
        agent_type: "explorer",
        timestamp: 134,
      },
      {
        type: "subagent_stop",
        agent_id: "sub-1",
        timestamp: 135,
      },
    ]);
    for (const event of events) {
      expect(event as Record<string, unknown>).not.toHaveProperty("session_id");
    }
  });

  it("golden fixture covers all P3 parity event families", () => {
    const fixture: ClaudeClientEvent[] = [
      { type: "session", sessionId: "claude-sess-1" },
      { type: "debug", message: "notification", timestamp: 0.5 },
      { type: "text", text: "A", timestamp: 1 },
      { type: "tool_start", toolName: "Bash", toolInput: {}, timestamp: 2 },
      { type: "tool_result", toolName: "Bash", result: "ok", timestamp: 3 },
      { type: "thinking", thinking: "hmm", timestamp: 4 },
      { type: "result", success: true, output: "A", timestamp: 5 },
      { type: "input_request", requestId: "ask-1", questions: [], startedAt: 10, timeoutSec: 300, timestamp: 5.5 },
      { type: "input_request_expired", requestId: "ask-1", timestamp: 5.6 },
      { type: "input_request_responded", requestId: "ask-1", timestamp: 5.7 },
      { type: "prompt_suggestion", text: "next", timestamp: 6 },
      { type: "rate_limit", status: "allowed_warning", utilization: 0.9, timestamp: 7 },
      { type: "compact", trigger: "manual", message: "compacted", timestamp: 8 },
      { type: "subagent_start", agentId: "sub", agentType: "worker", timestamp: 9 },
      { type: "subagent_stop", agentId: "sub", timestamp: 10 },
      { type: "complete", result: "A", timestamp: 11 },
      { type: "error", message: "late nonfatal", fatal: false, timestamp: 12 },
    ];

    expect(fixture.flatMap((event) => mapClaudeClientEvent(event)).map((event) => event.type)).toEqual([
      "session",
      "debug",
      "text_start",
      "text_delta",
      "text_end",
      "tool_start",
      "tool_result",
      "thinking",
      "result",
      "input_request",
      "input_request_expired",
      "input_request_responded",
      "prompt_suggestion",
      "credential_alert",
      "compact",
      "subagent_start",
      "subagent_stop",
      "complete",
      "error",
    ]);
  });
});
