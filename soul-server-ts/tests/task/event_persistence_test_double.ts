import { vi } from "vitest";

import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import type { Task } from "../../src/task/task_models.js";
import type { EventOutboxRecord } from "../../src/upstream/event_outbox.js";
import type { EventOutboxSessionEffect } from "../../src/upstream/event_outbox.js";

export function makeEventPersistenceTestDouble(
  sideEffect?: (
    sessionId: string,
    event: SSEEventPayload,
    task: Task,
  ) => Promise<void>,
) {
  let sourceSeq = 0;
  const latestBySession = new Map<string, number>();
  const enqueueEvent = vi.fn(
    async (
      sessionId: string,
      event: SSEEventPayload,
      effect?: EventOutboxSessionEffect,
    ): Promise<unknown> => {
      sourceSeq += 1;
      latestBySession.set(sessionId, sourceSeq);
      return makeRecord(sourceSeq, sessionId, event, effect);
    },
  );
  const waitForSessionAck = vi.fn(
    async (sessionId: string): Promise<number | null> => latestBySession.get(sessionId) ?? null,
  );
  const enqueueEventAndWaitForSessionAck = vi.fn(
    async (
      sessionId: string,
      event: SSEEventPayload,
      effect?: EventOutboxSessionEffect,
    ) => {
      const result = await enqueueEvent(sessionId, event, effect);
      const eventId = eventIdFromResult(result, latestBySession.get(sessionId));
      latestBySession.delete(sessionId);
      return {
        record: isRecord(result)
          ? result as unknown as EventOutboxRecord
          : makeRecord(eventId, sessionId, event, effect),
        eventId,
      };
    },
  );
  const enqueueMetadataEffect = vi.fn(
    async (
      sessionId: string,
      entry: Record<string, unknown>,
      options: { replaceExistingType?: string; waitForAck?: boolean } = {},
    ): Promise<number | null> => {
      const effect: EventOutboxSessionEffect = {
        kind: "append_metadata",
        entry,
        updated_at: new Date().toISOString(),
        ...(options.replaceExistingType
          ? { replace_existing_type: options.replaceExistingType }
          : {}),
      };
      const event = {
        type: "metadata",
        metadata_type: entry.type,
        value: entry.value,
      } as unknown as SSEEventPayload;
      if (options.waitForAck) {
        return (await enqueueEventAndWaitForSessionAck(sessionId, event, effect)).eventId;
      }
      await enqueueEvent(sessionId, event, effect);
      return null;
    },
  );
  const enqueueRunningTransition = vi.fn(
    async (
      sessionId: string,
      input: { reviewState: string; transitionId: string; updatedAt?: Date },
    ): Promise<EventOutboxRecord> => {
      const timestamp = (input.updatedAt ?? new Date()).toISOString();
      sourceSeq += 1;
      latestBySession.set(sessionId, sourceSeq);
      return makeRecord(
        sourceSeq,
        sessionId,
        {
          type: "metadata",
          metadata_type: "session_status_transition",
          value: { status: "running", transition_id: input.transitionId },
          timestamp,
        } as unknown as SSEEventPayload,
        {
          kind: "running_transition",
          review_state: input.reviewState,
          updated_at: timestamp,
        },
      );
    },
  );
  const enqueueRunningTransitionAndWaitForAck = vi.fn(
    async (
      sessionId: string,
      input: { reviewState: string; transitionId: string; updatedAt?: Date },
    ): Promise<number> => {
      const record = await enqueueRunningTransition(sessionId, input);
      latestBySession.delete(sessionId);
      return record.source_seq;
    },
  );
  const handleSideEffects = vi.fn(
    sideEffect ?? (async () => undefined),
  );
  const persistence = {
    enqueueEvent,
    enqueueEventAndWaitForSessionAck,
    enqueueMetadataEffect,
    enqueueRunningTransition,
    enqueueRunningTransitionAndWaitForAck,
    waitForSessionAck,
    handleSideEffects,
  } as unknown as EventPersistence;

  return {
    persistence,
    enqueueEvent,
    enqueueEventAndWaitForSessionAck,
    enqueueMetadataEffect,
    enqueueRunningTransition,
    enqueueRunningTransitionAndWaitForAck,
    waitForSessionAck,
    handleSideEffects,
  };
}

function makeRecord(
  sourceSeq: number,
  sessionId: string,
  event: SSEEventPayload,
  effect?: EventOutboxSessionEffect,
): EventOutboxRecord {
  return {
    stream_id: "stream-test",
    source_seq: sourceSeq,
    session_id: sessionId,
    event_type: event.type,
    payload: event,
    searchable_text: null,
    created_at: new Date().toISOString(),
    semantic_dedupe_key: null,
    session_effect: effect ?? null,
    payload_hash: `${sourceSeq}`.padStart(64, "0"),
  };
}

function eventIdFromResult(result: unknown, fallback: number | undefined): number {
  if (typeof result === "number") return result;
  if (isRecord(result) && typeof result.source_seq === "number") return result.source_seq;
  if (fallback !== undefined) return fallback;
  throw new Error("event persistence test double received no event ID");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
