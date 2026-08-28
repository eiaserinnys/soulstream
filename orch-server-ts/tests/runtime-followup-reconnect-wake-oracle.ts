import {
  ACTIVE_TURN_DELIVERY_IDS,
  ALL_RUNTIME_FOLLOWUP_DELIVERY_IDS,
  RECONNECT_PENDING_DELIVERY_IDS,
} from "./runtime-followup-reconnect-wake-fixture.js";

export const RUNTIME_FOLLOWUP_WAKE_MUTATIONS = [
  "reconnect_claim_excludes_runtime_followup",
  "terminal_consumes_current_turn_only",
  "post_close_discard_send_error",
] as const;

export const RUNTIME_FOLLOWUP_ORACLE_GAP_MUTATIONS = [
  "second_reconnect_omitted",
  "lifecycle_counts_constantized",
  "socket_race_disabled",
] as const;

export type RuntimeFollowupWakeMutation =
  (typeof RUNTIME_FOLLOWUP_WAKE_MUTATIONS)[number];
export type RuntimeFollowupOracleGapMutation =
  (typeof RUNTIME_FOLLOWUP_ORACLE_GAP_MUTATIONS)[number];

export interface DeliveryPhaseCounts {
  claim: number;
  dispatch: number;
  receipt: number;
  consume: number;
  stale: number;
}

export interface ReconnectAttemptObservation {
  phase: "pre_terminal" | "post_terminal_release";
  connectionId: string;
  pendingBefore: string[];
  claimOrder: string[];
  dispatchOrder: string[];
}

export type LifecycleEvidenceKind =
  | "generation"
  | "foreground_turn"
  | "assistant_turn";

export interface LifecycleEvidence {
  kind: LifecycleEvidenceKind;
  id: string;
}

export interface LifecycleObservation {
  eventSinkEvidence: LifecycleEvidence[];
  generationIds: string[];
  foregroundTurnIds: string[];
  assistantTurnIds: string[];
}

export interface RuntimeFollowupWakeObservation {
  counts: Record<string, DeliveryPhaseCounts>;
  pendingIds: string[];
  trace: string[];
  reconnectAttempts: ReconnectAttemptObservation[];
  lifecycle: LifecycleObservation;
  preTerminalLifecycle: LifecycleObservation;
  parentStatus: string;
  followupQueueErrors: number;
  discardInterventionErrors: number;
  runnerSocketSendErrors: number;
}

export function runtimeFollowupWakeViolations(
  observation: RuntimeFollowupWakeObservation,
): string[] {
  const violations: string[] = [];
  const reconnectMissed = observation.reconnectAttempts.some((attempt) => {
    const expected = attempt.pendingBefore.filter((deliveryId) =>
      RECONNECT_PENDING_DELIVERY_IDS.some((candidate) => candidate === deliveryId));
    return !sameOrder(attempt.claimOrder, expected)
      || !sameOrder(attempt.dispatchOrder, expected);
  });
  const reconnectCounts = RECONNECT_PENDING_DELIVERY_IDS.map(
    (deliveryId) => observation.counts[deliveryId],
  );
  if (reconnectMissed || reconnectCounts.some((counts) =>
    counts === undefined
    || counts.claim !== 1
    || counts.dispatch !== 1
    || counts.receipt !== 1
    || counts.stale !== 0
  )) {
    violations.push("reconnect_claim_excludes_runtime_followup");
  }
  const activeConsumedExactlyOnce = ACTIVE_TURN_DELIVERY_IDS.every(
    (deliveryId) => observation.counts[deliveryId]?.consume === 1,
  );
  const reconnectConsumedExactlyOnce = RECONNECT_PENDING_DELIVERY_IDS.every(
    (deliveryId) => observation.counts[deliveryId]?.consume === 1,
  );
  if (activeConsumedExactlyOnce && !reconnectConsumedExactlyOnce) {
    violations.push("terminal_consumes_current_turn_only");
  }
  if (
    observation.followupQueueErrors !== 0
    || observation.discardInterventionErrors !== 0
    || observation.runnerSocketSendErrors !== 0
  ) {
    violations.push("post_close_discard_send_error");
  }
  return violations;
}

export function runtimeFollowupMatrixViolations(
  observation: RuntimeFollowupWakeObservation,
): string[] {
  const violations = [
    ...runtimeFollowupWakeViolations(observation),
    ...runtimeFollowupOracleGapViolations(observation),
  ];
  if (observation.parentStatus !== "completed") {
    violations.push("parent_terminal_state_lost");
  }
  if (
    !exactSingle(observation.lifecycle.generationIds)
    || !exactSingle(observation.lifecycle.foregroundTurnIds)
    || !exactSingle(observation.lifecycle.assistantTurnIds)
  ) {
    violations.push("terminal_reconnect_duplicate_turn");
  }
  if (ALL_RUNTIME_FOLLOWUP_DELIVERY_IDS.some(
    (deliveryId) => observation.counts[deliveryId]?.consume !== 1,
  ) && !violations.includes("terminal_consumes_current_turn_only")) {
    violations.push("runtime_followup_consume_not_exactly_once");
  }
  return violations;
}

export function runtimeFollowupOracleGapViolations(
  observation: RuntimeFollowupWakeObservation,
): string[] {
  const violations: string[] = [];
  if (!sameOrder(
    observation.reconnectAttempts.map((attempt) => attempt.phase),
    ["pre_terminal", "post_terminal_release"],
  )) {
    violations.push("second_reconnect_omitted");
  }
  const derived = deriveLifecycle(observation.lifecycle.eventSinkEvidence);
  if (
    !sameOrder(derived.generationIds, observation.lifecycle.generationIds)
    || !sameOrder(derived.foregroundTurnIds, observation.lifecycle.foregroundTurnIds)
    || !sameOrder(derived.assistantTurnIds, observation.lifecycle.assistantTurnIds)
  ) {
    violations.push("lifecycle_counts_constantized");
  }
  const releaseIndex = observation.trace.indexOf("terminal:barrier-released");
  const firstCacheSeedIndex = observation.trace.indexOf(
    "reconnect:pre_terminal:cache-seed",
  );
  const secondReconnectIndex = observation.trace.indexOf(
    "reconnect:post_terminal_release:registered",
  );
  const secondCacheSeedIndex = observation.trace.indexOf(
    "reconnect:post_terminal_release:cache-seed",
  );
  const socketCloseIndex = observation.trace.indexOf("runner:socket-closed");
  const discardIndex = observation.trace.indexOf("runner:discard-after-close");
  if (
    releaseIndex < 0
    || firstCacheSeedIndex < 0
    || firstCacheSeedIndex >= releaseIndex
    || secondReconnectIndex <= releaseIndex
    || secondCacheSeedIndex <= secondReconnectIndex
    || socketCloseIndex <= releaseIndex
    || discardIndex <= socketCloseIndex
  ) {
    violations.push("socket_race_disabled");
  }
  return violations;
}

export function applyRuntimeFollowupWakeMutation(
  input: RuntimeFollowupWakeObservation,
  mutation: RuntimeFollowupWakeMutation,
): RuntimeFollowupWakeObservation {
  const observation = structuredClone(input);
  if (mutation === "reconnect_claim_excludes_runtime_followup") {
    for (const deliveryId of RECONNECT_PENDING_DELIVERY_IDS) {
      observation.counts[deliveryId]!.claim = 0;
      observation.counts[deliveryId]!.dispatch = 0;
      observation.counts[deliveryId]!.receipt = 0;
    }
    observation.reconnectAttempts[0]!.claimOrder = [];
    observation.reconnectAttempts[0]!.dispatchOrder = [];
  } else if (mutation === "terminal_consumes_current_turn_only") {
    for (const deliveryId of RECONNECT_PENDING_DELIVERY_IDS) {
      observation.counts[deliveryId]!.consume = 0;
    }
  } else {
    observation.followupQueueErrors = 1;
    observation.discardInterventionErrors = 1;
    observation.runnerSocketSendErrors = 1;
  }
  return observation;
}

export function applyRuntimeFollowupOracleGapMutation(
  input: RuntimeFollowupWakeObservation,
  mutation: RuntimeFollowupOracleGapMutation,
): RuntimeFollowupWakeObservation {
  const observation = structuredClone(input);
  if (mutation === "second_reconnect_omitted") {
    observation.reconnectAttempts = observation.reconnectAttempts.filter(
      (attempt) => attempt.phase !== "post_terminal_release",
    );
  } else if (mutation === "lifecycle_counts_constantized") {
    observation.lifecycle.eventSinkEvidence.push(
      ...structuredClone(observation.lifecycle.eventSinkEvidence),
    );
  } else {
    observation.trace = observation.trace.filter(
      (entry) => entry !== "runner:socket-closed",
    );
  }
  return observation;
}

export function applyDuplicateLifecycleMutation(
  input: RuntimeFollowupWakeObservation,
): RuntimeFollowupWakeObservation {
  const observation = structuredClone(input);
  const duplicated = structuredClone(observation.lifecycle.eventSinkEvidence);
  observation.lifecycle.eventSinkEvidence.push(...duplicated);
  observation.lifecycle = deriveLifecycle(observation.lifecycle.eventSinkEvidence);
  return observation;
}

export function noTransportControlViolations(
  observation: RuntimeFollowupWakeObservation,
): string[] {
  const pending = new Set(observation.pendingIds);
  const safe = RECONNECT_PENDING_DELIVERY_IDS.every((deliveryId) => {
    const counts = observation.counts[deliveryId];
    return pending.has(deliveryId)
      && counts?.dispatch === 0
      && counts.receipt === 0
      && counts.consume === 0;
  });
  return safe ? [] : ["missing_transport_did_not_preserve_pending"];
}

export function activeGenerationControlViolations(
  observation: RuntimeFollowupWakeObservation,
): string[] {
  const lifecycle = observation.preTerminalLifecycle;
  return exactSingle(lifecycle.generationIds)
    && exactSingle(lifecycle.foregroundTurnIds)
    && lifecycle.assistantTurnIds.length === 0
    ? []
    : ["active_generation_advanced_before_terminal_barrier"];
}

export function duplicateLifecycleControlViolations(
  observation: RuntimeFollowupWakeObservation,
): string[] {
  return exactSingle(observation.lifecycle.generationIds)
    && exactSingle(observation.lifecycle.foregroundTurnIds)
    && exactSingle(observation.lifecycle.assistantTurnIds)
    ? []
    : ["terminal_reconnect_duplicate_turn"];
}

export function deriveLifecycle(
  evidence: LifecycleEvidence[],
): LifecycleObservation {
  return {
    eventSinkEvidence: structuredClone(evidence),
    generationIds: idsFor(evidence, "generation"),
    foregroundTurnIds: idsFor(evidence, "foreground_turn"),
    assistantTurnIds: idsFor(evidence, "assistant_turn"),
  };
}

function idsFor(
  evidence: LifecycleEvidence[],
  kind: LifecycleEvidenceKind,
): string[] {
  return evidence.filter((entry) => entry.kind === kind).map((entry) => entry.id);
}

function exactSingle(values: string[]): boolean {
  return values.length === 1 && new Set(values).size === 1;
}

function sameOrder<T>(actual: T[], expected: T[]): boolean {
  return actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}
