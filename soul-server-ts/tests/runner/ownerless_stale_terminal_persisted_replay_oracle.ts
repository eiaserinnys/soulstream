import {
  appliedTerminalFanoutViolations,
  idealStaleTerminalFanout,
  staleTerminalFanoutViolations,
  type AppliedTerminalFanoutObservation,
  type StaleTerminalFanoutObservation,
} from "./ownerless_stale_terminal_fanout_oracle.js";

export type PersistedStaleTerminalReplayObservation = {
  effectApplied: boolean;
  rawAuditAppendCount: number;
  receiptCount: number;
  ackCount: number;
  ackApplied: boolean | null;
  replayStatusCode: number;
  replaySessionEndedCount: number;
  replayCompletionCount: number;
  canonicalStatusAfterReconnect: string;
  canonicalGenerationAfterReconnect: number;
  canonicalOwnerMatchesWinnerAfterReconnect: boolean;
  canonicalTerminationEventIdAfterReconnect: number | null;
  nextInputObservedGeneration: number | null;
  nextInputDeliveryCount: number;
  nextTurnCount: number;
  nextModelTurnCount: number;
  nextInputAutoResumeCount: number;
  generationAfterInput: number;
};

export type PersistedAppliedTerminalReplayObservation = {
  effectApplied: boolean;
  rawAuditAppendCount: number;
  receiptCount: number;
  ackCount: number;
  ackApplied: boolean | null;
  replayStatusCode: number;
  replaySessionEndedCount: number;
  replayCompletionCount: number;
  canonicalStatus: string;
  canonicalTerminationEventId: number | null;
};

export type StaleTerminalPersistedReplayExtensionObservation = {
  persisted: PersistedStaleTerminalReplayObservation;
  live: StaleTerminalFanoutObservation;
};

export type AppliedTerminalPersistedReplayExtensionObservation = {
  persisted: PersistedAppliedTerminalReplayObservation;
  live: AppliedTerminalFanoutObservation;
};

export const PERSISTED_REPLAY_FILTER_REMOVED_VIOLATION =
  "ROW2_STALE_PERSISTED_SESSION_ENDED_REPLAYED";

export function staleTerminalPersistedReplayViolations(
  observation: StaleTerminalPersistedReplayExtensionObservation,
): string[] {
  const persisted = observation.persisted;
  return [
    ...staleTerminalFanoutViolations(observation.live),
    ...compact([
      persisted.effectApplied ? "ROW2_STALE_PERSISTED_EFFECT_APPLIED" : null,
      persisted.rawAuditAppendCount !== 1 ? "ROW2_PERSISTED_RAW_AUDIT_COUNT" : null,
      persisted.receiptCount !== 1 ? "ROW2_PERSISTED_RECEIPT_COUNT" : null,
      persisted.ackCount !== 1 ? "ROW2_PERSISTED_ACK_COUNT" : null,
      persisted.ackApplied !== false ? "ROW2_PERSISTED_ACK_NOT_REJECTED" : null,
      persisted.replayStatusCode !== 200 ? "ROW2_PERSISTED_REPLAY_HTTP_STATUS" : null,
      persisted.replaySessionEndedCount !== 0
        ? PERSISTED_REPLAY_FILTER_REMOVED_VIOLATION
        : null,
      persisted.replayCompletionCount !== 0
        ? "ROW2_STALE_PERSISTED_COMPLETION_REPLAYED"
        : null,
      persisted.canonicalStatusAfterReconnect !== "running"
      || persisted.canonicalGenerationAfterReconnect !== 1
      || !persisted.canonicalOwnerMatchesWinnerAfterReconnect
      || persisted.canonicalTerminationEventIdAfterReconnect !== null
        ? "ROW2_PERSISTED_RECONNECT_LOST_ACQUIRE_WINNER"
        : null,
      persisted.nextInputObservedGeneration !== 1
        ? "ROW2_PERSISTED_NEXT_INPUT_WRONG_GENERATION"
        : null,
      persisted.nextInputDeliveryCount !== 1
      || persisted.nextTurnCount !== 1
      || persisted.nextModelTurnCount !== 1
        ? "ROW2_PERSISTED_NEXT_INPUT_NOT_EXACTLY_ONE_TURN"
        : null,
      persisted.nextInputAutoResumeCount !== 0
      || persisted.generationAfterInput !== 1
        ? "ROW2_PERSISTED_NEXT_INPUT_OPENED_NEW_GENERATION"
        : null,
    ]),
  ];
}

export function appliedTerminalPersistedReplayViolations(
  observation: AppliedTerminalPersistedReplayExtensionObservation,
): string[] {
  const persisted = observation.persisted;
  return [
    ...appliedTerminalFanoutViolations(observation.live),
    ...compact([
      !persisted.effectApplied ? "APPLIED_PERSISTED_EFFECT_REJECTED" : null,
      persisted.rawAuditAppendCount !== 1 ? "APPLIED_PERSISTED_AUDIT_COUNT" : null,
      persisted.receiptCount !== 1 ? "APPLIED_PERSISTED_RECEIPT_COUNT" : null,
      persisted.ackCount !== 1 ? "APPLIED_PERSISTED_ACK_COUNT" : null,
      persisted.ackApplied !== true ? "APPLIED_PERSISTED_ACK_NOT_APPLIED" : null,
      persisted.replayStatusCode !== 200 ? "APPLIED_PERSISTED_REPLAY_HTTP_STATUS" : null,
      persisted.replaySessionEndedCount !== 1
        ? "APPLIED_PERSISTED_SESSION_ENDED_REPLAY_COUNT"
        : null,
      persisted.replayCompletionCount !== 1
        ? "APPLIED_PERSISTED_COMPLETION_REPLAY_COUNT"
        : null,
      persisted.canonicalStatus !== "error"
      || persisted.canonicalTerminationEventId === null
        ? "APPLIED_PERSISTED_TERMINAL_NOT_CANONICAL"
        : null,
    ]),
  ];
}

export function idealStaleTerminalPersistedReplayExtension():
StaleTerminalPersistedReplayExtensionObservation {
  return {
    live: idealStaleTerminalFanout(),
    persisted: {
      effectApplied: false,
      rawAuditAppendCount: 1,
      receiptCount: 1,
      ackCount: 1,
      ackApplied: false,
      replayStatusCode: 200,
      replaySessionEndedCount: 0,
      replayCompletionCount: 0,
      canonicalStatusAfterReconnect: "running",
      canonicalGenerationAfterReconnect: 1,
      canonicalOwnerMatchesWinnerAfterReconnect: true,
      canonicalTerminationEventIdAfterReconnect: null,
      nextInputObservedGeneration: 1,
      nextInputDeliveryCount: 1,
      nextTurnCount: 1,
      nextModelTurnCount: 1,
      nextInputAutoResumeCount: 0,
      generationAfterInput: 1,
    },
  };
}

export function applyPersistedReplayFilterRemovedMutation(
  baseline: StaleTerminalPersistedReplayExtensionObservation,
): StaleTerminalPersistedReplayExtensionObservation {
  const mutated = structuredClone(baseline);
  mutated.persisted.replaySessionEndedCount = 1;
  mutated.persisted.replayCompletionCount = 1;
  return mutated;
}

function compact(values: Array<string | null>): string[] {
  return values.filter((value): value is string => value !== null);
}
