export type SessionHistoryRawEvent = {
  eventId: number;
  eventType: string;
  payloadText: string;
};

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
  ) => Promise<[unknown[], string | null]>;
  readTimelineTrace: (sessionId: string, timelineId: string) => Promise<unknown | null | undefined>;
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
  ): Promise<SessionHistoryPageResponse> {
    const [messages, nextCursor] = await this.provider.readTimeline(sessionId, before, limit);
    return { messages, next_cursor: nextCursor };
  }

  readTimelineTrace(sessionId: string, timelineId: string): Promise<unknown | null | undefined> {
    return this.provider.readTimelineTrace(sessionId, timelineId);
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
