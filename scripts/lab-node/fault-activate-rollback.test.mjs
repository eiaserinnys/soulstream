import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVATE_ROLLBACK_MUTATIONS,
  activateRollbackMutationDetection,
  activateRollbackViolations,
} from "./fault-activate-rollback.mjs";

const CLEAN_OBSERVATION = Object.freeze({
  semanticReachCount: 1,
  acquireApplied: false,
  generationBefore: 4,
  generationAfter: 4,
  ownerBefore: null,
  ownerAfter: null,
  terminalRevisionBefore: 18,
  terminalRevisionAfter: 18,
  childAlive: false,
  markerCount: 0,
});

test("activate rollback accepts only an observed rolled-back sessions-row acquire", () => {
  assert.deepEqual(activateRollbackViolations(CLEAN_OBSERVATION), []);
  for (const mutation of [
    { semanticReachCount: 0 },
    { acquireApplied: true },
    { generationAfter: 5 },
    { ownerAfter: { manifestId: "manifest" } },
    { terminalRevisionAfter: 19 },
    { childAlive: true },
    { markerCount: 1 },
  ]) {
    assert.notDeepEqual(
      activateRollbackViolations({ ...CLEAN_OBSERVATION, ...mutation }),
      [],
    );
  }
});

test("activate rollback mutation inventory has one distinct sentinel per removed edge", () => {
  assert.deepEqual(ACTIVATE_ROLLBACK_MUTATIONS, [
    "raise_removed",
    "predicate_misplaced",
    "cleanup_removed",
  ]);
  const observations = {
    raise_removed: { ...CLEAN_OBSERVATION, acquireApplied: true, generationAfter: 5 },
    predicate_misplaced: { ...CLEAN_OBSERVATION, semanticReachCount: 0 },
    cleanup_removed: { ...CLEAN_OBSERVATION, childAlive: true },
  };
  assert.deepEqual(
    ACTIVATE_ROLLBACK_MUTATIONS.map((mutation) => (
      activateRollbackMutationDetection(mutation, observations[mutation])
    )),
    [
      { detected: true, sentinel: "acquire_committed_without_fault_raise" },
      { detected: true, sentinel: "sessions_row_acquire_transition_not_reached" },
      { detected: true, sentinel: "acquire_failure_left_runner_child_live" },
    ],
  );
  for (const mutation of ACTIVATE_ROLLBACK_MUTATIONS) {
    assert.equal(
      activateRollbackMutationDetection(mutation, CLEAN_OBSERVATION).detected,
      false,
      `${mutation} was satisfied by the fixed product`,
    );
  }
});
