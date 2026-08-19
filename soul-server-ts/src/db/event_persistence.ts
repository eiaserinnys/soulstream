/**
 * EventPersistence — SSE event → durable orch ingress + 부수효과 처리.
 *
 * Python `service/event_persistence.py`의 *구조* 참조 (정본 둘 안티패턴 회피).
 * TS 측은 Codex 흐름에 한정 — metadata_extractor·away_summary는 본 PR 범위 외.
 *
 * 책임:
 *   1. enqueueEvent: semantic/debug events를 worker JSONL outbox에 fsync append
 *   2. waitForSessionAck: turn/terminal 경계에서 orch commit ACK 대기
 *   3. handleSideEffects: worker runtime text state only. Durable session effects
 *      are attached before outbox append and committed by the orchestrator.
 */

import type { Logger } from "pino";
import {
  EVENT_DURABILITY,
  type EventDurability,
} from "@soulstream/wire-schema";

import type { SSEEventPayload } from "../engine/protocol.js";
import type { Task } from "../task/task_models.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import type {
  EventOutbox,
  EventOutboxRecord,
  EventOutboxSessionEffect,
} from "../upstream/event_outbox.js";
import type {
  EventCanonicalSessionProjection,
  EventOutboxPump,
} from "../upstream/event_outbox_pump.js";

import type { SessionDB } from "./session_db.js";
import {
  EventTransitionPublisher,
  type EventSessionTransitionApplication,
} from "./event_transition_publisher.js";
import {
  sanitizeJsonText,
  sanitizeJsonValue,
  truncateJsonText,
} from "./json_text.js";
import { extractToolSearchableText } from "./tool_search_projection.js";

const LAST_MESSAGE_PREVIEW_LIMIT = 200;
const INTERNAL_DEDUPE_KEY = "_dedupe_key";

export { sanitizeJsonText, sanitizeJsonValue, truncateJsonText };

export type { EventSessionTransitionApplication } from "./event_transition_publisher.js";

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
  session_notification: "text",
  realtime_transcript: "text",
};

export class EventPersistence extends EventTransitionPublisher {
  private readonly latestPendingAckBySession = new Map<
    string,
    EventOutboxRecord
  >();

  constructor(
    private readonly db: SessionDB,
    private readonly broadcaster: SessionBroadcaster,
    private readonly logger: Logger,
    private readonly outbox: Pick<EventOutbox, "append">,
    private readonly outboxPump: Pick<
      EventOutboxPump,
      "waitForAcknowledgement" | "waitForAcknowledgementResult"
    >,
  ) {
    super();
  }

  /**
   * Persistent 이벤트를 worker의 durable JSONL outbox에 넣는다.
   * 반환은 로컬 transport 좌표이며 DB event ID가 아니다.
   */
  async enqueueEvent(
    sessionId: string,
    event: SSEEventPayload,
    explicitEffect?: EventOutboxSessionEffect,
  ): Promise<EventOutboxRecord> {
    if (!shouldPersistEvent(event)) {
      throw new Error("transient live events must not be persisted");
    }
    const record = await this.outbox.append(
      buildEventOutboxAppendInput(sessionId, event, explicitEffect),
    );
    this.latestPendingAckBySession.set(sessionId, record);
    return record;
  }

  async enqueueEventAndWaitForSessionAck(
    sessionId: string,
    event: SSEEventPayload,
    effect?: EventOutboxSessionEffect,
  ): Promise<{ record: EventOutboxRecord; eventId: number }> {
    const record = await this.enqueueEvent(sessionId, event, effect);
    const eventId = await this.outboxPump.waitForAcknowledgement(record);
    this.clearPendingAckTarget(sessionId, record.source_seq);
    return { record, eventId };
  }

  async waitForSessionAck(sessionId: string): Promise<number | null> {
    const record = this.latestPendingAckBySession.get(sessionId);
    if (!record) return null;
    const eventId = await this.outboxPump.waitForAcknowledgement(record);
    this.clearPendingAckTarget(sessionId, record.source_seq);
    return eventId;
  }

  async enqueueMetadataEffect(
    sessionId: string,
    entry: Record<string, unknown>,
    options: {
      replaceExistingType?: string;
      waitForAck?: boolean;
      semanticDedupeKey?: string;
    } = {},
  ): Promise<number | null> {
    const timestamp = new Date().toISOString();
    const event = {
      type: "metadata",
      metadata_type: entry.type,
      value: entry.value,
      label: entry.label,
      timestamp,
      ...(options.semanticDedupeKey
        ? { [INTERNAL_DEDUPE_KEY]: options.semanticDedupeKey }
        : {}),
    } as unknown as SSEEventPayload;
    const effect: EventOutboxSessionEffect = {
      kind: "append_metadata",
      entry: sanitizeJsonValue(entry) as Record<string, unknown>,
      updated_at: timestamp,
      ...(options.replaceExistingType
        ? { replace_existing_type: options.replaceExistingType }
        : {}),
    };
    if (options.waitForAck) {
      return (await this.enqueueEventAndWaitForSessionAck(sessionId, event, effect)).eventId;
    }
    await this.enqueueEvent(sessionId, event, effect);
    return null;
  }

  protected async waitForTransitionApplication(
    sessionId: string,
    record: EventOutboxRecord,
    transition: string,
  ): Promise<EventSessionTransitionApplication> {
    const acknowledgement = await this.outboxPump.waitForAcknowledgementResult(record);
    this.clearPendingAckTarget(sessionId, record.source_seq);
    const application = acknowledgement.effect_application;
    if (!application) {
      throw new Error(`${transition} transition ACK missing effect application`);
    }
    return {
      eventId: acknowledgement.event_id,
      applied: application.applied,
      canonicalSession: application.canonical_session,
      ...(application.canonical_execution_ownership
        ? {
            canonicalExecutionOwnership: {
              ownershipGeneration:
                application.canonical_execution_ownership.ownership_generation,
              ownerKind: application.canonical_execution_ownership.owner_kind,
              manifestId: application.canonical_execution_ownership.manifest_id,
              runtimeEnvIdentity:
                application.canonical_execution_ownership.runtime_env_identity
                ?? `legacy:${application.canonical_execution_ownership.manifest_id}`,
              registrationId: application.canonical_execution_ownership.registration_id,
              pid: application.canonical_execution_ownership.pid,
              startIdentity: application.canonical_execution_ownership.start_identity,
              executionCommandId:
                application.canonical_execution_ownership.execution_command_id,
              phase: application.canonical_execution_ownership.phase,
              failureReason: application.canonical_execution_ownership.failure_reason,
            },
          }
        : { canonicalExecutionOwnership: null }),
    };
  }

  private clearPendingAckTarget(sessionId: string, sourceSeq: number): void {
    if (this.latestPendingAckBySession.get(sessionId)?.source_seq === sourceSeq) {
      this.latestPendingAckBySession.delete(sessionId);
    }
  }

  /** Runtime-only state capture. Durable DB/wire effects are ingress-owned. */
  async handleSideEffects(
    sessionId: string,
    event: SSEEventPayload,
    task: Task,
  ): Promise<void> {
    const eventType = (event as { type: string }).type;
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

  }
}

export function buildEventOutboxAppendInput(
  sessionId: string,
  event: SSEEventPayload,
  explicitEffect?: EventOutboxSessionEffect,
): import("../upstream/event_outbox.js").EventOutboxAppendInput {
  if (!shouldPersistEvent(event)) {
    throw new Error("transient live events must not be persisted");
  }
  const dedupeKey = extractInternalDedupeKey(event);
  const safeEvent = stripInternalPersistenceFields(
    sanitizeJsonValue(event),
  ) as SSEEventPayload;
  const eventType = (safeEvent as { type: string }).type;
  const createdAt = extractTimestamp(event) ?? new Date();
  return {
    session_id: sessionId,
    event_type: eventType,
    payload: safeEvent,
    searchable_text: extractSearchableText(safeEvent),
    created_at: createdAt.toISOString(),
    semantic_dedupe_key: dedupeKey,
    session_effect: explicitEffect ?? buildLastMessageEffect(safeEvent, createdAt),
  };
}

function buildLastMessageEffect(
  event: SSEEventPayload,
  createdAt: Date,
): EventOutboxSessionEffect | null {
  const preview = extractPreviewText(event);
  if (!preview) return null;
  const updatedAt = createdAt.toISOString();
  return {
    kind: "last_message",
    last_message: {
      type: (event as { type: string }).type,
      preview: truncateJsonText(preview, LAST_MESSAGE_PREVIEW_LIMIT),
      timestamp: updatedAt,
    },
    updated_at: updatedAt,
  };
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
  return resolveEventDurability(event) === "transient";
}

export function shouldPersistEvent(event: SSEEventPayload): boolean {
  return resolveEventDurability(event) === "durable";
}

function resolveEventDurability(event: SSEEventPayload): EventDurability {
  const eventType = (event as { type: string }).type;
  const durability = (
    EVENT_DURABILITY as Record<string, EventDurability | undefined>
  )[eventType];
  if (durability === undefined) {
    throw new Error(`unclassified event durability: ${eventType}`);
  }
  return durability;
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
  const toolText = extractToolSearchableText(
    event as unknown as Record<string, unknown>,
  );
  if (toolText !== null) return toolText;
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
