export interface AssignedCardContextSnapshotCard {
  id: string;
  title: string;
  status: string;
  hasItems?: boolean;
  latestCommentAt?: string | null;
  latestReportAt?: string | null;
  /** Legacy capture fields retained only for reading already-stored events. */
  version?: number;
  instruction?: string;
  report?: string;
}

export interface AssignedCardContextSnapshotEvent {
  type: 'debug';
  kind: 'assigned_card_context_snapshot';
  content: string;
  timestamp: number;
  capture: {
    source: 'prepared_model_input';
    sessionId: string;
    registrationId: string | null;
    executionCommandId: string | null;
    inputId: string | null;
    identityMissing: boolean;
    snapshot: {
      total: number;
      omitted: number;
      capturedAt: string;
      cards: AssignedCardContextSnapshotCard[];
    };
  };
}

export function isAssignedCardContextSnapshotEvent(
  value: unknown,
): value is AssignedCardContextSnapshotEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<AssignedCardContextSnapshotEvent>;
  const capture = event.capture;
  if (!capture || typeof capture !== 'object') return false;
  const snapshot = capture.snapshot;
  return event.type === 'debug'
    && event.kind === 'assigned_card_context_snapshot'
    && typeof event.content === 'string'
    && event.content.trim().length > 0
    && typeof event.timestamp === 'number'
    && capture.source === 'prepared_model_input'
    && typeof capture.sessionId === 'string'
    && typeof capture.identityMissing === 'boolean'
    && !!snapshot
    && typeof snapshot === 'object'
    && Number.isSafeInteger(snapshot.total)
    && Number.isSafeInteger(snapshot.omitted)
    && typeof snapshot.capturedAt === 'string'
    && Array.isArray(snapshot.cards);
}
