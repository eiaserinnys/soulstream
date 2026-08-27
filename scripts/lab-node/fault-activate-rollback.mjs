export const ACTIVATE_ROLLBACK_MUTATIONS = Object.freeze([
  "raise_removed",
  "predicate_misplaced",
  "cleanup_removed",
]);

export const ACTIVATE_ROLLBACK_RETRY_BUDGET = 5;

export function requestedActivateRollbackMutation(env = process.env) {
  const mutation = env.LAB_ACTIVATE_ROLLBACK_MUTATION;
  if (mutation === undefined || mutation === "") return null;
  if (!ACTIVATE_ROLLBACK_MUTATIONS.includes(mutation)) {
    throw new Error(`unsupported activate-rollback mutation: ${mutation}`);
  }
  return mutation;
}

export function activateRollbackViolations(observation) {
  const violations = [];
  if (observation.baselineAdmissionDrained !== true) {
    violations.push("baseline_execution_admission_not_drained");
  }
  if (observation.followupAdmissionDistinct !== true) {
    violations.push("followup_execution_admission_not_distinct");
  }
  if (
    observation.followupRegistrationObservationCount !== 1
    || observation.followupPidObservationCount !== 1
    || observation.followupRegistrationIdentityObservationCount !== 1
  ) {
    violations.push(
      "followup_runner_readmission:"
      + `${observation.followupRegistrationObservationCount}/`
      + `${observation.followupPidObservationCount}/`
      + observation.followupRegistrationIdentityObservationCount,
    );
  }
  if (observation.followupRegistrationId === observation.baselineRegistrationId) {
    violations.push("followup_runner_registration_reused");
  }
  if (observation.attemptedCommandFingerprint === observation.baselineCommandFingerprint) {
    violations.push("followup_execution_command_reused");
  }
  if (observation.attemptedGeneration !== observation.generationBefore + 1) {
    violations.push(
      `attempted_execution_generation:${observation.attemptedGeneration}`,
    );
  }
  if (observation.acquireApplied) violations.push("acquire_applied");
  if (observation.generationAfter !== observation.generationBefore) {
    violations.push(
      `execution_generation_changed:${observation.generationBefore}->${observation.generationAfter}`,
    );
  }
  if (!sameValue(observation.ownerAfter, observation.ownerBefore)) {
    violations.push("execution_owner_changed");
  }
  if (observation.terminalRevisionAfter !== observation.terminalRevisionBefore) {
    violations.push(
      `terminal_revision_changed:${observation.terminalRevisionBefore}`
      + `->${observation.terminalRevisionAfter}`,
    );
  }
  if (observation.childAlive) violations.push("runner_child_live");
  if (observation.registrationPresent) violations.push("runner_registration_present");
  if (observation.markerCount !== 0) {
    violations.push(`assistant_marker_emitted:${observation.markerCount}`);
  }
  if (
    !Number.isSafeInteger(observation.semanticReachCount)
    || observation.semanticReachCount < 1
    || observation.semanticReachCount > ACTIVATE_ROLLBACK_RETRY_BUDGET
  ) {
    violations.push(
      `sessions_row_acquire_transition_reach_count:${observation.semanticReachCount}`,
    );
  }
  if (
    observation.retryHorizonStable !== true
    || observation.semanticReachCountBeforeHorizon !== observation.semanticReachCount
  ) {
    violations.push(
      "sessions_row_acquire_transition_retry_horizon_unstable:"
      + `${observation.semanticReachCountBeforeHorizon}->${observation.semanticReachCount}`,
    );
  }
  if (observation.deadLetterCode !== "REPEATED_FAILURE") {
    violations.push(`event_ingress_dead_letter:${observation.deadLetterCode ?? "missing"}`);
  } else if (observation.deadLetterSourceSeq !== observation.faultEnvelopeSourceSeq) {
    violations.push(
      `event_ingress_dead_letter_source_seq:${observation.faultEnvelopeSourceSeq}`
      + `->${observation.deadLetterSourceSeq}`,
    );
  }
  return violations;
}

export async function observeActivationFailureOutcome({
  deadLetterPromise,
  observeRetryHorizon,
  followupInventoryPromise,
}) {
  const deadLetterOutcome = await deadLetterPromise;
  const [reach, followupInventory] = await Promise.all([
    observeRetryHorizon(),
    followupInventoryPromise,
  ]);
  return { reach, followupInventory, deadLetterOutcome };
}

export function activateRollbackMutationDetection(mutation, observation) {
  if (!ACTIVATE_ROLLBACK_MUTATIONS.includes(mutation)) {
    throw new Error(`unsupported activate-rollback mutation: ${mutation}`);
  }
  if (mutation === "raise_removed") {
    return {
      detected: observation.acquireApplied === true || observation.markerCount > 0,
      sentinel: "acquire_committed_without_fault_raise",
    };
  }
  if (mutation === "predicate_misplaced") {
    return {
      detected: observation.semanticReachCount === 0,
      sentinel: "sessions_row_acquire_transition_not_reached",
    };
  }
  return {
    detected: observation.childAlive === true || observation.registrationPresent === true,
    sentinel: "acquire_failure_left_runner_child_live",
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
