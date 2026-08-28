export interface StaleTerminalFanoutObservation {
  effectApplied: boolean;
  ackApplied: boolean | null;
  rawAuditAppendCount: number;
  rawTerminalRegistryEventCount: number;
  pushSendCount: number;
  semanticTerminalNotificationCount: number;
  runtimeTerminalDeliveryCount: number;
  callerEarlyCompletionCount: number;
  modelEarlyCompletionCount: number;
  canonicalStatus: string;
  canonicalGeneration: number;
  canonicalOwnerMatchesWinner: boolean;
  canonicalTerminationEventId: number | null;
  cacheStatus: string | null;
  nextInputObservedGeneration: number | null;
  nextInputDeliveryCount: number;
  nextTurnCount: number;
  nextModelTurnCount: number;
  nextInputAutoResumeCount: number;
  generationAfterInput: number;
  hiddenCompletionAfterInputCount: number;
}

export interface AppliedTerminalFanoutObservation {
  effectApplied: boolean;
  ackApplied: boolean | null;
  rawAuditAppendCount: number;
  rawTerminalRegistryEventCount: number;
  pushSendCount: number;
  semanticTerminalNotificationCount: number;
  runtimeTerminalDeliveryCount: number;
  callerCompletionCount: number;
  modelCompletionCount: number;
  canonicalStatus: string;
  cacheStatus: string | null;
  canonicalTerminationEventId: number | null;
}

export type StaleTerminalFanoutMutation =
  | "applied_gate_removed"
  | "raw_terminal_fanout_restored"
  | "raw_terminal_status_overwrites_canonical";

export const STALE_TERMINAL_MUTATION_EXPECTATIONS: Record<
  StaleTerminalFanoutMutation,
  string
> = {
  applied_gate_removed: "ROW2_STALE_TERMINAL_PUSH_SENT",
  raw_terminal_fanout_restored: "ROW2_STALE_TERMINAL_RUNTIME_FANOUT",
  raw_terminal_status_overwrites_canonical:
    "ROW2_RAW_TERMINAL_OVERWROTE_CANONICAL_RUNNING",
};

export function staleTerminalFanoutViolations(
  observation: StaleTerminalFanoutObservation,
): string[] {
  return compact([
    observation.effectApplied ? "ROW2_STALE_TERMINAL_EFFECT_APPLIED" : null,
    observation.ackApplied !== false ? "ROW2_STALE_TERMINAL_ACK_NOT_REJECTED" : null,
    observation.rawAuditAppendCount !== 1 ? "ROW2_RAW_AUDIT_APPEND_COUNT" : null,
    observation.rawTerminalRegistryEventCount !== 0
      ? "ROW2_STALE_RAW_TERMINAL_PUBLISHED"
      : null,
    observation.pushSendCount !== 0 ? "ROW2_STALE_TERMINAL_PUSH_SENT" : null,
    observation.semanticTerminalNotificationCount !== 0
      ? "ROW2_STALE_TERMINAL_NOTIFICATION_SENT"
      : null,
    observation.runtimeTerminalDeliveryCount !== 0
      ? "ROW2_STALE_TERMINAL_RUNTIME_FANOUT"
      : null,
    observation.callerEarlyCompletionCount !== 0
      ? "ROW2_CALLER_COMPLETED_FROM_REJECTED_TERMINAL"
      : null,
    observation.modelEarlyCompletionCount !== 0
      ? "ROW2_MODEL_COMPLETED_FROM_REJECTED_TERMINAL"
      : null,
    observation.canonicalStatus !== "running"
      || observation.canonicalGeneration !== 1
      || !observation.canonicalOwnerMatchesWinner
      || observation.canonicalTerminationEventId !== null
      ? "ROW2_ACQUIRE_WINNER_NOT_CANONICAL"
      : null,
    observation.cacheStatus !== "running"
      ? "ROW2_RAW_TERMINAL_OVERWROTE_CANONICAL_RUNNING"
      : null,
    observation.nextInputObservedGeneration !== 1
      ? "ROW2_NEXT_INPUT_DID_NOT_USE_CURRENT_GENERATION"
      : null,
    observation.nextInputDeliveryCount !== 1
      || observation.nextTurnCount !== 1
      || observation.nextModelTurnCount !== 1
      ? "ROW2_NEXT_INPUT_NOT_EXACTLY_ONE_TURN"
      : null,
    observation.nextInputAutoResumeCount !== 0
      || observation.generationAfterInput !== 1
      ? "ROW2_NEXT_INPUT_OPENED_NEW_GENERATION"
      : null,
    observation.hiddenCompletionAfterInputCount !== 0
      ? "ROW2_NEXT_INPUT_OBSERVED_HIDDEN_COMPLETION"
      : null,
  ]);
}

export function appliedTerminalFanoutViolations(
  observation: AppliedTerminalFanoutObservation,
): string[] {
  return compact([
    !observation.effectApplied ? "APPLIED_TERMINAL_EFFECT_REJECTED" : null,
    observation.ackApplied !== true ? "APPLIED_TERMINAL_ACK_NOT_APPLIED" : null,
    observation.rawAuditAppendCount !== 1 ? "APPLIED_TERMINAL_AUDIT_COUNT" : null,
    observation.rawTerminalRegistryEventCount !== 1
      ? "APPLIED_TERMINAL_RAW_EVENT_COUNT"
      : null,
    observation.pushSendCount !== 1 ? "APPLIED_TERMINAL_PUSH_COUNT" : null,
    observation.semanticTerminalNotificationCount !== 1
      ? "APPLIED_TERMINAL_NOTIFICATION_COUNT"
      : null,
    observation.runtimeTerminalDeliveryCount !== 1
      ? "APPLIED_TERMINAL_RUNTIME_DELIVERY_COUNT"
      : null,
    observation.callerCompletionCount !== 1
      ? "APPLIED_TERMINAL_CALLER_COMPLETION_COUNT"
      : null,
    observation.modelCompletionCount !== 1
      ? "APPLIED_TERMINAL_MODEL_COMPLETION_COUNT"
      : null,
    observation.canonicalStatus !== "error" || observation.cacheStatus !== "error"
      ? "APPLIED_TERMINAL_NOT_CANONICAL"
      : null,
    observation.canonicalTerminationEventId === null
      ? "APPLIED_TERMINAL_REVISION_MISSING"
      : null,
  ]);
}

export function idealStaleTerminalFanout(): StaleTerminalFanoutObservation {
  return {
    effectApplied: false,
    ackApplied: false,
    rawAuditAppendCount: 1,
    rawTerminalRegistryEventCount: 0,
    pushSendCount: 0,
    semanticTerminalNotificationCount: 0,
    runtimeTerminalDeliveryCount: 0,
    callerEarlyCompletionCount: 0,
    modelEarlyCompletionCount: 0,
    canonicalStatus: "running",
    canonicalGeneration: 1,
    canonicalOwnerMatchesWinner: true,
    canonicalTerminationEventId: null,
    cacheStatus: "running",
    nextInputObservedGeneration: 1,
    nextInputDeliveryCount: 1,
    nextTurnCount: 1,
    nextModelTurnCount: 1,
    nextInputAutoResumeCount: 0,
    generationAfterInput: 1,
    hiddenCompletionAfterInputCount: 0,
  };
}

export function applyStaleTerminalFanoutMutation(
  baseline: StaleTerminalFanoutObservation,
  mutation: StaleTerminalFanoutMutation,
): StaleTerminalFanoutObservation {
  const mutated = structuredClone(baseline);
  if (mutation === "applied_gate_removed") {
    mutated.pushSendCount = 1;
    mutated.semanticTerminalNotificationCount = 1;
  }
  if (mutation === "raw_terminal_fanout_restored") {
    mutated.rawTerminalRegistryEventCount = 1;
    mutated.runtimeTerminalDeliveryCount = 1;
    mutated.callerEarlyCompletionCount = 1;
    mutated.modelEarlyCompletionCount = 1;
  }
  if (mutation === "raw_terminal_status_overwrites_canonical") {
    mutated.cacheStatus = "error";
    mutated.nextInputObservedGeneration = null;
    mutated.nextInputAutoResumeCount = 1;
    mutated.generationAfterInput = 2;
  }
  return mutated;
}

function compact(values: Array<string | null>): string[] {
  return values.filter((value): value is string => value !== null);
}
