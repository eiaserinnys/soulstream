/**
 * EventPersistence — SSE event → DB + 부수효과 처리 (Phase B-3 + F-3A 후속 사이클).
 *
 * Python `service/event_persistence.py`의 *구조* 참조 (정본 둘 안티패턴 회피).
 * TS 측은 Codex 흐름에 한정 — metadata_extractor·away_summary는 본 PR 범위 외.
 *
 * 책임:
 *   1. persistEvent: semantic/debug events만 event_append stored proc 호출 → 새 event_id 반환
 *   2. handleSideEffects: last_message DB 갱신 + emit_session_message_updated wire 발행
 *      (F-3A) + task.lastAssistantText 누적
 */

import type { Logger } from "pino";

import type { SSEEventPayload } from "../engine/protocol.js";
import type { Task } from "../task/task_models.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { SessionDB } from "./session_db.js";

const LAST_MESSAGE_PREVIEW_LIMIT = 200;
const INTERNAL_DEDUPE_KEY = "_dedupe_key";

export interface PersistEventResult {
  eventId: number;
  inserted: boolean;
}

/**
 * 이벤트 타입별 last_message preview 텍스트 추출 필드.
 * text_start/text_delta/text_end는 live transport 전용이고, complete/result는 turn
 * metadata라 채팅 말풍선 preview의 정본으로 쓰지 않는다.
 */
const PREVIEW_FIELD_MAP: Record<string, string> = {
  thinking: "thinking",
  error: "message",
  away_summary: "content",
  assistant_message: "content",
  // B-5: 사용자 발화 영속 (Python `event_persistence.py:78-79` 정본 정합).
  // codex 노드는 systemPrompt를 SDK가 미지원이라 system_message 이벤트를 발행하지 않음 —
  // PREVIEW_FIELD_MAP에 키를 두지 않는다 (Python 정본 PREVIEW_FIELD_MAP도 system_message 없음).
  user_message: "text",
  intervention_sent: "text",
  realtime_transcript: "text",
};

const TRANSIENT_TEXT_EVENT_TYPES = new Set(["text_start", "text_delta", "text_end"]);

export class EventPersistence {
  constructor(
    private readonly db: SessionDB,
    private readonly broadcaster: SessionBroadcaster,
    private readonly logger: Logger,
  ) {}

  /**
   * 이벤트를 DB에 영속화. 반환 event_id를 호출자가 task.lastEventId에 박는다.
   * text lifecycle 이벤트와 `_live_only` 이벤트는 생성 중 wire 전용이므로 호출자가
   * persist 전에 건너뛰어야 한다.
   *
   * @returns 새 events.id (1-based).
   */
  async persistEvent(
    sessionId: string,
    event: SSEEventPayload,
  ): Promise<number> {
    return (await this.persistEventWithResult(sessionId, event)).eventId;
  }

  async persistEventWithResult(
    sessionId: string,
    event: SSEEventPayload,
  ): Promise<PersistEventResult> {
    if (!shouldPersistEvent(event)) {
      throw new Error("transient live events must not be persisted");
    }
    const dedupeKey = extractInternalDedupeKey(event);
    if (dedupeKey) {
      const existingEventId = await this.db.findEventIdByDedupeKey(sessionId, dedupeKey);
      if (existingEventId !== null) {
        return { eventId: existingEventId, inserted: false };
      }
    }
    const safeEvent = stripInternalPersistenceFields(
      sanitizeJsonValue(event),
    ) as SSEEventPayload;
    const eventType = (safeEvent as { type: string }).type;
    const payload = JSON.stringify(safeEvent);
    const searchable = extractSearchableText(safeEvent);
    const createdAt = extractTimestamp(event) ?? new Date();
    const eventId = await this.db.appendEvent({
      sessionId,
      eventType,
      payload,
      searchableText: searchable,
      createdAt,
      dedupeKey,
    });
    return { eventId, inserted: true };
  }

  /**
   * 이벤트 후처리: last_message DB 갱신 + emit_session_message_updated wire 발행 +
   * task.lastAssistantText 누적.
   *
   * F-3A: PREVIEW_FIELD_MAP 매칭 이벤트(thinking/error/away_summary/assistant_message)에
   * 한해 DB 갱신 직후 broadcaster에 last_message wire를 발행. text_start/text_delta/
   * text_end/complete/result/session 등은
   * PREVIEW_FIELD_MAP에 없어 자동 필터됨 — Python `event_persistence.py` L96-133 정본과 정합.
   *
   * 실패 격리 정책 (Python 정본 정합):
   *   - DB updateLastMessage throw → 호출자(task_executor._processEvent)까지 전파.
   *     wire는 발행하지 *않음* — DB·wire 불일치(클라이언트가 last_message 보고 새로 그렸는데
   *     DB는 미갱신이라 다음 list refresh에서 이전 값으로 회귀) 방지.
   *   - broadcaster.emitSessionMessageUpdated throw → 격리 (logger.debug, task 진행 계속).
   *     wire는 다음 readable event가 self-correct.
   *   - lastAssistantText 누적은 *항상* 수행 (DB·wire 무관).
   */
  async handleSideEffects(
    sessionId: string,
    event: SSEEventPayload,
    task: Task,
  ): Promise<void> {
    const eventType = (event as { type: string }).type;
    let previewText = extractPreviewText(event);

    if (eventType === "text_start") {
      task.lastAssistantText = "";
    }
    if (eventType === "text_delta") {
      const text = (event as { text?: unknown }).text;
      if (typeof text === "string") {
        if ((event as { raw_event_type?: unknown }).raw_event_type === "item/agentMessage/delta") {
          task.lastAssistantText = `${task.lastAssistantText ?? ""}${text}`;
        } else {
          task.lastAssistantText = text;
        }
      }
    }
    if (eventType === "assistant_message") {
      const content = (event as { content?: unknown }).content;
      if (typeof content === "string") {
        task.lastAssistantText = content;
      }
    }
    if (eventType === "progress") {
      const text = (event as { text?: unknown }).text;
      if (typeof text === "string") {
        task.lastProgressText = text;
      }
    }

    if (previewText) {
      const ts = extractTimestamp(event)?.toISOString() ?? new Date().toISOString();
      const lastMessage = {
        type: eventType,
        preview: truncateJsonText(previewText, LAST_MESSAGE_PREVIEW_LIMIT),
        timestamp: ts,
      };

      // last_message DB 갱신 — throw 시 호출자로 전파 (wire 미발행).
      await this.db.updateLastMessage(sessionId, lastMessage);

      // F-3A: emit_session_message_updated wire — DB 성공 후에만 발행.
      // wire 실패는 격리 (다음 readable event가 self-correct).
      try {
        await this.broadcaster.emitSessionMessageUpdated(
          sessionId,
          task.status,
          ts,
          lastMessage,
          task.lastEventId,
          task.lastReadEventId,
        );
      } catch (err) {
        this.logger.debug(
          { err, sessionId },
          "emitSessionMessageUpdated failed",
        );
      }
    }
  }
}

/**
 * 이벤트에서 preview 텍스트 추출. PREVIEW_FIELD_MAP 기준.
 *
 * 외부 export — task_executor 등 다른 모듈도 호출 가능 (Python `task_models.py` 정본 인용).
 */
export function extractPreviewText(event: SSEEventPayload): string {
  const eventType = (event as { type: string }).type;
  const field = PREVIEW_FIELD_MAP[eventType];
  if (!field) return "";
  const val = (event as Record<string, unknown>)[field];
  return typeof val === "string" ? sanitizeJsonText(val) : "";
}

export function isLiveOnlyEvent(event: SSEEventPayload): boolean {
  return (event as Record<string, unknown>)._live_only === true;
}

export function isTransientTextEvent(event: SSEEventPayload): boolean {
  return TRANSIENT_TEXT_EVENT_TYPES.has((event as { type: string }).type);
}

export function shouldPersistEvent(event: SSEEventPayload): boolean {
  return !isLiveOnlyEvent(event) && !isTransientTextEvent(event);
}

export function clearEventPersistenceInternals(event: SSEEventPayload): void {
  delete (event as Record<string, unknown>)[INTERNAL_DEDUPE_KEY];
}

function extractInternalDedupeKey(event: SSEEventPayload): string | null {
  const value = (event as Record<string, unknown>)[INTERNAL_DEDUPE_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stripInternalPersistenceFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === INTERNAL_DEDUPE_KEY) continue;
    result[key] = item;
  }
  return result;
}

/**
 * full-text 검색용 텍스트 추출. Python `soul_common.db.session_db_base.extract_searchable_text`
 * 최소 등가 — 기본은 preview 텍스트를 사용한다. live-only chunk는 DB 저장 대상이
 * 아니므로 검색 텍스트도 비운다.
 */
export function extractSearchableText(event: SSEEventPayload): string {
  if (!shouldPersistEvent(event)) return "";
  const preview = extractPreviewText(event);
  if (preview) return preview;
  const eventType = (event as { type: string }).type;
  if (eventType === "complete") {
    return contentToText((event as Record<string, unknown>).result);
  }
  if (eventType === "result") {
    return contentToText((event as Record<string, unknown>).output);
  }
  const messages = (event as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return "";
      return contentToText((message as Record<string, unknown>).content);
    })
    .filter(Boolean)
    .join(" ");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return sanitizeJsonText(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? sanitizeJsonText(record.text) : "";
    })
    .filter(Boolean)
    .join(" ");
}

export function truncateJsonText(value: string, maxCodePoints: number): string {
  return Array.from(sanitizeJsonText(value)).slice(0, maxCodePoints).join("");
}

export function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeJsonText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item));
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = sanitizeJsonValue(item);
  }
  return result;
}

export function sanitizeJsonText(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] ?? "";
        result += value[index + 1] ?? "";
        index += 1;
      } else {
        result += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\uFFFD";
      continue;
    }
    result += value[index] ?? "";
  }
  return result;
}

/**
 * 이벤트의 timestamp 필드를 Date로 변환. 없으면 undefined.
 * 모든 SSE event payload는 wire-schema 기준 `timestamp: number` (Unix epoch sec)를 사용한다.
 */
export function extractTimestamp(event: SSEEventPayload): Date | undefined {
  const ts = (event as { timestamp?: unknown }).timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return new Date(ts * 1000);
  }
  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}
