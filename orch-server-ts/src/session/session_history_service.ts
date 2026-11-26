import type { SessionStoryViewResponse } from "@soulstream/mcp-contract";
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
import type { SessionEventAttachmentResponse } from "@soulstream/wire-schema/attachments";

export type RequestedTimelineEventType = SessionTimelineEventType | "complete";

export const DEFAULT_TIMELINE_DEBUG_KINDS = [
  "assigned_card_context_snapshot",
  "persistent_jev_candidates",
  "persistent_instruction_recorded",
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

export type SessionHistoryEventRecord = {
  id: number;
  event: unknown;
};

const REQUESTED_TIMELINE_EVENT_TYPE_SET = new Set<string>([
  ...SESSION_TIMELINE_EVENT_TYPES,
  "complete",
]);

/**
 * 지운 OpenAI Agents 이벤트 이름. EAS Update 없이 쓰이는 옛 soul-app이 이력 조회에
 * 이 이름을 `event_types`로 계속 보내므로 받아들이되 조회에서는 뺀다.
 */
export const RETIRED_TIMELINE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "agent_updated",
  "handoff_requested",
  "handoff_occurred",
  "guardrail_tripwire",
]);

export function isRetiredTimelineEventType(value: string): boolean {
  return RETIRED_TIMELINE_EVENT_TYPES.has(value);
}

export function isRequestedTimelineEventType(value: string): value is RequestedTimelineEventType {
  return REQUESTED_TIMELINE_EVENT_TYPE_SET.has(value);
}

/**
 * 사람이 보낸 메시지가 전달 장부에서 dead_letter로 닫힌 기록. 클라이언트는
 * input_id를 이벤트의 `data.input_id`와 맞춰 그 말풍선에 실패 표시를 켠다.
 */
export type SessionDeliveryFailureRecord = {
  input_id: string;
  reason: string | null;
  failed_at: Date | string | null;
};

export type SessionHistoryProvider = {
  readConversation?: (sessionId: string, limit?: string) => Promise<import("./session_conversation_projection.js").CardSessionMessages | null>;
  readDeliveryFailures?: (sessionId: string) => Promise<SessionDeliveryFailureRecord[]>;
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
  readStory: (sessionId: string) => Promise<SessionStoryViewResponse>;
  readTurnSummaries: (
    sessionId: string,
    query: SessionTurnSummaryQuery,
  ) => Promise<SessionTurnSummaryResponse>;
  readLastEventId: (sessionId: string) => Promise<number>;
  readEvent: (
    sessionId: string,
    eventId: number,
  ) => Promise<SessionHistoryEventRecord | null>;
  readEventAttachments?: (
    sessionId: string,
    eventId: number,
  ) => Promise<SessionEventAttachmentResponse | null>;
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

  async readDeliveryFailures(
    sessionId: string,
  ): Promise<SessionDeliveryFailureRecord[]> {
    return await this.provider.readDeliveryFailures?.(sessionId) ?? [];
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

  readStory(sessionId: string): Promise<SessionStoryViewResponse> {
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

  readEvent(
    sessionId: string,
    eventId: number,
  ): Promise<SessionHistoryEventRecord | null> {
    return this.provider.readEvent(sessionId, eventId);
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
