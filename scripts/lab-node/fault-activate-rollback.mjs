export const ACTIVATE_ROLLBACK_MUTATIONS = Object.freeze([
  "raise_removed",
  "predicate_misplaced",
  "cleanup_removed",
]);

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
  if (observation.semanticReachCount !== 1) {
    violations.push(
      `sessions_row_acquire_transition_reach_count:${observation.semanticReachCount}`,
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
  if (observation.markerCount !== 0) {
    violations.push(`assistant_marker_emitted:${observation.markerCount}`);
  }
  return violations;
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
