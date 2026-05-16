/**
 * Codex ThreadEvent → SSEEvent 매핑.
 *
 * stateless 매퍼 (spec-reviewer 1차 P1 — `AgentMessageItem.text` 누적 여부 d.ts 미명시로
 * 보수적 매핑 채택). agent_message는 `item.completed`만 `text_end` 발행 — streaming은 B-3에서
 * SDK 실제 동작 검증 후 정밀화.
 *
 * 매핑 표: 분석 캐시 `20260517-1700-phase-b2-engine-port-codex.md` §4.1·§4.2
 */

import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";

import type { SSEEventPayload } from "./protocol.js";

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
      // 정보량 0 — no-op (§4.4 D-M2).
      return [];

    case "turn.completed":
      // usage 운반. SSEEventComplete는 open shape이므로 usage를 그대로 spread.
      return [
        {
          type: "complete",
          usage: event.usage,
        } as SSEEventPayload,
      ];

    case "turn.failed":
      // turn 단위 실패 — 다음 turn 가능. fatal=false.
      return [
        {
          type: "error",
          message: event.error.message,
          fatal: false,
        } as SSEEventPayload,
      ];

    case "error":
      // ThreadErrorEvent — stream-level fatal. 어댑터 종료.
      return [
        {
          type: "error",
          message: event.message,
          fatal: true,
        } as SSEEventPayload,
      ];

    case "item.started":
      return mapItemStarted(event.item);

    case "item.updated":
      // 본 PR 범위에서는 모든 item.updated가 no-op (streaming 보류).
      return [];

    case "item.completed":
      return mapItemCompleted(event.item);

    default: {
      // exhaustiveness check
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/** item.started 매핑. agent_message·reasoning·todo_list·error는 no-op (§4.2). */
function mapItemStarted(item: ThreadItem): SSEEventPayload[] {
  switch (item.type) {
    case "agent_message":
      // 본 PR: streaming 보류 — no-op. (spec-reviewer 1차 P1)
      return [];

    case "reasoning":
      // 사고 시작은 표시 안 함. 완료 시 thinking 발행.
      return [];

    case "command_execution":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: "command",
          input: { command: item.command },
        } as SSEEventPayload,
      ];

    case "file_change":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: "file_change",
          input: { changes_count: item.changes.length },
        } as SSEEventPayload,
      ];

    case "mcp_tool_call":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: `mcp/${item.server}/${item.tool}`,
          input: item.arguments,
        } as SSEEventPayload,
      ];

    case "web_search":
      return [
        {
          type: "tool_start",
          tool_use_id: item.id,
          tool_name: "web_search",
          input: { query: item.query },
        } as SSEEventPayload,
      ];

    case "todo_list":
      // Codex 고유 — 본 PR 범위 외 (§4.4 D-M1). B-3에서 새 SSE type 신설 고려.
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

/** item.completed 매핑 (§4.2 8 sub-type). */
function mapItemCompleted(item: ThreadItem): SSEEventPayload[] {
  switch (item.type) {
    case "agent_message":
      // text_end만 발행 — text_start/text_delta는 streaming 보류 (P1).
      return [
        {
          type: "text_end",
          text: item.text,
          item_id: item.id,
        } as SSEEventPayload,
      ];

    case "reasoning":
      // Claude `ThinkingEngineEvent`와 등가. signature는 Codex에 없으므로 빈 문자열.
      return [
        {
          type: "thinking",
          thinking: item.text,
          signature: "",
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
        } as SSEEventPayload,
      ];

    case "mcp_tool_call":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          content: item.error ? { error: item.error.message } : item.result ?? {},
          is_error: item.status === "failed",
        } as SSEEventPayload,
      ];

    case "web_search":
      return [
        {
          type: "tool_result",
          tool_use_id: item.id,
          content: { query: item.query },
          is_error: false,
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
        } as SSEEventPayload,
      ];

    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}
