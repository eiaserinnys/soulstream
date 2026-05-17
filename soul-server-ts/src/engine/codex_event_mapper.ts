/**
 * Codex ThreadEvent → SSEEvent 매핑.
 *
 * stateless 매퍼. SDK 0.130.0 source 검증:
 *   - `AgentMessageItem.text`는 *누적 텍스트* (SDK 디자인 일관성 + d.ts 코멘트)
 *   - `item.updated`는 *상태 갱신* (delta append 아님) — text 그대로 운반
 *
 * agent_message 매핑:
 *   - item.started   → text_start (text 필드 없음)
 *   - item.updated   → text_delta (text=item.text 누적값)
 *   - item.completed → text_start + text_delta(text=item.text) + text_end
 *                       (text 비어 있으면 text_end만 — 클라이언트 no-op·history 종결 신호)
 *
 * codex-rs CLI `--experimental-json` 실측(2026-05-17, 분석 캐시
 * `20260517-1220-codex-ts-subscribe-events.md` §A): item.started·item.updated가 *발생하지 않는다*.
 * 짧건 길건 agent_message의 텍스트는 *오로지* `item.completed.item.text` 하나에 담겨 온다.
 *
 * 따라서 item.completed에서 *세 이벤트 모두를 합성*한다 (분석 캐시
 * `20260517-1325-codex-ts-sse-ui-routing.md`):
 *
 *   - soul-ui `tree-placer.handleTextStart`(`packages/soul-ui/src/stores/tree-placer.ts:157-179`)는
 *     text_start 수신 시 텍스트 노드를 생성하고 ctx.activeTextTarget을 *설정*한다.
 *   - 후속 text_delta·text_end는 activeTextTarget이 *없으면* silent drop된다
 *     (`packages/soul-ui/src/stores/node-factory.ts:296-312`).
 *   - claude 백엔드 정본 시퀀스(`soul-server/src/soul_server/engine/types.py:90`
 *     "text_start → text_delta → text_end")와 정합 — 백엔드 간 wire 대칭성 회복.
 *
 * 세 페이로드는 동일 timestamp로 묶여 atomic 의미를 보존한다 (DB 라이브 claude 샘플
 * `sess-20260322110817-20ec409b`이 같은 패턴: 동일 ts). `text_delta`는 *누적값*을 운반하므로
 * `event_persistence.ts:117-124` lastAssistantText 누적 모델과 정합.
 *
 * 미래에 codex SDK가 progressive streaming을 emit하기 시작하면 item.updated의 text_delta가
 * 이미 발행된 상태에서 item.completed의 합성 text_delta가 *동일 누적값*을 한 번 더 발행한다.
 * text_delta는 누적값을 전체로 덮어쓰는 모델이므로 클라이언트 표시는 변하지 않고, DB에
 * 한 행이 추가될 뿐이다 (수용 가능한 운영 비용). 정밀 dedup은 후속 카드.
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
    case "agent_message": {
      // codex-rs는 progressive streaming(item.started/item.updated)을 emit하지 않는다
      // (분석 캐시 `20260517-1220-codex-ts-subscribe-events.md` §A 실측). 그러나 soul-ui
      // 클라이언트의 tree-placer.handleTextStart(`packages/soul-ui/src/stores/tree-placer.ts:157-179`)는
      // text_start 수신 시 텍스트 노드를 생성하고 ctx.activeTextTarget을 *설정*한다.
      // 후속 text_delta·text_end는 activeTextTarget이 *없으면* silent drop된다
      // (`packages/soul-ui/src/stores/node-factory.ts:296-312`).
      //
      // 따라서 claude 백엔드 정본 시퀀스(`soul-server/src/soul_server/engine/types.py:90`
      // "text_start → text_delta → text_end")와 정합되도록 item.completed에서 *세 이벤트
      // 모두를 합성*한다. 세 페이로드는 동일 timestamp로 묶여 atomic 의미를 보존한다
      // (DB 라이브 샘플 `sess-20260322110817-20ec409b`이 같은 패턴: 동일 ts 1774177745.579).
      //
      // text가 빈 문자열이면 text_end만 발행 — text_start 없는 text_end는 클라이언트에서
      // no-op이고 history 백필도 종결 신호로 정합. (codex가 실제로 빈 agent_message를
      // 발행하는 사례는 관찰되지 않음 — 방어적 분기.)
      const ts = nowEpochSec();
      if (!item.text) {
        return [{ type: "text_end", timestamp: ts } as SSEEventPayload];
      }
      return [
        { type: "text_start", timestamp: ts } as SSEEventPayload,
        { type: "text_delta", text: item.text, timestamp: ts } as SSEEventPayload,
        { type: "text_end", timestamp: ts } as SSEEventPayload,
      ];
    }

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
