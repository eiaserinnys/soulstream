import type {
  SessionTurnSummaryRepositoryPort,
  UnfoldedTurnSummary,
} from "../turn-summary/session_story_repository.js";
import type { SessionStoryTurnSummaryResponse } from
  "./session_story_read_service.js";

export type SessionTurnSummaryQuery =
  | { mode: "count" }
  | { mode: "index"; turnNumber: number }
  | {
      mode: "range";
      fromTurnNumber: number;
      toTurnNumber: number | null;
      limit: number;
    };

export type SessionTurnSummaryCountResponse = {
  session_id: string;
  mode: "count";
  total_count: number;
  digested_count: number;
  undigested_count: number;
};

export type SessionTurnSummaryIndexResponse = {
  session_id: string;
  mode: "index";
  turn_number: number;
  summary: SessionStoryTurnSummaryResponse | null;
};

export type SessionTurnSummaryRangeResponse = {
  session_id: string;
  mode: "range";
  from_turn_number: number;
  to_turn_number: number | null;
  limit: number;
  summaries: SessionStoryTurnSummaryResponse[];
  has_more: boolean;
  next_from_turn_number: number | null;
};

export type SessionTurnSummaryResponse =
  | SessionTurnSummaryCountResponse
  | SessionTurnSummaryIndexResponse
  | SessionTurnSummaryRangeResponse;

export class SessionTurnSummaryReadService {
  constructor(private readonly repository: SessionTurnSummaryRepositoryPort) {}

  async read(
    sessionId: string,
    query: SessionTurnSummaryQuery,
  ): Promise<SessionTurnSummaryResponse> {
    if (query.mode === "count") {
      const counts = await this.repository.countTurnSummaries(sessionId);
      return {
        session_id: sessionId,
        mode: "count",
        total_count: counts.totalCount,
        digested_count: counts.digestedCount,
        undigested_count: counts.undigestedCount,
      };
    }
    if (query.mode === "index") {
      const summaries = await this.repository.loadTurnSummaryRange(
        sessionId,
        query.turnNumber,
        query.turnNumber,
        1,
      );
      return {
        session_id: sessionId,
        mode: "index",
        turn_number: query.turnNumber,
        summary: summaries[0] ? serializeSummary(summaries[0]) : null,
      };
    }
    const fetched = await this.repository.loadTurnSummaryRange(
      sessionId,
      query.fromTurnNumber,
      query.toTurnNumber,
      query.limit + 1,
    );
    const hasMore = fetched.length > query.limit;
    const page = hasMore ? fetched.slice(0, query.limit) : fetched;
    return {
      session_id: sessionId,
      mode: "range",
      from_turn_number: query.fromTurnNumber,
      to_turn_number: query.toTurnNumber,
      limit: query.limit,
      summaries: page.map(serializeSummary),
      has_more: hasMore,
      next_from_turn_number: hasMore
        ? fetched[query.limit]?.turnNumber ?? null
        : null,
    };
  }
}

function serializeSummary(
  summary: UnfoldedTurnSummary,
): SessionStoryTurnSummaryResponse {
  return {
    event_id: summary.eventId,
    turn_number: summary.turnNumber,
    content: summary.content,
    turn_start_event_id: summary.turnStartEventId,
    final_response_event_id: summary.finalResponseEventId,
    created_at: summary.createdAt.toISOString(),
  };
}
