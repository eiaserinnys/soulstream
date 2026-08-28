import type { OwnerlessSessionSnapshot } from
  "./ownerless_running_reconciliation_fixture.js";

export interface AbsentConvergenceObservation {
  initialGenerationWasDatabaseDefaultZero: boolean;
  proofScanCount: number;
  firstScanTerminalWrites: number;
  first: OwnerlessSessionSnapshot;
  second: OwnerlessSessionSnapshot;
  third: OwnerlessSessionSnapshot;
  terminalApplications: number;
  manualDatabaseWrites: number;
  hydrationRejected: boolean;
}

export interface AcquireRaceObservation {
  barrierReached: boolean;
  acquireApplied: boolean;
  terminalCasApplied: boolean | null;
  terminalCasGenerationChecked: boolean;
  final: OwnerlessSessionSnapshot;
}

export interface CompatibleLiveObservation {
  first: OwnerlessSessionSnapshot;
  acquired: OwnerlessSessionSnapshot;
  restarted: OwnerlessSessionSnapshot;
  executionAcquireApplications: number;
  terminalApplications: number;
  recoverCalls: number;
  terminateCalls: number;
}

export interface ExplicitResumeObservation {
  acquireApplied: boolean;
  final: OwnerlessSessionSnapshot;
  executionAcquireApplications: number;
  terminalApplications: number;
}

export interface FailureRetryObservation {
  userStop: OwnerlessSessionSnapshot;
  repeatedUserStopTerminalEvents: number;
  runnerInterruptCalls: number;
  afterPersistenceFailure: OwnerlessSessionSnapshot;
  afterRetryScan: OwnerlessSessionSnapshot;
  terminalCommitAttempts: number;
  terminateCalls: number;
  retireCalls: number;
  duplicateFinalizers: number;
}

export interface ClassificationObservation {
  classifications: {
    absent: string;
    live: string;
    stalled: string;
    incompatible: string;
  };
  classificationOverlapCount: number;
  absentDatabaseStatus: string;
  absentVisibleAsRunningInCatalog: boolean;
  productionCaseIdGuardCount: number;
}

export interface OwnerlessMatrixObservation {
  row1: AbsentConvergenceObservation;
  row2: AcquireRaceObservation;
  row3: CompatibleLiveObservation;
  row4: ExplicitResumeObservation;
  row5: FailureRetryObservation;
  row6: ClassificationObservation;
}

export type OwnerlessMutation =
  | "two_scan_removed"
  | "scan1_terminal_write"
  | "generation_cas_removed"
  | "acquire_winner_overwritten"
  | "live_registration_misclassified"
  | "finalizer_duplicated";

export const OWNERLESS_MUTATION_EXPECTATIONS: Record<
  OwnerlessMutation,
  { row: keyof OwnerlessMatrixObservation; violation: string }
> = {
  two_scan_removed: { row: "row1", violation: "ROW1_TWO_SCAN_PROOF_MISSING" },
  scan1_terminal_write: { row: "row1", violation: "ROW1_SCAN1_TERMINAL_WRITE" },
  generation_cas_removed: { row: "row2", violation: "ROW2_GENERATION_CAS_MISSING" },
  acquire_winner_overwritten: { row: "row2", violation: "ROW2_ACQUIRE_WINNER_OVERWRITTEN" },
  live_registration_misclassified: {
    row: "row3",
    violation: "ROW3_LIVE_REGISTRATION_FALSE_TERMINAL",
  },
  finalizer_duplicated: { row: "row5", violation: "ROW5_DUPLICATE_FINALIZER" },
};

export function absentConvergenceViolations(
  observation: AbsentConvergenceObservation,
): string[] {
  return compact([
    !observation.initialGenerationWasDatabaseDefaultZero
      ? "ROW1_DATABASE_DEFAULT_GENERATION_NOT_ZERO"
      : null,
    observation.proofScanCount !== 2 ? "ROW1_TWO_SCAN_PROOF_MISSING" : null,
    observation.firstScanTerminalWrites !== 0 ? "ROW1_SCAN1_TERMINAL_WRITE" : null,
    observation.first.status !== "running" ? "ROW1_FIRST_SCAN_NOT_RUNNING" : null,
    observation.first.generation !== 0 ? "ROW1_FIRST_SCAN_CHANGED_GENERATION" : null,
    !isTerminal(observation.second.status) ? "ROW1_SECOND_SCAN_DID_NOT_CONVERGE" : null,
    observation.second.generation !== 0 ? "ROW1_TERMINAL_CHANGED_GENERATION" : null,
    hasOwner(observation.second) ? "ROW1_TERMINAL_RETAINED_OWNER" : null,
    observation.second.terminalEventCount !== 1
      ? "ROW1_TERMINAL_NOT_EXACTLY_ONCE"
      : null,
    observation.third.terminalEventCount !== observation.second.terminalEventCount
      ? "ROW1_THIRD_SCAN_DUPLICATED_TERMINAL"
      : null,
    observation.third.terminalEventCount !== 1
      ? "ROW1_TERMINAL_NOT_STABLE_AFTER_THIRD_SCAN"
      : null,
    observation.terminalApplications !== 1 ? "ROW1_TERMINAL_APPLICATION_COUNT" : null,
    observation.manualDatabaseWrites !== 0 ? "ROW1_MANUAL_DATABASE_WRITE" : null,
    observation.hydrationRejected ? "ROW1_GENERATION_ZERO_HYDRATION_REJECTED" : null,
  ]);
}

export function acquireRaceViolations(observation: AcquireRaceObservation): string[] {
  return compact([
    !observation.barrierReached ? "ROW2_BARRIER_NOT_REACHED" : null,
    !observation.acquireApplied ? "ROW2_LIVE_ACQUIRE_NOT_APPLIED" : null,
    !observation.terminalCasGenerationChecked ? "ROW2_GENERATION_CAS_MISSING" : null,
    observation.terminalCasApplied !== false ? "ROW2_TERMINAL_CAS_WAS_NOT_REJECTED" : null,
    observation.final.status !== "running" || observation.final.generation !== 1
      || !hasExpectedOwner(observation.final)
      ? "ROW2_ACQUIRE_WINNER_OVERWRITTEN"
      : null,
    observation.final.terminationEventId !== null
      ? "ROW2_REJECTED_TERMINAL_BECAME_CANONICAL"
      : null,
  ]);
}

export function compatibleLiveViolations(observation: CompatibleLiveObservation): string[] {
  return compact([
    observation.first.status !== "running" || observation.first.generation !== 0
      ? "ROW3_SCAN1_CHANGED_OWNERLESS_ROW"
      : null,
    observation.acquired.status !== "running" || observation.acquired.generation !== 1
      || !hasExpectedOwner(observation.acquired)
      ? "ROW3_LIVE_REGISTRATION_NOT_ACQUIRED"
      : null,
    observation.restarted.generation !== 1 || !hasExpectedOwner(observation.restarted)
      ? "ROW3_RESTART_DID_NOT_RETAIN_IDENTITY"
      : null,
    observation.executionAcquireApplications !== 1
      ? "ROW3_ACQUIRE_NOT_EXACTLY_ONCE"
      : null,
    observation.terminalApplications !== 0 || observation.terminateCalls !== 0
      ? "ROW3_LIVE_REGISTRATION_FALSE_TERMINAL"
      : null,
    observation.recoverCalls < 2 ? "ROW3_LIVE_ADOPT_NOT_RETAINED" : null,
  ]);
}

export function explicitResumeViolations(observation: ExplicitResumeObservation): string[] {
  return compact([
    !observation.acquireApplied ? "ROW4_EXPLICIT_RESUME_ACQUIRE_REJECTED" : null,
    observation.final.status !== "running" || observation.final.generation !== 1
      || !hasExpectedOwner(observation.final)
      ? "ROW4_EXPLICIT_RESUME_NOT_RUNNING"
      : null,
    observation.final.terminationEventId !== null
      ? "ROW4_EXPLICIT_RESUME_RETAINED_TERMINAL"
      : null,
    observation.executionAcquireApplications !== 1
      ? "ROW4_EXPLICIT_RESUME_ACQUIRE_COUNT"
      : null,
    observation.terminalApplications !== 0 ? "ROW4_FALSE_TERMINAL" : null,
  ]);
}

export function failureRetryViolations(observation: FailureRetryObservation): string[] {
  return compact([
    observation.userStop.status !== "interrupted"
      || observation.userStop.terminationReason !== "killed"
      || observation.userStop.terminationDetail !== "user_stop"
      ? "ROW5_USER_STOP_EVIDENCE_LOST"
      : null,
    hasOwner(observation.userStop) ? "ROW5_USER_STOP_OWNER_NOT_RELEASED" : null,
    observation.userStop.terminalEventCount !== 1
      || observation.repeatedUserStopTerminalEvents !== 1
      ? "ROW5_USER_STOP_NOT_EXACTLY_ONCE"
      : null,
    observation.runnerInterruptCalls !== 1 ? "ROW5_USER_STOP_INTERRUPT_COUNT" : null,
    observation.afterPersistenceFailure.status !== "running"
      || observation.afterPersistenceFailure.generation !== 0
      || hasOwner(observation.afterPersistenceFailure)
      || observation.afterPersistenceFailure.terminalEventCount !== 0
      ? "ROW5_FAILURE_EVIDENCE_NOT_PRESERVED"
      : null,
    !isTerminal(observation.afterRetryScan.status)
      || observation.afterRetryScan.terminalEventCount !== 1
      ? "ROW5_PERSISTENCE_FAILURE_NOT_RETRYABLE"
      : null,
    observation.terminalCommitAttempts !== 2 ? "ROW5_TERMINAL_RETRY_ATTEMPT_COUNT" : null,
    observation.terminateCalls !== 0 || observation.retireCalls !== 0
      ? "ROW5_FAILURE_DESTROYED_RUNNER_EVIDENCE"
      : null,
    observation.duplicateFinalizers !== 0 ? "ROW5_DUPLICATE_FINALIZER" : null,
  ]);
}

export function classificationViolations(observation: ClassificationObservation): string[] {
  const expected = {
    absent: "absent",
    live: "live",
    stalled: "stalled",
    incompatible: "incompatible",
  };
  return compact([
    JSON.stringify(observation.classifications) !== JSON.stringify(expected)
      ? "ROW6_CLASSIFICATION_NOT_MECE"
      : null,
    observation.classificationOverlapCount !== 0 ? "ROW6_CLASSIFICATION_OVERLAP" : null,
    !isTerminal(observation.absentDatabaseStatus)
      || observation.absentVisibleAsRunningInCatalog
      ? "ROW6_CATALOG_STATUS_MASKED_CANONICAL_ROW"
      : null,
    observation.productionCaseIdGuardCount !== 0 ? "ROW6_CASE_ID_GUARD_ADDED" : null,
  ]);
}

export function matrixViolations(
  observation: OwnerlessMatrixObservation,
): Record<keyof OwnerlessMatrixObservation, string[]> {
  return {
    row1: absentConvergenceViolations(observation.row1),
    row2: acquireRaceViolations(observation.row2),
    row3: compatibleLiveViolations(observation.row3),
    row4: explicitResumeViolations(observation.row4),
    row5: failureRetryViolations(observation.row5),
    row6: classificationViolations(observation.row6),
  };
}

export function idealOwnerlessMatrix(): OwnerlessMatrixObservation {
  const running0 = snapshot("running", 0, false, 0, false);
  const interrupted0 = snapshot("interrupted", 0, false, 1, false);
  const running1 = snapshot("running", 1, true, 0, true);
  const userStopped = {
    ...snapshot("interrupted", 1, false, 1, false),
    terminationReason: "killed",
    terminationDetail: "user_stop",
  };
  return {
    row1: {
      initialGenerationWasDatabaseDefaultZero: true,
      proofScanCount: 2,
      firstScanTerminalWrites: 0,
      first: running0,
      second: interrupted0,
      third: interrupted0,
      terminalApplications: 1,
      manualDatabaseWrites: 0,
      hydrationRejected: false,
    },
    row2: {
      barrierReached: true,
      acquireApplied: true,
      terminalCasApplied: false,
      terminalCasGenerationChecked: true,
      final: running1,
    },
    row3: {
      first: running0,
      acquired: running1,
      restarted: running1,
      executionAcquireApplications: 1,
      terminalApplications: 0,
      recoverCalls: 2,
      terminateCalls: 0,
    },
    row4: {
      acquireApplied: true,
      final: running1,
      executionAcquireApplications: 1,
      terminalApplications: 0,
    },
    row5: {
      userStop: userStopped,
      repeatedUserStopTerminalEvents: 1,
      runnerInterruptCalls: 1,
      afterPersistenceFailure: running0,
      afterRetryScan: interrupted0,
      terminalCommitAttempts: 2,
      terminateCalls: 0,
      retireCalls: 0,
      duplicateFinalizers: 0,
    },
    row6: {
      classifications: {
        absent: "absent",
        live: "live",
        stalled: "stalled",
        incompatible: "incompatible",
      },
      classificationOverlapCount: 0,
      absentDatabaseStatus: "interrupted",
      absentVisibleAsRunningInCatalog: false,
      productionCaseIdGuardCount: 0,
    },
  };
}

export function applyOwnerlessMutation(
  baseline: OwnerlessMatrixObservation,
  mutation: OwnerlessMutation,
): OwnerlessMatrixObservation {
  const mutated = structuredClone(baseline);
  if (mutation === "two_scan_removed") mutated.row1.proofScanCount = 1;
  if (mutation === "scan1_terminal_write") mutated.row1.firstScanTerminalWrites = 1;
  if (mutation === "generation_cas_removed") {
    mutated.row2.terminalCasGenerationChecked = false;
  }
  if (mutation === "acquire_winner_overwritten") {
    mutated.row2.terminalCasApplied = true;
    mutated.row2.final = snapshot("interrupted", 1, true, 1, false);
  }
  if (mutation === "live_registration_misclassified") {
    mutated.row3.terminalApplications = 1;
    mutated.row3.terminateCalls = 1;
  }
  if (mutation === "finalizer_duplicated") mutated.row5.duplicateFinalizers = 1;
  return mutated;
}

function snapshot(
  status: string,
  generation: number,
  owner: boolean,
  terminalEventCount: number,
  runningCatalogVisible: boolean,
): OwnerlessSessionSnapshot {
  return {
    status,
    terminationReason: status === "interrupted" ? "unknown" : null,
    terminationDetail: status === "interrupted" ? "ownerless proof absent" : null,
    terminationEventId: terminalEventCount > 0 ? 101 : null,
    generation,
    manifestId: owner ? "manifest-ownerless-red" : null,
    runtimeEnvIdentity: owner ? "runtime-ownerless-red" : null,
    registrationId: owner ? "registration-ownerless-red" : null,
    pid: owner ? 4312 : null,
    startIdentity: owner ? "start-ownerless-red" : null,
    executionCommandId: owner ? "execute-ownerless-red" : null,
    terminalEventCount,
    runningCatalogVisible,
  };
}

function hasExpectedOwner(snapshot: OwnerlessSessionSnapshot): boolean {
  return snapshot.manifestId === "manifest-ownerless-red"
    && snapshot.runtimeEnvIdentity === "runtime-ownerless-red"
    && snapshot.registrationId === "registration-ownerless-red"
    && snapshot.pid === 4312
    && snapshot.startIdentity === "start-ownerless-red"
    && snapshot.executionCommandId === "execute-ownerless-red";
}

function hasOwner(snapshot: OwnerlessSessionSnapshot): boolean {
  return snapshot.manifestId !== null
    || snapshot.runtimeEnvIdentity !== null
    || snapshot.registrationId !== null
    || snapshot.pid !== null
    || snapshot.startIdentity !== null
    || snapshot.executionCommandId !== null;
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "error" || status === "interrupted";
}

function compact(values: Array<string | null>): string[] {
  return values.filter((value): value is string => value !== null);
}
