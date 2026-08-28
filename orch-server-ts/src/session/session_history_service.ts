import type { SessionStoryResponse } from "./session_story_read_service.js";
import type {
  SessionTurnSummaryQuery,
  SessionTurnSummaryResponse,
} from "./session_turn_summary_read_service.js";

export type SessionHistoryRawEvent = {
  eventId: number;
  eventType: string;
  payloadText: string;
  sessionEffectApplied?: boolean;
};

export const SESSION_TIMELINE_EVENT_TYPES = [
  "user_message",
  "intervention_sent",
  "session_notification",
  "assistant_message",
  "turn_summary",
  "thinking",
  "tool_start",
  "tool_result",
  "error",
  "assistant_error",
  "system",
  "system_message",
  "context_usage",
  "compact",
  "input_request",
  "input_request_expired",
  "input_request_responded",
  "tool_approval_requested",
  "tool_approval_resolved",
  "agent_updated",
  "handoff_requested",
  "handoff_occurred",
  "guardrail_tripwire",
  "away_summary",
  "credential_alert",
  "realtime_status",
  "realtime_transcript",
] as const;

export type SessionTimelineEventType = typeof SESSION_TIMELINE_EVENT_TYPES[number];

const SESSION_TIMELINE_EVENT_TYPE_SET = new Set<string>(SESSION_TIMELINE_EVENT_TYPES);

export function isSessionTimelineEventType(value: string): value is SessionTimelineEventType {
  return SESSION_TIMELINE_EVENT_TYPE_SET.has(value);
}

export type SessionHistoryProvider = {
  readViewport: (sessionId: string, yMin: number, yMax: number) => Promise<unknown>;
  readMessages: (
    sessionId: string,
    before: string | null,
    limit: number,
  ) => Promise<[unknown[], string | null]>;
  readTimeline: (
    sessionId: string,
    before: string | null,
    limit: number,
    eventTypes?: readonly SessionTimelineEventType[],
  ) => Promise<[unknown[], string | null]>;
  readTimelineTrace: (sessionId: string, timelineId: string) => Promise<unknown | null | undefined>;
  readStory: (sessionId: string) => Promise<SessionStoryResponse>;
  readTurnSummaries: (
    sessionId: string,
    query: SessionTurnSummaryQuery,
  ) => Promise<SessionTurnSummaryResponse>;
  readLastEventId: (sessionId: string) => Promise<number>;
  streamEventsRaw: (
    sessionId: string,
    afterId: number,
  ) => AsyncIterable<SessionHistoryRawEvent>;
};

export type SessionHistoryPageResponse = {
  messages: unknown[];
  next_cursor: string | null;
};

export type SessionHistoryReadServiceOptions = {
  provider: SessionHistoryProvider;
};

const LIVE_ONLY_TEXT_TYPES = new Set(["text_start", "text_delta", "text_end"]);

export class SessionHistoryReadService {
  private readonly provider: SessionHistoryProvider;

  constructor(options: SessionHistoryReadServiceOptions) {
    this.provider = options.provider;
  }

  readViewport(sessionId: string, yMin: number, yMax: number): Promise<unknown> {
    return this.provider.readViewport(sessionId, yMin, yMax);
  }

  async readMessagesPage(
    sessionId: string,
    before: string | null,
    limit: number,
  ): Promise<SessionHistoryPageResponse> {
    const [messages, nextCursor] = await this.provider.readMessages(sessionId, before, limit);
    return { messages, next_cursor: nextCursor };
  }

  async readTimelinePage(
    sessionId: string,
    before: string | null,
    limit: number,
    eventTypes?: readonly SessionTimelineEventType[],
  ): Promise<SessionHistoryPageResponse> {
    const [messages, nextCursor] = eventTypes === undefined
      ? await this.provider.readTimeline(sessionId, before, limit)
      : await this.provider.readTimeline(sessionId, before, limit, eventTypes);
    return { messages, next_cursor: nextCursor };
  }

  readTimelineTrace(sessionId: string, timelineId: string): Promise<unknown | null | undefined> {
    return this.provider.readTimelineTrace(sessionId, timelineId);
  }

  readStory(sessionId: string): Promise<SessionStoryResponse> {
    return this.provider.readStory(sessionId);
  }

  readTurnSummaries(
    sessionId: string,
    query: SessionTurnSummaryQuery,
  ): Promise<SessionTurnSummaryResponse> {
    return this.provider.readTurnSummaries(sessionId, query);
  }

  readLastEventId(sessionId: string): Promise<number> {
    return this.provider.readLastEventId(sessionId);
  }

  streamEventsRaw(sessionId: string, afterId: number): AsyncIterable<SessionHistoryRawEvent> {
    return this.provider.streamEventsRaw(sessionId, afterId);
  }
}

export function filterFinalizedAppServerReplayEvents(
  events: SessionHistoryRawEvent[],
): SessionHistoryRawEvent[] {
  const payloadsById = new Map<number, Record<string, unknown>>();
  const finalizedStreams = new Set<string>();

  for (const event of events) {
    const payload = parseEventPayload(event.payloadText);
    if (payload === null) continue;
    payloadsById.set(event.eventId, payload);
    if (isFinalAppServerAssistantMessage(payload)) {
      const streamKey = appServerTextStreamKey(payload);
      if (streamKey !== null) {
        finalizedStreams.add(streamKey);
      }
    }
  }

  if (finalizedStreams.size === 0) {
    return events;
  }

  return events.filter((event) => {
    const payload = payloadsById.get(event.eventId);
    return !(
      payload !== undefined &&
      isAppServerLiveTextFragment(payload) &&
      finalizedStreams.has(appServerTextStreamKey(payload) ?? "")
    );
  });
}

function parseEventPayload(payloadText: string): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(payloadText) as unknown;
    return typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function appServerTextStreamKey(payload: Record<string, unknown>): string | null {
  const toolUseId = payload.tool_use_id;
  return typeof toolUseId === "string" && toolUseId.length > 0 ? toolUseId : null;
}

function isAppServerLiveTextFragment(payload: Record<string, unknown>): boolean {
  return (
    payload._live_only === true &&
    typeof payload.type === "string" &&
    LIVE_ONLY_TEXT_TYPES.has(payload.type) &&
    appServerTextStreamKey(payload) !== null
  );
}

function isFinalAppServerAssistantMessage(payload: Record<string, unknown>): boolean {
  return (
    payload.type === "assistant_message" &&
    payload._final_for_live_stream === true &&
    appServerTextStreamKey(payload) !== null
  );
}
