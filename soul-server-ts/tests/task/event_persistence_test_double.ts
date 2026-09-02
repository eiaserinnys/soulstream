import { vi } from "vitest";

import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import type { Task } from "../../src/task/task_models.js";
import type { EventOutboxRecord } from "../../src/upstream/event_outbox.js";
import type { EventOutboxSessionEffect } from "../../src/upstream/event_outbox.js";

export type EventPersistenceTestDoubleCapabilityProfile =
  | "legacy_transition_only"
  | "execution_registration";

export interface EventPersistenceTestDoubleOptions {
  readonly capabilityProfile: EventPersistenceTestDoubleCapabilityProfile;
}

export function makeEventPersistenceTestDouble(
  sideEffect?: (
    sessionId: string,
    event: SSEEventPayload,
    task: Task,
  ) => Promise<void>,
  initialEvents: ReadonlyArray<{
    eventId: number;
    event: SSEEventPayload;
  }> = [],
  options: EventPersistenceTestDoubleOptions = {
    capabilityProfile: "execution_registration",
  },
) {
  let sourceSeq = initialEvents.reduce(
    (highest, fixture) => Math.max(highest, fixture.eventId),
    0,
  );
  const eventsById = new Map(
    initialEvents.map((fixture) => [fixture.eventId, fixture.event] as const),
  );
  const latestBySession = new Map<string, number>();
  type EnqueueEventArgs = Parameters<EventPersistence["enqueueEvent"]>;
  const persistSemanticEvent = vi.fn(
    async (...args: EnqueueEventArgs): Promise<unknown> => {
      const [sessionId, event, effect, registrationId] = args;
      sourceSeq += 1;
      latestBySession.set(sessionId, sourceSeq);
      eventsById.set(sourceSeq, event);
      return makeRecord(sourceSeq, sessionId, event, effect, registrationId);
    },
  );
  const semanticEvents = new Map<string, unknown>();
  const enqueueEvent = async (...args: EnqueueEventArgs): Promise<unknown> => {
    const [sessionId, event] = args;
    const dedupeKey = (event as Record<string, unknown>)._dedupe_key;
    const identity = typeof dedupeKey === "string"
      ? `${sessionId}\u0000${dedupeKey}`
      : undefined;
    if (identity && semanticEvents.has(identity)) {
      return semanticEvents.get(identity);
    }
    const persisted = await persistSemanticEvent(...args);
    if (identity) semanticEvents.set(identity, persisted);
    return persisted;
  };
  const waitForSessionAck = vi.fn(
    async (sessionId: string): Promise<number | null> => latestBySession.get(sessionId) ?? null,
  );
  const enqueueEventAndWaitForSessionAck = vi.fn(
    async (
      sessionId: string,
      event: SSEEventPayload,
      effect?: EventOutboxSessionEffect,
      registrationId?: string | null,
    ) => {
      const result = registrationId === undefined
        ? await enqueueEvent(sessionId, event, effect)
        : await enqueueEvent(sessionId, event, effect, registrationId);
      const eventId = eventIdFromResult(result, latestBySession.get(sessionId));
      latestBySession.delete(sessionId);
      return {
        record: isRecord(result)
          ? result as unknown as EventOutboxRecord
          : makeRecord(eventId, sessionId, event, effect, registrationId),
        eventId,
      };
    },
  );
  const enqueueMetadataEffect = vi.fn(
    async (
      sessionId: string,
      entry: Record<string, unknown>,
      options: {
        replaceExistingType?: string;
        waitForAck?: boolean;
        semanticDedupeKey?: string;
        registrationId?: string;
      } = {},
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
        ...(options.semanticDedupeKey
          ? { _dedupe_key: options.semanticDedupeKey }
          : {}),
      } as unknown as SSEEventPayload;
      if (options.waitForAck) {
        return (await enqueueEventAndWaitForSessionAck(
          sessionId,
          event,
          effect,
          options.registrationId,
        )).eventId;
      }
      if (options.registrationId === undefined) {
        await enqueueEvent(sessionId, event, effect);
      } else {
        await enqueueEvent(sessionId, event, effect, options.registrationId);
      }
      return null;
    },
  );
  const enqueueRunningTransition = vi.fn(
    async (
      sessionId: string,
      input: {
        reviewState: string;
        transitionId: string;
        registrationId?: string;
        expectedTerminalEventId?: number | null;
        updatedAt?: Date;
      },
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
          ...(input.expectedTerminalEventId === undefined
            ? {}
            : { expected_terminal_event_id: input.expectedTerminalEventId }),
          updated_at: timestamp,
        },
        input.registrationId,
      );
    },
  );
  const enqueueRunningTransitionAndWaitForAck = vi.fn(
    async (
      sessionId: string,
      input: {
        reviewState: string;
        transitionId: string;
        expectedTerminalEventId?: number | null;
        updatedAt?: Date;
      },
    ): Promise<number> => {
      const record = await enqueueRunningTransition(sessionId, input);
      latestBySession.delete(sessionId);
      return record.source_seq;
    },
  );
  const enqueueRunningTransitionAndWaitForApplication = vi.fn(
    async (
      sessionId: string,
      input: {
        reviewState: string;
        transitionId: string;
        expectedTerminalEventId?: number | null;
        updatedAt?: Date;
      },
    ) => {
      const record = await enqueueRunningTransition(sessionId, input);
      latestBySession.delete(sessionId);
      return {
        eventId: record.source_seq,
        applied: true,
        canonicalSession: {
          status: "running",
          termination_reason: null,
          termination_detail: null,
          review_state: input.reviewState,
          last_assistant_text: null,
          termination_event_id: null,
          updated_at: input.updatedAt?.toISOString() ?? new Date().toISOString(),
          // Transport source_seq is not a DB event id. Preserve the Task's
          // existing DB cursor unless a test supplies an explicit projection.
          last_event_id: null,
        },
      };
    },
  );
  const enqueueTerminalTransitionAndWaitForApplication = vi.fn(
    async (
      sessionId: string,
      event: SSEEventPayload,
      effect: Extract<EventOutboxSessionEffect, { kind: "terminal_transition" }>,
      registrationId?: string,
    ) => {
      const result = await enqueueEvent(sessionId, event, effect, registrationId);
      const eventId = eventIdFromResult(result, latestBySession.get(sessionId));
      latestBySession.delete(sessionId);
      return {
        eventId,
        applied: true,
        canonicalSession: {
          status: effect.status,
          termination_reason: effect.termination_reason,
          termination_detail: effect.termination_detail,
          review_state: effect.review_state,
          last_assistant_text: effect.last_assistant_text ?? null,
          termination_event_id: eventId,
          updated_at: effect.updated_at,
          last_event_id: eventId,
        },
      };
    },
  );
  const recordExecutionRegistrationAndWaitForApplication = vi.fn(
    async (
      _sessionId: string,
      input: {
        registrationId: string;
        executionCommandId: string;
        reviewState: string;
        expectedTerminalEventId?: number | null;
        updatedAt?: Date;
      },
    ) => ({
      eventId: ++sourceSeq,
      applied: true,
      canonicalSession: {
        status: "running",
        termination_reason: null,
        termination_detail: null,
        review_state: input.reviewState,
        last_assistant_text: null,
        termination_event_id: null,
        updated_at: input.updatedAt?.toISOString() ?? new Date().toISOString(),
        last_event_id: null,
      },
      canonicalExecutionRegistration: {
        registrationId: input.registrationId,
        executionCommandId: input.executionCommandId,
      },
    }),
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
    enqueueRunningTransitionAndWaitForApplication,
    enqueueTerminalTransitionAndWaitForApplication: async (
      sessionId: string,
      event: SSEEventPayload,
      effect: Extract<EventOutboxSessionEffect, { kind: "terminal_transition" }>,
      registrationId?: string,
    ) => registrationId === undefined
      ? await enqueueTerminalTransitionAndWaitForApplication(sessionId, event, effect)
      : await enqueueTerminalTransitionAndWaitForApplication(
          sessionId,
          event,
          effect,
          registrationId,
        ),
    ...(options.capabilityProfile === "execution_registration"
      ? {
          recordExecutionRegistrationAndWaitForApplication,
        }
      : {}),
    waitForSessionAck,
    handleSideEffects,
  } as unknown as EventPersistence;

  return {
    persistence,
    enqueueEvent: persistSemanticEvent,
    enqueueEventAndWaitForSessionAck,
    enqueueMetadataEffect,
    enqueueRunningTransition,
    enqueueRunningTransitionAndWaitForAck,
    enqueueRunningTransitionAndWaitForApplication,
    enqueueTerminalTransitionAndWaitForApplication,
    recordExecutionRegistrationAndWaitForApplication,
    waitForSessionAck,
    handleSideEffects,
    getEventById(eventId: number): SSEEventPayload | undefined {
      return eventsById.get(eventId);
    },
  };
}

function makeRecord(
  sourceSeq: number,
  sessionId: string,
  event: SSEEventPayload,
  effect?: EventOutboxSessionEffect,
  registrationId?: string | null,
): EventOutboxRecord {
  const semanticDedupeKey = (event as Record<string, unknown>)._dedupe_key;
  return {
    stream_id: "stream-test",
    source_seq: sourceSeq,
    session_id: sessionId,
    ...(registrationId === undefined ? {} : { registration_id: registrationId }),
    event_type: event.type,
    payload: event,
    searchable_text: null,
    created_at: new Date().toISOString(),
    semantic_dedupe_key: typeof semanticDedupeKey === "string"
      ? semanticDedupeKey
      : null,
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
