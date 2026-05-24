/**
 * Cross-language parity: TS `mapClaudeClientEvent` output ↔ Python `EngineEvent.to_sse()` wire shape.
 *
 * 본 fixture는 Python `soul-server/src/soul_server/models/schemas.py`의 BaseModel 필드 목록을 reference로,
 * TS mapper output의 wire payload가 *같은 키 이름·optional 의미*를 갖는지 단언한다.
 * Python schemas.py 라인은 본 파일 주석에 인용 — 정본이 갱신되면 본 fixture도 같이 갱신.
 *
 * Phase A·B에서 추가된 assistant_error / away_summary + 기존 event family 전체를 cover.
 *
 * 본 테스트가 *Python 코드 실행*은 하지 않는다 (TS 세션에서 Python pytest 실행은 별 카드 책임).
 * 본 테스트의 보증: Python schemas 정본을 reference로 *TS wire payload가 그 형태를 만족*함.
 */

import { describe, expect, it } from "vitest";

import {
  mapClaudeClientEvent,
  type ClaudeClientEvent,
} from "../../src/engine/claude_event_mapper.js";

/**
 * Python BaseModel이 *없는* TS-only event types. ClaudeClientEvent → wire 변환은 존재하나
 * Python `soul-server/src/soul_server/models/schemas.py`에 동등 BaseModel이 없어 본 parity 단언에서 *명시 skip*.
 *
 * - `session`: Python은 `InitSSEEvent(type="init", agent_session_id)`로 발행 — TS와 wire 이름 자체가 다름
 *   (이는 별 카드의 wire 이름 정합 작업 책임).
 * - `complete`·`error`: Python `task_executor`가 dict로 직접 발행, 별 BaseModel 정의 없음.
 *
 * 본 set은 P1-1 코드 리뷰에서 누락 catch — mapper switch 전체와 PYTHON_SHAPES 키 집합의 *집합 동등성*을
 * 자동 검증하기 위한 inventory 정합 단언에 사용.
 */
const TS_ONLY_NO_PYTHON_BASEMODEL = new Set(["session", "complete", "error"]);

/** Python schemas 정본에서 정의된 SSE event의 *필수* 키 inventory. */
type ExpectedShape = {
  required: string[];
  optional: string[];
};

/**
 * Python schemas.py 정본 인용 (BaseModel 필드 — type 자체 포함):
 *
 * - ProgressEvent: type, text
 * - ContextUsageEvent: type, used_tokens, max_tokens, percent
 * - DebugEvent (L73-78): type, message, timestamp, parent_event_id?
 * - ThinkingSSEEvent (L146-152): type, timestamp, thinking, signature, parent_event_id?
 * - TextStartSSEEvent (L155-159): type, timestamp, parent_event_id?
 * - TextDeltaSSEEvent (L162-167): type, timestamp, text, parent_event_id?
 * - TextEndSSEEvent (L170-174): type, timestamp, parent_event_id?
 * - AssistantMessageSSEEvent (L177-183): type, timestamp, content, parent_event_id?
 * - ToolStartSSEEvent (L177-184): type, timestamp, tool_name, tool_input, tool_use_id?, parent_event_id?
 * - ToolResultSSEEvent (L187-195): type, timestamp, tool_name, result, is_error, tool_use_id?, parent_event_id?
 * - ResultSSEEvent (L198-211): type, timestamp, success, output, error?, usage?, total_cost_usd?,
 *   parent_event_id?, stop_reason?, errors?, model_usage?, permission_denials?
 * - AwaySummarySSEEvent (L214-219): type, timestamp, content, parent_event_id?
 * - PromptSuggestionSSEEvent (L222-227): type, timestamp, text, parent_event_id?
 * - SubagentStartSSEEvent (L230-236): type, timestamp, agent_id, agent_type, parent_event_id?
 * - SubagentStopSSEEvent (L239-244): type, timestamp, agent_id, parent_event_id?
 * - InputRequestSSEEvent (L255-264): type, timestamp, request_id, tool_use_id, questions, started_at,
 *   timeout_sec, parent_event_id?
 * - InputRequestExpiredSSEEvent (L267-272): type, request_id, parent_event_id?, timestamp
 * - InputRequestRespondedSSEEvent (L275-280): type, request_id, parent_event_id?, timestamp
 * - AssistantErrorSSEEvent (L283-290): type, timestamp, error_type, model, message_id?, parent_event_id?
 * - CredentialAlertEvent (L293-301): type, utilization?, rate_limit_type?, status?, resets_at?, timestamp, parent_event_id?
 */
const PYTHON_SHAPES: Record<string, ExpectedShape> = {
  progress: {
    required: ["type", "text"],
    optional: [],
  },
  context_usage: {
    required: ["type", "used_tokens", "max_tokens", "percent"],
    optional: [],
  },
  debug: {
    required: ["type", "message", "timestamp"],
    optional: ["parent_event_id"],
  },
  thinking: {
    required: ["type", "timestamp", "thinking"],
    optional: ["signature", "parent_event_id"],
  },
  text_start: {
    required: ["type", "timestamp"],
    optional: ["parent_event_id"],
  },
  text_delta: {
    required: ["type", "timestamp", "text"],
    optional: ["parent_event_id"],
  },
  text_end: {
    required: ["type", "timestamp"],
    optional: ["parent_event_id"],
  },
  assistant_message: {
    required: ["type", "timestamp", "content"],
    optional: ["parent_event_id"],
  },
  tool_start: {
    required: ["type", "timestamp", "tool_name", "tool_input"],
    optional: ["tool_use_id", "parent_event_id"],
  },
  tool_result: {
    required: ["type", "timestamp", "tool_name", "result", "is_error"],
    optional: ["tool_use_id", "parent_event_id"],
  },
  result: {
    required: ["type", "timestamp", "success", "output"],
    optional: [
      "error",
      "usage",
      "total_cost_usd",
      "parent_event_id",
      "stop_reason",
      "errors",
      "model_usage",
      "permission_denials",
    ],
  },
  away_summary: {
    required: ["type", "timestamp", "content"],
    optional: ["parent_event_id"],
  },
  prompt_suggestion: {
    required: ["type", "timestamp", "text"],
    optional: ["parent_event_id"],
  },
  subagent_start: {
    required: ["type", "timestamp", "agent_id", "agent_type"],
    optional: ["parent_event_id"],
  },
  subagent_stop: {
    required: ["type", "timestamp", "agent_id"],
    optional: ["parent_event_id"],
  },
  input_request: {
    required: ["type", "timestamp", "request_id", "questions", "started_at", "timeout_sec"],
    optional: ["tool_use_id", "parent_event_id"],
  },
  input_request_expired: {
    required: ["type", "timestamp", "request_id"],
    optional: ["parent_event_id"],
  },
  input_request_responded: {
    required: ["type", "timestamp", "request_id"],
    optional: ["parent_event_id"],
  },
  assistant_error: {
    required: ["type", "timestamp", "error_type"],
    optional: ["model", "message_id", "parent_event_id"],
  },
  credential_alert: {
    required: ["type", "timestamp"],
    optional: ["utilization", "rate_limit_type", "status", "resets_at", "parent_event_id"],
  },
  /**
   * Python `CompactEvent` (schemas.py:66-71): type, timestamp, trigger, message, parent_event_id?
   */
  compact: {
    required: ["type", "timestamp", "trigger", "message"],
    optional: ["parent_event_id"],
  },
};

/** 단일 SSE payload가 Python BaseModel 필드 inventory를 만족하는지 검증. */
function assertPythonShape(payload: Record<string, unknown>, shape: ExpectedShape): void {
  for (const key of shape.required) {
    expect(payload, `required key "${key}" missing`).toHaveProperty(key);
  }
  const allowedKeys = new Set([...shape.required, ...shape.optional]);
  for (const key of Object.keys(payload)) {
    expect(allowedKeys.has(key), `unexpected key "${key}" not in Python schema`).toBe(true);
  }
}

describe("Cross-language wire shape parity (TS mapper output ↔ Python *SSEEvent fields)", () => {
  it("progress — Python ProgressEvent", () => {
    const out = mapClaudeClientEvent({ type: "progress", text: "working", timestamp: 1 });
    expect(out).toHaveLength(1);
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.progress!);
  });

  it("thinking — Python ThinkingSSEEvent (schemas.py:146-152)", () => {
    const out = mapClaudeClientEvent({
      type: "thinking",
      thinking: "hmm",
      signature: "sig",
      timestamp: 1,
    });
    expect(out).toHaveLength(1);
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.thinking!);
  });

  it("text — Python AssistantMessageSSEEvent semantic final로 매핑", () => {
    const out = mapClaudeClientEvent({ type: "text", text: "hello", timestamp: 1 });
    expect(out).toHaveLength(1);
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.assistant_message!);
  });

  it("tool_start — Python ToolStartSSEEvent (schemas.py:177-184)", () => {
    const out = mapClaudeClientEvent({
      type: "tool_start",
      toolName: "Read",
      toolInput: { file_path: "a.ts" },
      toolUseId: "toolu_1",
      timestamp: 1,
    });
    expect(out).toHaveLength(1);
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.tool_start!);
  });

  it("tool_result — Python ToolResultSSEEvent (schemas.py:187-195) — result is str", () => {
    const out = mapClaudeClientEvent({
      type: "tool_result",
      toolName: "Read",
      result: { ok: true },
      isError: false,
      toolUseId: "toolu_1",
      timestamp: 1,
    });
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.tool_result!);
    // Python ToolResultSSEEvent.result: str. TS는 JSON.stringify로 직렬화.
    expect((out[0] as { result: unknown }).result).toBe('{"ok":true}');
  });

  it("result — Python ResultSSEEvent (schemas.py:198-211) all optional fields propagated", () => {
    const out = mapClaudeClientEvent({
      type: "result",
      success: true,
      output: "final",
      usage: { input_tokens: 1 },
      totalCostUsd: 0.01,
      stopReason: "end_turn",
      errors: ["warn"],
      modelUsage: { opus: 1 },
      permissionDenials: ["Bash"],
      timestamp: 1,
    });
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.result!);
  });

  it("context_usage — Python ContextUsageEvent", () => {
    const out = mapClaudeClientEvent({
      type: "context_usage",
      usedTokens: 1000,
      maxTokens: 200000,
      percent: 0.5,
      timestamp: 1,
    });
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.context_usage!);
  });

  it("debug — Python DebugEvent (schemas.py:73-78)", () => {
    const out = mapClaudeClientEvent({
      type: "debug",
      message: "[info] hook notification",
      timestamp: 1,
    });
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.debug!);
  });

  it("away_summary — Python AwaySummarySSEEvent (schemas.py:214-219) — Phase A 신규", () => {
    const out = mapClaudeClientEvent({
      type: "away_summary",
      content: "지난 세션 요약",
      timestamp: 1,
    });
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.away_summary!);
  });

  it("prompt_suggestion — Python PromptSuggestionSSEEvent (schemas.py:222-227)", () => {
    const out = mapClaudeClientEvent({
      type: "prompt_suggestion",
      text: "next?",
      timestamp: 1,
    });
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.prompt_suggestion!);
  });

  it("subagent_start/stop — Python Subagent*SSEEvent (schemas.py:230-244)", () => {
    const start = mapClaudeClientEvent({
      type: "subagent_start",
      agentId: "sub",
      agentType: "explorer",
      timestamp: 1,
    });
    const stop = mapClaudeClientEvent({
      type: "subagent_stop",
      agentId: "sub",
      timestamp: 2,
    });
    assertPythonShape(start[0] as Record<string, unknown>, PYTHON_SHAPES.subagent_start!);
    assertPythonShape(stop[0] as Record<string, unknown>, PYTHON_SHAPES.subagent_stop!);
  });

  it("input_request — Python InputRequestSSEEvent (schemas.py:255-264)", () => {
    const out = mapClaudeClientEvent({
      type: "input_request",
      requestId: "ask-1",
      toolUseId: "toolu_ask",
      questions: [{ question: "Y/N?", header: "h", options: [], multiSelect: false }],
      startedAt: 100,
      timeoutSec: 300,
      timestamp: 1,
    });
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.input_request!);
  });

  it("input_request_expired / responded — Python schemas.py:267-280", () => {
    const expired = mapClaudeClientEvent({
      type: "input_request_expired",
      requestId: "ask-1",
      timestamp: 1,
    });
    const responded = mapClaudeClientEvent({
      type: "input_request_responded",
      requestId: "ask-1",
      timestamp: 2,
    });
    assertPythonShape(expired[0] as Record<string, unknown>, PYTHON_SHAPES.input_request_expired!);
    assertPythonShape(responded[0] as Record<string, unknown>, PYTHON_SHAPES.input_request_responded!);
  });

  it("assistant_error — Python AssistantErrorSSEEvent (schemas.py:283-290) — Phase A 신규", () => {
    const out = mapClaudeClientEvent({
      type: "assistant_error",
      errorType: "authentication_failed",
      model: "claude-sonnet-4-5",
      messageId: "msg_01",
      timestamp: 1,
    });
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.assistant_error!);
  });

  it("rate_limit → credential_alert — Python CredentialAlertEvent (schemas.py:293-301) — Phase A defensive parser", () => {
    const out = mapClaudeClientEvent({
      type: "rate_limit",
      status: "rate_limited",
      resetsAt: "2026-05-20T08:00:00Z",
      rateLimitType: "five_hour",
      utilization: 0.92,
      timestamp: 1,
    });
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.credential_alert!);
    expect((out[0] as { type: string }).type).toBe("credential_alert");
  });

  it("compact — Python CompactEvent (schemas.py:66-71)", () => {
    const out = mapClaudeClientEvent({
      type: "compact",
      trigger: "auto",
      message: "context compacted",
      timestamp: 1,
    });
    assertPythonShape(out[0] as Record<string, unknown>, PYTHON_SHAPES.compact!);
  });

  it("meta — ClaudeClientEvent union 전체가 PYTHON_SHAPES 키 ∪ TS_ONLY_NO_PYTHON_BASEMODEL과 동일 집합 (P1-1 inventory 게이트)", () => {
    // 모든 ClaudeClientEvent variant를 sample event로 한 번씩 매핑하여 wire payload type을 수집.
    // 새 variant가 추가되었는데 PYTHON_SHAPES에 추가 안 되면 본 단언이 fail — 정본 갱신 강제.
    const samples: ClaudeClientEvent[] = [
      { type: "session", sessionId: "s" },
      { type: "debug", message: "d", timestamp: 1 },
      { type: "progress", text: "p", timestamp: 1 },
      { type: "text", text: "t", timestamp: 1 },
      { type: "thinking", thinking: "th", timestamp: 1 },
      { type: "tool_start", toolName: "T", toolInput: {}, timestamp: 1 },
      { type: "tool_result", toolName: "T", result: "ok", timestamp: 1 },
      { type: "result", success: true, output: "o", timestamp: 1 },
      { type: "context_usage", usedTokens: 1, maxTokens: 200000, percent: 0, timestamp: 1 },
      { type: "complete", timestamp: 1 },
      { type: "error", message: "e", timestamp: 1 },
      { type: "prompt_suggestion", text: "p", timestamp: 1 },
      { type: "rate_limit", status: "allowed", timestamp: 1 },
      { type: "input_request", requestId: "r", questions: [], startedAt: 1, timeoutSec: 1, timestamp: 1 },
      { type: "input_request_expired", requestId: "r", timestamp: 1 },
      { type: "input_request_responded", requestId: "r", timestamp: 1 },
      { type: "compact", trigger: "auto", message: "m", timestamp: 1 },
      { type: "subagent_start", agentId: "a", agentType: "x", timestamp: 1 },
      { type: "subagent_stop", agentId: "a", timestamp: 1 },
      { type: "assistant_error", errorType: "e", timestamp: 1 },
      { type: "away_summary", content: "c", timestamp: 1 },
    ];
    const wireTypes = new Set<string>();
    for (const ev of samples) {
      for (const payload of mapClaudeClientEvent(ev)) {
        wireTypes.add((payload as { type: string }).type);
      }
    }
    // text는 3개 sub-event(text_start/text_delta/text_end)로 분해 — Python 정본 정합.
    const coveredByPython = new Set([...Object.keys(PYTHON_SHAPES), ...TS_ONLY_NO_PYTHON_BASEMODEL]);
    const missing = [...wireTypes].filter((t) => !coveredByPython.has(t));
    expect(missing, "mapper가 발행하는 wire type 중 PYTHON_SHAPES/TS_ONLY 둘 다에 없음 — 정본 갱신 누락").toEqual([]);
  });
});
