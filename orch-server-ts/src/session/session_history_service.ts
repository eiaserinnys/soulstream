import type { SessionStoryResponse } from "./session_story_read_service.js";
import type {
  SessionConversationContextQuery,
  SessionConversationContextResponse,
} from "./session_conversation_context.js";
import type {
  SessionTurnSummaryQuery,
  SessionTurnSummaryResponse,
} from "./session_turn_summary_read_service.js";
import {
  SESSION_TIMELINE_EVENT_TYPES,
  type SessionTimelineEventType,
} from "@soulstream/wire-schema";

export { SESSION_TIMELINE_EVENT_TYPES } from "@soulstream/wire-schema";
export type { SessionTimelineEventType } from "@soulstream/wire-schema";

export type RequestedTimelineEventType = SessionTimelineEventType | "complete";

export const DEFAULT_TIMELINE_DEBUG_KINDS = [
  "assigned_card_context_snapshot",
  "persistent_jev_candidates",
] as const;

export type RequestedTimelineDebugKind =
  | (typeof DEFAULT_TIMELINE_DEBUG_KINDS)[number]
  | "persistent_decision";

export const ALLOWED_TIMELINE_DEBUG_KINDS = new Set<RequestedTimelineDebugKind>([
  ...DEFAULT_TIMELINE_DEBUG_KINDS,
  "persistent_decision",
]);

export type SessionHistoryRawEvent = {
  eventId: number;
  eventType: string;
  payloadText: string;
  sessionEffectApplied?: boolean;
};

export type SessionHistoryReplayRange = {
  readonly limit?: number;
  readonly throughId?: number;
};

const REQUESTED_TIMELINE_EVENT_TYPE_SET = new Set<string>([
  ...SESSION_TIMELINE_EVENT_TYPES,
  "complete",
]);

export function isRequestedTimelineEventType(value: string): value is RequestedTimelineEventType {
  return REQUESTED_TIMELINE_EVENT_TYPE_SET.has(value);
}

export type SessionHistoryProvider = {
  readViewport: (sessionId: string, yMin: number, yMax: number) => Promise<unknown>;
  readMessages: (
    sessionId: string,
    before: string | null,
    limit: number,
  ) => Promise<[unknown[], string | null]>;
  readConversationContext: (
    sessionId: string,
    query: SessionConversationContextQuery,
  ) => Promise<SessionConversationContextResponse | null>;
  readTimeline: (
    sessionId: string,
    before: string | null,
    limit: number,
    eventTypes?: readonly RequestedTimelineEventType[],
    debugKinds?: readonly RequestedTimelineDebugKind[],
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
    range?: SessionHistoryReplayRange,
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

  readConversationContext(
    sessionId: string,
    query: SessionConversationContextQuery,
  ): Promise<SessionConversationContextResponse | null> {
    return this.provider.readConversationContext(sessionId, query);
  }

  async readTimelinePage(
    sessionId: string,
    before: string | null,
    limit: number,
    eventTypes?: readonly RequestedTimelineEventType[],
    debugKinds?: readonly RequestedTimelineDebugKind[],
  ): Promise<SessionHistoryPageResponse> {
    const [messages, nextCursor] = debugKinds === undefined
      ? eventTypes === undefined
        ? await this.provider.readTimeline(sessionId, before, limit)
        : await this.provider.readTimeline(sessionId, before, limit, eventTypes)
      : await this.provider.readTimeline(sessionId, before, limit, eventTypes, debugKinds);
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

  streamEventsRaw(
    sessionId: string,
    afterId: number,
    range?: SessionHistoryReplayRange,
  ): AsyncIterable<SessionHistoryRawEvent> {
    return range === undefined
      ? this.provider.streamEventsRaw(sessionId, afterId)
      : this.provider.streamEventsRaw(sessionId, afterId, range);
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
