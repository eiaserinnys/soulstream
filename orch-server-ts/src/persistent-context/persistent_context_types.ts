import type { PersistentJevObservation } from "@soulstream/wire-schema";

export type PersistentContextEvaluationInput = {
  readonly sessionId: string;
  readonly inputId: string;
  readonly request: string;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
};

export type PersistentContextEvaluationResult = {
  readonly observation: PersistentJevObservation | null;
};

export type PersistentContextRawCandidates = {
  readonly sessionIsPersistent: boolean;
  readonly inputEventId: number | null;
  readonly allowedFolderIds: readonly string[];
  readonly turnSummaries: readonly {
    readonly eventId: number;
    readonly turnNumber: number;
    readonly content: string;
  }[];
  readonly cards: readonly {
    readonly id: string;
    readonly number: number | null;
    readonly title: string;
    readonly request: string;
    readonly brief: string;
  }[];
  readonly recentCompletedSessions: readonly {
    readonly sessionId: string;
    readonly title: string;
    readonly lastAssistantText: string;
  }[];
};
