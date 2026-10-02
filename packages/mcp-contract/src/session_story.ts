export interface SessionStoryTurnSummary {
  readonly eventId: number;
  readonly turnNumber: number;
  readonly content: string;
  readonly turnStartEventId: number | null;
  readonly finalResponseEventId: number | null;
  readonly createdAt: Date;
}

export interface SessionStoryView {
  readonly highlight: string | null;
  readonly narrative: string | null;
  readonly unfoldedTurnSummaries: SessionStoryTurnSummary[];
  readonly narrativeThroughEventId: number | null;
  readonly foldCount: number;
  readonly updatedAt: Date | null;
}

export interface SessionTurnSummaryCounts {
  readonly totalCount: number;
  readonly digestedCount: number;
  readonly undigestedCount: number;
}

export interface SessionSearchMetadata {
  readonly turnCount: number;
  readonly hasTurnSummaries: boolean;
  readonly hasStoryDigest: boolean;
  readonly hasHighlight: boolean;
}

export interface SessionDigestSearchMatch {
  readonly id: number;
  readonly session_id: string;
  readonly event_type: "session_highlight" | "session_story";
  readonly searchable_text: string;
  readonly score: number;
  readonly match_source: "highlight" | "story";
}

export function serializeSessionStoryTurnSummary(
  summary: SessionStoryTurnSummary,
): {
  event_id: number;
  turn_number: number;
  content: string;
  turn_start_event_id: number | null;
  final_response_event_id: number | null;
  created_at: string;
} {
  return {
    event_id: summary.eventId,
    turn_number: summary.turnNumber,
    content: summary.content,
    turn_start_event_id: summary.turnStartEventId,
    final_response_event_id: summary.finalResponseEventId,
    created_at: summary.createdAt.toISOString(),
  };
}
export function serializeSessionStoryView(story: SessionStoryView): {
  highlight: string | null;
  narrative: string | null;
  unfolded_turn_summaries: Array<{
    event_id: number;
    turn_number: number;
    content: string;
    turn_start_event_id: number | null;
    final_response_event_id: number | null;
    created_at: string;
  }>;
  narrative_through_event_id: number | null;
  fold_count: number;
  updated_at: string | null;
} {
  return {
    highlight: story.highlight,
    narrative: story.narrative,
    unfolded_turn_summaries:
      story.unfoldedTurnSummaries.map(serializeSessionStoryTurnSummary),
    narrative_through_event_id: story.narrativeThroughEventId,
    fold_count: story.foldCount,
    updated_at: story.updatedAt?.toISOString() ?? null,
  };
}
