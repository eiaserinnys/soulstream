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

export interface GenerationCheckpointReadLimits {
  readonly recentEventLimit: number;
  readonly unsummarizedEventLimit: number;
}

export interface GenerationCheckpointMaterial {
  readonly story: SessionStoryView;
  readonly lastSummarizedFinalResponseEventId: number | null;
  readonly recent: {
    readonly records: Array<{
      readonly event_id: number;
      readonly event_type: string;
      readonly text: string;
      readonly created_at: string;
    }>;
    readonly omittedUnsummarized: number;
  };
  readonly childSessions: Array<{
    readonly sessionId: string;
    readonly displayName: string | null;
    readonly agentId: string | null;
    readonly modelPreset: string | null;
    readonly status: "initializing" | "running";
    readonly cardId: string | null;
    /**
     * `#412.s2`, when the session is attached to a card that has a number. Optional because a central
     * server that predates card numbers does not send it; either way the full ID is written instead.
     */
    readonly reference?: string | null;
    readonly createdAt: string;
  }>;
  readonly childSessionTotal: number;
  readonly totals: {
    readonly events: number;
    readonly turnSummaries: number;
  };
}

export interface SupervisedCardSnapshot {
  readonly capturedAt: string;
  readonly counts: {
    readonly running: number;
    readonly blocked: number;
    readonly review: number;
    readonly queued: number;
    readonly todo: number;
  };
  readonly cards: Array<{
    readonly id: string;
    /** Card number (`#412`). Optional and nullable for the same reason as `reference` above. */
    readonly number?: number | null;
    readonly title: string;
    readonly status: "running" | "blocked" | "review" | "queued";
    readonly blockedKind: "limit" | "question" | "no_report" | null;
    readonly assignee: {
      readonly kind: "agent" | "session" | "human" | null;
      readonly agentId: string | null;
      readonly sessionId: string | null;
    };
  }>;
  readonly openQuestions: Array<{
    readonly id: string;
    readonly cardId: string;
    /** Number of the question's card; optional and nullable like `number` above. */
    readonly cardNumber?: number | null;
    readonly cardTitle: string;
    readonly text: string;
    readonly askedAt: string;
  }>;
  readonly openQuestionTotal: number;
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
