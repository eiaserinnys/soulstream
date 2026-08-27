import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVATE_ROLLBACK_MUTATIONS,
  activateRollbackMutationDetection,
  activateRollbackViolations,
} from "./fault-activate-rollback.mjs";
import {
  distinctRunnerRegistrationInventory,
  eventIngressDeadLetters,
  executionAcquireEnvelopes,
} from "./fault-harness-runtime.mjs";

const CLEAN_OBSERVATION = Object.freeze({
  semanticReachCount: 1,
  semanticReachCountBeforeHorizon: 1,
  retryHorizonStable: true,
  retryBudget: 5,
  deadLetterCode: "REPEATED_FAILURE",
  faultEnvelopeSourceSeq: 8,
  deadLetterSourceSeq: 8,
  baselineAdmissionDrained: true,
  followupAdmissionDistinct: true,
  followupRegistrationObservationCount: 1,
  followupPidObservationCount: 1,
  followupRegistrationIdentityObservationCount: 1,
  baselineRegistrationId: "registration-baseline",
  followupRegistrationId: "registration-followup",
  baselineCommandFingerprint: "101",
  attemptedCommandFingerprint: "202",
  attemptedGeneration: 5,
  acquireApplied: false,
  generationBefore: 4,
  generationAfter: 4,
  ownerBefore: null,
  ownerAfter: null,
  terminalRevisionBefore: 18,
  terminalRevisionAfter: 18,
  childAlive: false,
  registrationPresent: false,
  markerCount: 0,
});

test("activate rollback accepts transactional retries that dead-letter without applying state", () => {
  assert.deepEqual(activateRollbackViolations({
    ...CLEAN_OBSERVATION,
    semanticReachCount: 2,
    semanticReachCountBeforeHorizon: 2,
    retryHorizonStable: true,
    retryBudget: 5,
    deadLetterCode: "REPEATED_FAILURE",
    followupRegistrationObservationCount: 1,
    followupPidObservationCount: 1,
    registrationPresent: false,
  }), []);
});

test("activate rollback retry allowance cannot hide core contract violations", () => {
  const retried = {
    ...CLEAN_OBSERVATION,
    semanticReachCount: 2,
    semanticReachCountBeforeHorizon: 2,
  };
  const cases = [
    ["dead-letter missing", { deadLetterCode: null }, "event_ingress_dead_letter:missing"],
    [
      "unrelated dead-letter",
      { deadLetterSourceSeq: 9 },
      "event_ingress_dead_letter_source_seq:8->9",
    ],
    ["state applied", { acquireApplied: true }, "acquire_applied"],
    [
      "runner readmitted",
      {
        followupRegistrationObservationCount: 1,
        followupPidObservationCount: 2,
        followupRegistrationIdentityObservationCount: 2,
      },
      "followup_runner_readmission:1/2/2",
    ],
    ["child survived", { childAlive: true }, "runner_child_live"],
    ["registration survived", { registrationPresent: true }, "runner_registration_present"],
    ["marker emitted", { markerCount: 1 }, "assistant_marker_emitted:1"],
  ];
  for (const [name, mutation, expected] of cases) {
    assert.deepEqual(
      activateRollbackViolations({ ...retried, ...mutation }),
      [expected],
      name,
    );
  }
  assert.deepEqual(activateRollbackViolations({
    ...retried,
    semanticReachCount: 6,
    semanticReachCountBeforeHorizon: 6,
    retryBudget: 999,
  }), ["sessions_row_acquire_transition_reach_count:6"]);
});

test("activate rollback reads the final event ingress dead-letter from structured node logs", () => {
  const record = {
    level: 50,
    time: 1787803471310,
    err: {
      type: "EventOutboxDeadLetterError",
      sourceSeq: 8,
      code: "REPEATED_FAILURE",
      rejectedAt: "2026-08-27T04:04:31.270Z",
    },
    sessionId: "session-a",
    msg: "Task execution threw outside event stream",
  };
  assert.deepEqual(eventIngressDeadLetters(`${JSON.stringify(record)}\n`), [{
    time: record.time,
    sessionId: record.sessionId,
    sourceSeq: record.err.sourceSeq,
    code: record.err.code,
    rejectedAt: record.err.rejectedAt,
  }]);
  assert.deepEqual(eventIngressDeadLetters(
    `${JSON.stringify({ ...record, err: { ...record.err, code: "OTHER" } })}\n`,
  ), []);
  const acquire = {
    stream_id: "stream-a",
    source_seq: 8,
    session_id: "session-a",
    session_effect: {
      kind: "execution_acquire",
      registration_id: "registration-a",
      pid: 123,
    },
  };
  assert.deepEqual(executionAcquireEnvelopes(`${JSON.stringify(acquire)}\n`), [{
    sourceSeq: 8,
    sessionId: "session-a",
    registrationId: "registration-a",
    pid: 123,
  }]);
  assert.deepEqual(activateRollbackViolations({
    ...CLEAN_OBSERVATION,
    deadLetterSourceSeq: 9,
  }), ["event_ingress_dead_letter_source_seq:8->9"]);
  const inventory = distinctRunnerRegistrationInventory([
    { registrationId: "registration-followup", identityPid: 123 },
    { registrationId: "registration-followup", identityPid: 456 },
    { registrationId: "registration-followup", identityPid: 456 },
  ], "registration-baseline");
  assert.deepEqual(inventory, {
    observations: [
      { registrationId: "registration-followup", identityPid: 123 },
      { registrationId: "registration-followup", identityPid: 456 },
    ],
    registrationCount: 1,
    pidCount: 2,
    identityCount: 2,
  });
  assert.deepEqual(activateRollbackViolations({
    ...CLEAN_OBSERVATION,
    followupRegistrationObservationCount: inventory.registrationCount,
    followupPidObservationCount: inventory.pidCount,
    followupRegistrationIdentityObservationCount: inventory.identityCount,
  }), ["followup_runner_readmission:1/2/2"]);
});

test("activate rollback accepts only an observed rolled-back sessions-row acquire", () => {
  assert.deepEqual(activateRollbackViolations(CLEAN_OBSERVATION), []);
  for (const mutation of [
    { semanticReachCount: 0 },
    { semanticReachCount: 6, semanticReachCountBeforeHorizon: 6 },
    { semanticReachCountBeforeHorizon: 1, semanticReachCount: 2 },
    { retryHorizonStable: false },
    { deadLetterCode: null },
    { baselineAdmissionDrained: false },
    { followupAdmissionDistinct: false },
    { followupRegistrationObservationCount: 2 },
    { followupPidObservationCount: 2 },
    { followupRegistrationIdentityObservationCount: 2 },
    { followupRegistrationId: "registration-baseline" },
    { attemptedCommandFingerprint: "101" },
    { attemptedGeneration: 4 },
    { acquireApplied: true },
    { generationAfter: 5 },
    { ownerAfter: { manifestId: "manifest" } },
    { terminalRevisionAfter: 19 },
    { childAlive: true },
    { registrationPresent: true },
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
