/**
 * Codex ThreadEvent → SSEEvent 매핑.
 *
 * stateless 매퍼. SDK 0.130.0 source 검증:
 *   - `AgentMessageItem.text`는 *누적 텍스트* (SDK 디자인 일관성 + d.ts 코멘트)
 *   - `item.updated`는 *상태 갱신* (delta append 아님) — text 그대로 운반
 *
 * agent_message 매핑:
 *   - item.started   → text_start (live transport only)
 *   - item.updated   → text_delta (live transport only, text=item.text 누적값)
 *   - item.completed → assistant_message (durable semantic final)
 *
 * codex-rs CLI `--experimental-json` 실측(2026-05-17, 분석 캐시
 * `20260517-1220-codex-ts-subscribe-events.md` §A): item.started·item.updated가 *발생하지 않는다*.
 * 짧건 길건 agent_message의 텍스트는 *오로지* `item.completed.item.text` 하나에 담겨 온다.
 *
 * 따라서 item.completed에서 완료 말풍선의 durable 정본인 assistant_message를 발행한다.
 * text_start/text_delta/text_end는 생성 중 live transport에서만 쓰며 DB history에는 저장하지 않는다.
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

type RawCodexEvent = Record<string, unknown>;
type RawCodexItem = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === "string" ? value.type : undefined;
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function fieldString(value: unknown, key: string): string | undefined {
  const v = field(value, key);
  return typeof v === "string" ? v : undefined;
}

function fieldNumber(value: unknown, key: string): number | undefined {
  const v = field(value, key);
  return typeof v === "number" ? v : undefined;
}

function fieldArray(value: unknown, key: string): unknown[] | undefined {
  const v = field(value, key);
  return Array.isArray(v) ? v : undefined;
}

function jsonStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function emitAssistantMessage(
  text: string,
  extra: Record<string, unknown> = {},
): SSEEventPayload[] {
  const ts = nowEpochSec();
  return [
    {
      type: "assistant_message",
      content: text,
      timestamp: ts,
      ...extra,
    } as SSEEventPayload,
  ];
}

/**
 * 단일 ThreadEvent를 SSEEventPayload 배열로 매핑.
 *
 * Codex SDK 0.130.0의 d.ts union 밖 raw event가 실제 스트림에 섞일 수 있다
 * (`response_item.function_call` 등). 외부 경계 입력이므로 런타임 type을 기준으로
 * 매핑하고, 모르는 event/item은 no-op으로 격리해 어댑터 스트림을 보존한다.
 *
 * @returns 발행할 SSE payload 0개 이상. 빈 배열은 no-op (어댑터가 yield 안 함).
 */
export function mapThreadEvent(event: ThreadEvent | RawCodexEvent): SSEEventPayload[] {
  switch (typeOf(event)) {
    case "thread.started":
      // 새 스레드 시작 — session_id 운반. 어댑터가 추가로 onSession 콜백 호출.
      return [{
        type: "session",
        session_id: fieldString(event, "thread_id") ?? "",
      } as SSEEventPayload];

    case "turn.started":
      // 정보량 0 — no-op.
      return [];

    case "turn.completed":
      // usage 운반. SSEEventComplete는 open shape이므로 usage를 그대로 spread.
      return [
        {
          type: "complete",
          usage: (event as Extract<ThreadEvent, { type: "turn.completed" }>).usage,
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "turn.failed":
      // turn 단위 실패 — 다음 turn 가능. fatal=false.
      return [
        {
          type: "error",
          message: isRecord(field(event, "error"))
            ? fieldString(field(event, "error"), "message") ?? "Codex turn failed"
            : "Codex turn failed",
          fatal: false,
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "error":
      // ThreadErrorEvent — stream-level fatal. 어댑터 종료.
      return [
        {
          type: "error",
          message: fieldString(event, "message") ?? "Codex stream error",
          fatal: true,
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "item.started":
      return mapItemStarted((event as { item?: unknown }).item);

    case "item.updated":
      return mapItemUpdated((event as { item?: unknown }).item);

    case "item.completed":
      return mapItemCompleted((event as { item?: unknown }).item);

    case "response_item":
      return mapResponseItem((event as { payload?: unknown }).payload);

    default:
      return [];
  }
}

/** item.started 매핑. */
function mapItemStarted(item: ThreadItem | RawCodexItem | unknown): SSEEventPayload[] {
  switch (typeOf(item)) {
    case "agent_message":
      return [
        {
          type: "text_start",
          _live_only: true,
          raw_event_type: "item.started",
          item_id: fieldString(item, "id"),
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
          tool_use_id: fieldString(item, "id") ?? "command",
          tool_name: "command",
          tool_input: { command: fieldString(item, "command") ?? "" },
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "file_change":
      return [
        {
          type: "tool_start",
          tool_use_id: fieldString(item, "id") ?? "file_change",
          tool_name: "file_change",
          tool_input: {
            changes_count: fieldArray(item, "changes")?.length ?? 0,
          },
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "mcp_tool_call":
      return [
        {
          type: "tool_start",
          tool_use_id: fieldString(item, "id") ?? "mcp_tool_call",
          tool_name: `mcp/${fieldString(item, "server") ?? "unknown"}/${fieldString(item, "tool") ?? "unknown"}`,
          tool_input: field(item, "arguments"),
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "web_search":
      return [
        {
          type: "tool_start",
          tool_use_id: fieldString(item, "id") ?? "web_search",
          tool_name: "web_search",
          tool_input: { query: fieldString(item, "query") ?? "" },
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "function_call":
      return mapFunctionCall(isRecord(item) ? item : {});

    case "todo_list":
      // Codex 고유 — wire 등가 없음. 후속 카드에서 새 SSE type 검토.
      return [];

    case "error":
      // ErrorItem.started는 의미 없음 — 완료 시 error 발행.
      return [];

    default:
      return [];
  }
}

/**
 * item.updated 매핑 (B-3 streaming).
 *
 * agent_message → text_delta (text=item.text 누적값 그대로). 다른 item type은 no-op
 * (in-progress 상태 update는 클라이언트 가시화 불필요 — completed 시 일괄 발행).
 */
function mapItemUpdated(item: ThreadItem | RawCodexItem | unknown): SSEEventPayload[] {
  if (typeOf(item) === "agent_message" && isRecord(item)) {
    return [
      {
        type: "text_delta",
        text: fieldString(item, "text") ?? "",
        _live_only: true,
        raw_event_type: "item.updated",
        item_id: fieldString(item, "id"),
        timestamp: nowEpochSec(),
      } as SSEEventPayload,
    ];
  }
  return [];
}

/** item.completed 매핑. */
function mapItemCompleted(item: ThreadItem | RawCodexItem | unknown): SSEEventPayload[] {
  switch (typeOf(item)) {
    case "agent_message": {
      const itemId = isRecord(item) ? fieldString(item, "id") : undefined;
      return emitAssistantMessage(
        isRecord(item) ? fieldString(item, "text") ?? "" : "",
        {
          raw_event_type: "item.completed",
          ...(itemId ? { item_id: itemId, _final_for_live_stream: true } : {}),
        },
      );
    }

    case "reasoning":
      return [
        {
          type: "thinking",
          thinking: isRecord(item) ? fieldString(item, "text") ?? "" : "",
          signature: "",
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "command_execution": {
      // F2 (PR fix/soul-server-ts-chat-sse-python-parity): Python `ToolResultEngineEvent.to_sse()`
      // 정합 — `tool_name` + 문자열 `result`. soul-ui `node-factory.ts:323`이 `e.result`를 string으로
      // 가정(`.length`, `.slice`)하므로 boundary에서 stringify. `content` 키는 제거 (정본 둘 안티패턴 회피).
      // command_execution은 aggregated_output이 이미 string. 빈 출력 + 실패 시 exit_code 단서를
      // result에 prefix하여 사용자에게 신호 (claude 정합 메타 표현).
      const output = fieldString(item, "aggregated_output") ?? "";
      const exitCode = fieldNumber(item, "exit_code") ?? null;
      const result = output || (exitCode !== null ? `[exit ${exitCode}]` : "");
      return [
        {
          type: "tool_result",
          tool_name: "command",
          tool_use_id: fieldString(item, "id") ?? "command",
          result,
          is_error: fieldString(item, "status") === "failed",
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];
    }

    case "file_change":
      // changes는 객체 배열 — JSON 직렬화하여 string으로 박는다. 사용자 친화적 표현은 후속 카드 (P2).
      return [
        {
          type: "tool_result",
          tool_name: "file_change",
          tool_use_id: fieldString(item, "id") ?? "file_change",
          result: JSON.stringify(fieldArray(item, "changes") ?? []),
          is_error: fieldString(item, "status") === "failed",
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "mcp_tool_call": {
      // error message는 그대로 string. success result는 객체이므로 JSON.stringify.
      // mcp_tool_call은 tool_start에서 `mcp/${server}/${tool}` 형태로 tool_name이 박혀 있으므로
      // 동일한 명명을 사용 — UI nodeMap에서 tool_use_id 매칭이라 본문 영향 0이지만 design-principles §9
      // (일관성·대칭성) 정합.
      const errorValue = field(item, "error");
      const error = isRecord(errorValue) ? fieldString(errorValue, "message") : undefined;
      const result = error ?? JSON.stringify(field(item, "result") ?? {});
      return [
        {
          type: "tool_result",
          tool_name: `mcp/${fieldString(item, "server") ?? "unknown"}/${fieldString(item, "tool") ?? "unknown"}`,
          tool_use_id: fieldString(item, "id") ?? "mcp_tool_call",
          result,
          is_error: fieldString(item, "status") === "failed",
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];
    }

    case "web_search":
      return [
        {
          type: "tool_result",
          tool_name: "web_search",
          tool_use_id: fieldString(item, "id") ?? "web_search",
          result: `Search: ${fieldString(item, "query") ?? ""}`,
          is_error: false,
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    case "function_call":
      return mapFunctionCall(isRecord(item) ? item : {});

    case "function_call_output":
      return mapFunctionCallOutput(isRecord(item) ? item : {});

    case "todo_list":
      return [];

    case "error":
      return [
        {
          type: "error",
          message: isRecord(item)
            ? fieldString(item, "message") ?? "Codex item error"
            : "Codex item error",
          fatal: false,
          timestamp: nowEpochSec(),
        } as SSEEventPayload,
      ];

    default:
      return [];
  }
}

function mapResponseItem(payload: unknown): SSEEventPayload[] {
  if (!isRecord(payload)) {
    return [];
  }

  switch (typeOf(payload)) {
    case "function_call":
      return mapFunctionCall(payload);

    case "function_call_output":
      return mapFunctionCallOutput(payload);

    case "message":
      return mapResponseMessage(payload);

    case "reasoning":
      return mapResponseReasoning(payload);

    default:
      return [];
  }
}

function mapFunctionCall(item: RawCodexItem): SSEEventPayload[] {
  const toolUseId = fieldString(item, "call_id") ?? fieldString(item, "id") ?? "function_call";
  const toolName = fieldString(item, "name") ?? "function_call";
  return [
    {
      type: "tool_start",
      tool_use_id: toolUseId,
      tool_name: toolName,
      tool_input: parseToolInput(item.arguments),
      timestamp: nowEpochSec(),
    } as SSEEventPayload,
  ];
}

function mapFunctionCallOutput(item: RawCodexItem): SSEEventPayload[] {
  return [
    {
      type: "tool_result",
      tool_name: "function_call",
      tool_use_id: fieldString(item, "call_id") ?? fieldString(item, "id") ?? "function_call",
      result: jsonStringify(item.output),
      is_error: false,
      timestamp: nowEpochSec(),
    } as SSEEventPayload,
  ];
}

function mapResponseMessage(payload: RawCodexItem): SSEEventPayload[] {
  const role = fieldString(payload, "role");
  if (role !== undefined && role !== "assistant") {
    return [];
  }

  const content = payload.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const text = content
    .map((part) => {
      if (!isRecord(part)) {
        return "";
      }
      const partType = typeOf(part);
      if (partType === "output_text" || partType === "input_text" || partType === "text") {
        return fieldString(part, "text") ?? "";
      }
      return "";
    })
    .join("");

  return text.length > 0
    ? emitAssistantMessage(text, { raw_event_type: "response_item.message" })
    : [];
}

function mapResponseReasoning(payload: RawCodexItem): SSEEventPayload[] {
  const summary = payload.summary;
  const text = Array.isArray(summary)
    ? summary
        .map((part) => (isRecord(part) ? fieldString(part, "text") ?? "" : ""))
        .join("")
    : "";

  if (!text) {
    return [];
  }

  return [
    {
      type: "thinking",
      thinking: text,
      signature: "",
      timestamp: nowEpochSec(),
    } as SSEEventPayload,
  ];
}
