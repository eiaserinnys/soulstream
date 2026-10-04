import {
  SessionHistoryReadService,
  filterFinalizedAppServerReplayEvents,
  type SessionHistoryRawEvent,
} from "./session_history_service.js";
import { shouldPublishSessionEventSemantically } from "./session_event_semantic_publication.js";
import type { SessionHistoryResetReason } from "./session_feed_contract.js";

export type SessionHistorySseFrame = {
  event: string;
  data: string;
  id?: string | number;
};

export type SessionHistoryInitialState = {
  readonly frames: SessionHistorySseFrame[];
  readonly afterId: number;
  readonly lastStoredId: number;
  lastSeenEventId: number;
  readonly resetReason?: SessionHistoryResetReason;
};

const SNAPSHOT_CATCHUP_MAX_EVENTS = 200;

export async function buildSessionHistoryInitialState(
  service: SessionHistoryReadService,
  sessionId: string,
  afterId: number,
  snapshotCatchup: boolean,
): Promise<SessionHistoryInitialState> {
  const frames: SessionHistorySseFrame[] = [
    { event: "init", data: JSON.stringify({ agentSessionId: sessionId }) },
  ];
  const durableWatermark = await service.readLastEventId(sessionId);
  if (afterId === 0) {
    return { frames, afterId, lastStoredId: durableWatermark, lastSeenEventId: durableWatermark };
  }

  const events = snapshotCatchup
    ? service.streamEventsRaw(sessionId, afterId, {
        limit: SNAPSHOT_CATCHUP_MAX_EVENTS + 1,
        throughId: durableWatermark,
      })
    : service.streamEventsRaw(sessionId, afterId);
  let firstStoredId: number | undefined;
  let lastReplayedId = 0;
  const replayEvents: SessionHistoryRawEvent[] = [];
  for await (const event of events) {
    if (event.eventId <= afterId) continue;
    firstStoredId ??= event.eventId;
    lastReplayedId = Math.max(lastReplayedId, event.eventId);
    replayEvents.push(event);
  }
  // Count raw rows before publication filters; no durable frame is emitted on overflow.
  if (snapshotCatchup && replayEvents.length > SNAPSHOT_CATCHUP_MAX_EVENTS) {
    return {
      frames, afterId, lastStoredId: durableWatermark, lastSeenEventId: durableWatermark,
      resetReason: "catchup_overflow",
    };
  }

  const semanticReplayEvents = replayEvents.filter((event) =>
    shouldPublishSessionEventSemantically({
      eventType: event.eventType,
      sessionEffectApplied: event.sessionEffectApplied,
    }));
  for (const event of filterFinalizedAppServerReplayEvents(semanticReplayEvents)) {
    frames.push({ event: event.eventType, id: event.eventId, data: event.payloadText });
  }
  const effectiveDurableWatermark = Math.max(durableWatermark, lastReplayedId);
  const resetReason = afterId > effectiveDurableWatermark
    ? "cursor_ahead" as const
    : afterId < effectiveDurableWatermark &&
        (firstStoredId === undefined || firstStoredId > afterId + 1)
      ? "history_gap" as const
      : undefined;
  const lastStoredId = Math.max(afterId, effectiveDurableWatermark);
  return {
    frames, afterId, lastStoredId, lastSeenEventId: Math.max(afterId, lastStoredId),
    ...(resetReason === undefined ? {} : { resetReason }),
  };
}
