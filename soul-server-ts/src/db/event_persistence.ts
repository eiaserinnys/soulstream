/**
 * EventPersistence — SSE event → DB + 부수효과 처리 (Phase B-3 + F-3A 후속 사이클).
 *
 * Python `service/event_persistence.py`의 *구조* 참조 (정본 둘 안티패턴 회피).
 * TS 측은 Codex 흐름에 한정 — metadata_extractor·away_summary는 본 PR 범위 외.
 *
 * 책임:
 *   1. persistEvent: event_append stored proc 호출 → 새 event_id 반환
 *   2. handleSideEffects: last_message DB 갱신 + emit_session_message_updated wire 발행
 *      (F-3A) + task.lastAssistantText 누적
 */

import type { Logger } from "pino";

import type { SSEEventPayload } from "../engine/protocol.js";
import type { Task } from "../task/task_models.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type { SessionDB } from "./session_db.js";

/**
 * 이벤트 타입별 preview 텍스트 추출 필드.
 * Python `task_models.py` L298-305 `PREVIEW_FIELD_MAP` 정본.
 */
const PREVIEW_FIELD_MAP: Record<string, string> = {
  thinking: "thinking",
  text_delta: "text",
  result: "output",
  complete: "result",
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

export class EventPersistence {
  constructor(
    private readonly db: SessionDB,
    private readonly broadcaster: SessionBroadcaster,
    private readonly logger: Logger,
  ) {}

  /**
   * 이벤트를 DB에 영속화. 반환 event_id를 호출자가 task.lastEventId에 박는다.
   *
   * @returns 새 events.id (1-based).
   */
  async persistEvent(
    sessionId: string,
    event: SSEEventPayload,
  ): Promise<number> {
    const eventType = (event as { type: string }).type;
    const payload = JSON.stringify(event);
    const searchable = extractSearchableText(event);
    const createdAt = extractTimestamp(event) ?? new Date();
    return await this.db.appendEvent({
      sessionId,
      eventType,
      payload,
      searchableText: searchable,
      createdAt,
    });
  }

  /**
   * 이벤트 후처리: last_message DB 갱신 + emit_session_message_updated wire 발행 +
   * task.lastAssistantText 누적.
   *
   * F-3A: PREVIEW_FIELD_MAP 매칭 이벤트(text_delta/thinking/result/complete/error/away_summary)에
   * 한해 DB 갱신 직후 broadcaster에 last_message wire를 발행. text_start/text_end/session 등은
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
          previewText = task.lastAssistantText;
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
        preview: previewText.slice(0, 200),
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
  return typeof val === "string" ? val : "";
}

/**
 * full-text 검색용 텍스트 추출. Python `soul_common.db.session_db_base.extract_searchable_text`
 * 최소 등가 — 기본은 preview 텍스트를 사용하되, live-only chunk는 final assistant_message가
 * 검색 정본이므로 제외한다.
 */
export function extractSearchableText(event: SSEEventPayload): string {
  // app-server live chunks are persisted for SSE ids/replay, but the final
  // assistant_message is the searchable canonical assistant response.
  if ((event as Record<string, unknown>)._live_only === true) return "";
  const preview = extractPreviewText(event);
  if (preview) return preview;
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
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * 이벤트의 timestamp 필드를 Date로 변환. 없으면 undefined.
 * 모든 SSE event payload는 `timestamp: number` (Unix epoch sec) — Python `models/schemas.py` 정본.
 */
function extractTimestamp(event: SSEEventPayload): Date | undefined {
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
