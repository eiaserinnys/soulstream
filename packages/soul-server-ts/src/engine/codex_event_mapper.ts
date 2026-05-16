/**
 * Codex ThreadEvent → SSEEvent 매핑 (Phase B-3 streaming 활성).
 *
 * stateless 매퍼. Phase B-3 SDK 0.130.0 source 검증 결과 (분析 캐시 §4.4.0):
 *   - `AgentMessageItem.text`는 *누적 텍스트* (SDK 디자인 일관성 + d.ts 코멘트)
 *   - `item.updated`는 *상태 갱신* (delta append 아님) — text 그대로 운반
 *
 * agent_message 매핑 (B-3 streaming 활성):
 *   - item.started → text_start (text 필드 없음)
 *   - item.updated → text_delta (text=item.text 누적값)
 *   - item.completed → text_end (text 필드 없음 — B-2 결함 정정)
 *
 * Python wire 정본: `soul-server/src/soul_server/models/schemas.py` L155-174.
 * 모든 payload에 `timestamp: Date.now()/1000` (Unix epoch sec, Python 정합).
 */

import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";

import type { SSEEventPayload } from "./protocol.js";

/** 매퍼 호출 시점의 Unix epoch sec. Python wire 정본은 number (float). */
function nowEpochSec(): number {
  return Date.now() / 1000;
}

/**
 * 단일 ThreadEvent를 SSEEventPayload 배열로 매핑.
 *
 * @returns 발행할 SSE payload 0개 이상. 빈 배열은 no-op (어댑터가 yield 안 함).
 */
export function mapThreadEvent(event: ThreadEvent): SSEEventPayload[] {
  switch (event.type) {
    case "thread.started":
      // 새 스레드 시작 — session_id 운반. 어댑터가 추가로 onSession 콜백 호출.
      return [{ type: "session", session_id: event.thread_id } as SSEEventPayload];

    case "turn.started":
      // 정보량 0 — no-op.
      return [];

    case "turn.completed":
      // usage 운반. SSEEventComplete는 open shape이므로 usage를 그대로 spread.
      return [
        {
          type: "complete",
          usage: event.usage,
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "turn.failed":
      // turn 단위 실패 — 다음 turn 가능. fatal=false.
      return [
        {
          type: "error",
          message: event.error.message,
          fatal: false,
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "error":
      // ThreadErrorEvent — stream-level fatal. 어댑터 종료.
      return [
        {
          type: "error",
          message: event.message,
          fatal: true,
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "item.started":
      return mapItemStarted(event.item);

    case "item.updated":
      return mapItemUpdated(event.item);

    case "item.completed":
      return mapItemCompleted(event.item);

    default: {
      // exhaustiveness check
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** item.started 매핑. */
function mapItemStarted(item: ThreadItem): SSEEventPayload[] {
  switch (item.type) {
    case "agent_message":
      // text_start — Python 정본은 text 필드 없음 (schemas.py L155-159).
      return [
        {
          type: "text_start",
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "reasoning":
      // 사고 시작 시점은 표시 안 함. 완료 시 thinking 발행.
      return [];

    case "command_execution":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: "command",
          tool_input: { command: item.command },
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "file_change":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: "file_change",
          tool_input: { changes_count: item.changes.length },
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "mcp_tool_call":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: `mcp/${item.server}/${item.tool}`,
          tool_input: item.arguments,
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "web_search":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: "web_search",
          tool_input: { query: item.query },
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "todo_list":
      // Codex 고유 — wire 등가 없음. 후속 카드에서 새 SSE type 검토.
      return [];

    case "error":
      // ErrorItem.started는 의미 없음 — 완료 시 error 발행.
      return [];

    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

/**
 * item.updated 매핑 (B-3 streaming).
 *
 * agent_message → text_delta (text=item.text 누적값 그대로). 다른 item type은 no-op
 * (in-progress 상태 update는 클라이언트 가시화 불필요 — completed 시 일괄 발행).
 */
function mapItemUpdated(item: ThreadItem): SSEEventPayload[] {
  if (item.type === "agent_message") {
    return [
      {
        type: "text_delta",
        text: item.text,
        timestamp: nowEpochSec(),
      } as SSEEventPayload,
    ];
  }
  return [];
}

/** item.completed 매핑. */
function mapItemCompleted(item: ThreadItem): SSEEventPayload[] {
  switch (item.type) {
    case "agent_message":
      // text_end — Python 정본은 text 필드 없음 (schemas.py L170-174).
      // B-2 매퍼 결함 정정: text 필드 제거.
      return [
        {
          type: "text_end",
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "reasoning":
      return [
        {
          type: "thinking",
          thinking: item.text,
          signature: "",
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "command_execution":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          content: {
            output: item.aggregated_output,
            exit_code: item.exit_code ?? null,
          },
          is_error: item.status === "failed",
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "file_change":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          content: {
            changes: item.changes,
            status: item.status,
          },
          is_error: item.status === "failed",
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "mcp_tool_call":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          content: item.error ? { error: item.error.message } : item.result ?? {},
          is_error: item.status === "failed",
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "web_search":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          content: { query: item.query },
          is_error: false,
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "todo_list":
      return [];

    case "error":
      return [
        {
          type: "error",
          message: item.message,
          fatal: false,
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}
