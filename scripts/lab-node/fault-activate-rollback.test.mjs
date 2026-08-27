import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVATE_ROLLBACK_MUTATIONS,
  activateRollbackMutationDetection,
  activateRollbackViolations,
  observeActivationFailureOutcome,
  observeRaiseRemovedMutationViolation,
} from "./fault-activate-rollback.mjs";
import { runCanonicalScenario } from "./fault-scenarios.mjs";
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

test("activate rollback observes the retry horizon only after the dead-letter resolves", async () => {
  let resolveDeadLetter;
  const deadLetterPromise = new Promise((resolve) => {
    resolveDeadLetter = resolve;
  });
  const reach = { semanticReachCount: 2, stable: true };
  const followupInventory = { registrationCount: 1 };
  let horizonObservationCount = 0;

  const outcomePromise = observeActivationFailureOutcome({
    deadLetterPromise,
    observeRetryHorizon: async () => {
      horizonObservationCount += 1;
      return reach;
    },
    followupInventoryPromise: Promise.resolve(followupInventory),
  });
  await Promise.resolve();

  assert.equal(horizonObservationCount, 0);
  const deadLetterOutcome = { status: "fulfilled", value: { sourceSeq: 8 } };
  resolveDeadLetter(deadLetterOutcome);
  assert.deepEqual(await outcomePromise, {
    reach,
    followupInventory,
    deadLetterOutcome,
  });
  assert.equal(horizonObservationCount, 1);
});

test("raise-removed mutation completes from an owner commit without waiting for a marker", async (t) => {
  const previousMutation = process.env.LAB_ACTIVATE_ROLLBACK_MUTATION;
  process.env.LAB_ACTIVATE_ROLLBACK_MUTATION = "raise_removed";
  t.after(() => {
    if (previousMutation === undefined) {
      delete process.env.LAB_ACTIVATE_ROLLBACK_MUTATION;
    } else {
      process.env.LAB_ACTIVATE_ROLLBACK_MUTATION = previousMutation;
    }
  });

  let ownershipReadCount = 0;
  let rejectedMarkerWaitCount = 0;
  const baselineOwner = {
    pid: 101,
    registrationId: "registration-baseline",
    executionCommandId: "command-baseline",
  };
  const ownerlessBaseline = {
    status: "completed",
    executionGeneration: 4,
    terminalRevision: 18,
    owner: null,
  };
  const committedMutation = {
    status: "completed",
    executionGeneration: 5,
    terminalRevision: 19,
    owner: null,
  };
  const runtime = {
    async nodeLogOffset() { return 0; },
    async createSession() { return "session-a"; },
    async waitForRunner() { return { pid: baselineOwner.pid }; },
    async waitForExecutionOwnershipTransitionSince(
      _sessionId,
      _offset,
      operation,
    ) {
      return { operation, ownershipGeneration: 4, time: operation === "acquire" ? 10 : 20 };
    },
    async sessionExecutionOwnership() {
      ownershipReadCount += 1;
      if (ownershipReadCount === 1) {
        return { ...ownerlessBaseline, status: "running", owner: baselineOwner };
      }
      if (ownershipReadCount === 2) return ownerlessBaseline;
      return committedMutation;
    },
    async executionCommandFingerprint(commandId) {
      return commandId === baselineOwner.executionCommandId ? "101" : "202";
    },
    async waitForMarker(_sessionId, marker) {
      if (marker.includes("BASELINE")) return { messages: [] };
      rejectedMarkerWaitCount += 1;
      throw new Error("owner commit should finish before the rejected marker wait");
    },
    async waitForTerminal() { return "completed"; },
    async waitForTerminalRunnerRetirementSince() {
      return {
        retirement: { time: 30 },
        registration: {
          present: false,
          identityPid: null,
          pidFilePid: null,
          registrationId: baselineOwner.registrationId,
        },
      };
    },
    async installActivationFailureFault() {},
    async intervene() { return { status: "accepted" }; },
    async waitForDistinctRunnerRegistration() {
      return {
        present: true,
        identityPid: 202,
        pidFilePid: 202,
        registrationId: "registration-followup",
      };
    },
    async waitForActivationFailureFault() {
      return {
        semanticReachCount: 1,
        attemptedGeneration: 5,
        attemptedCommandFingerprint: "202",
      };
    },
    async executionAcquireEnvelopeSourceSeq() { return 8; },
    async observeDistinctRunnerRegistrationInventoryUntil() {
      return {
        observations: [{ registrationId: "registration-followup", identityPid: 202 }],
        registrationCount: 1,
        pidCount: 1,
        identityCount: 1,
      };
    },
    async activationFailureFaultCountAfterHorizon(horizonMs) {
      return {
        semanticReachCount: 1,
        semanticReachCountBeforeHorizon: 1,
        attemptedGeneration: 5,
        attemptedCommandFingerprint: "202",
        retryHorizonMs: horizonMs,
        stable: true,
      };
    },
    async countTimelineEvents() { return 0; },
    runnerAlive() { return false; },
    async runnerExecutionRegistration() {
      return {
        present: false,
        identityPid: null,
        pidFilePid: null,
        registrationId: "registration-followup",
      };
    },
    async removeActivationFailureFault() {},
    async activationFailureFaultResidue() {
      return { triggerCount: 0, functionCount: 0, counterCount: 0 };
    },
  };
  const recorder = {
    async logOffsets() { return { node: 0, orch: 0 }; },
    async invariant() {
      return { violations: [], newViolations: [], settled: true };
    },
    async event() {},
    async captureLogs() { return { node: [], orch: [] }; },
    async scenario() {},
  };

  const result = await runCanonicalScenario("activate-rollback", runtime, recorder);

  assert.equal(result.status, "passed", JSON.stringify(result.failure));
  assert.deepEqual(result.mutationDetection, {
    detected: true,
    sentinel: "acquire_committed_without_fault_raise",
  });
  assert.equal(rejectedMarkerWaitCount, 0);
});

test("raise-removed mutation resolves on either observation and delegates the empty case", async () => {
  let markerObservationCount = 0;
  const ownerCommit = { executionGeneration: 5, owner: null };
  assert.deepEqual(await observeRaiseRemovedMutationViolation({
    waitForObservation: (observe) => observe(),
    observeOwnerCommit: async () => ownerCommit,
    observeMarker: async () => {
      markerObservationCount += 1;
      return 0;
    },
  }), { kind: "owner_commit", ownerCommit });
  assert.equal(markerObservationCount, 0);

  assert.deepEqual(await observeRaiseRemovedMutationViolation({
    waitForObservation: (observe) => observe(),
    observeOwnerCommit: async () => undefined,
    observeMarker: async () => 1,
  }), { kind: "marker", markerCount: 1 });

  let emptyObservationDelegated = false;
  await assert.rejects(observeRaiseRemovedMutationViolation({
    waitForObservation: async (observe) => {
      emptyObservationDelegated = true;
      assert.equal(await observe(), undefined);
      throw new Error("existing wait timeout");
    },
    observeOwnerCommit: async () => undefined,
    observeMarker: async () => 0,
  }), /existing wait timeout/);
  assert.equal(emptyObservationDelegated, true);
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
