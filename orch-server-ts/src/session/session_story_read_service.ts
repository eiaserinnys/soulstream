import type {
  SessionStoryRepositoryPort,
  UnfoldedTurnSummary,
} from "../turn-summary/session_story_repository.js";

export type SessionStoryTurnSummaryResponse = {
  event_id: number;
  turn_number: number;
  content: string;
  turn_start_event_id: number | null;
  final_response_event_id: number | null;
  created_at: string;
};

export type SessionStoryResponse = {
  highlight: string | null;
  narrative: string | null;
  unfolded_turn_summaries: SessionStoryTurnSummaryResponse[];
  narrative_through_event_id: number | null;
  fold_count: number;
  updated_at: string | null;
};

type SessionStoryReadRepository = Pick<
  SessionStoryRepositoryPort,
  "loadDigest" | "countUnfoldedSummaries" | "loadUnfoldedSummaries"
>;

export class SessionStoryReadService {
  constructor(private readonly repository: SessionStoryReadRepository) {}

  async readStory(sessionId: string): Promise<SessionStoryResponse> {
    const digest = await this.repository.loadDigest(sessionId);
    const watermark = digest?.narrativeThroughEventId ?? null;
    const unfoldedCount = await this.repository.countUnfoldedSummaries(
      sessionId,
      watermark,
    );
    const unfolded = unfoldedCount === 0
      ? []
      : await this.repository.loadUnfoldedSummaries(
          sessionId,
          watermark,
          unfoldedCount,
        );

    return {
      highlight: digest?.highlight ?? null,
      narrative: digest?.narrative ?? null,
      unfolded_turn_summaries: unfolded.map(serializeSummary),
      narrative_through_event_id: digest?.narrativeThroughEventId ?? null,
      fold_count: digest?.foldCount ?? 0,
      updated_at: digest?.updatedAt.toISOString() ?? null,
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
