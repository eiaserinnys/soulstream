import assert from "node:assert/strict";
import test from "node:test";

import { runCanonicalScenario } from "./fault-scenarios.mjs";

const SESSION_ID = "session-lifecycle-red";
const BASELINE_REGISTRATION_ID = "registration-baseline";
const FOLLOWUP_REGISTRATION_ID = "registration-followup";
const BASELINE_PID = 101;
const FOLLOWUP_PID = 202;
const BASELINE_GENERATION = 4;

function predicateLifecycleHarness({
  appliedAcquire = true,
  counter = 0,
  cleanupFailure = false,
  followupTransition = {},
  followupOwner = {},
} = {}) {
  const trace = [];
  const events = [];
  let logOffset = 0;
  let ownershipReadCount = 0;
  let followupAcquireObserved = false;
  let followupOwnerRead = false;
  let baselineTerminalObserved = false;
  let runnerAlive = true;
  let registrationPresent = true;

  const baselineOwner = {
    pid: BASELINE_PID,
    registrationId: BASELINE_REGISTRATION_ID,
    executionCommandId: "command-baseline",
  };
  const ownerlessBaseline = {
    status: "completed",
    executionGeneration: BASELINE_GENERATION,
    terminalRevision: 18,
    owner: null,
  };
  const finalOwnership = {
    status: "completed",
    executionGeneration: appliedAcquire
      ? BASELINE_GENERATION + 1
      : BASELINE_GENERATION,
    terminalRevision: appliedAcquire ? 19 : 18,
    owner: null,
  };
  const followupActiveOwnership = {
    status: "running",
    executionGeneration: followupOwner.executionGeneration ?? BASELINE_GENERATION + 1,
    terminalRevision: 18,
    owner: {
      pid: followupOwner.pid ?? FOLLOWUP_PID,
      registrationId: followupOwner.registrationId ?? FOLLOWUP_REGISTRATION_ID,
      executionCommandId: "command-followup",
    },
  };
  const followupRegistration = {
    present: true,
    identityPid: FOLLOWUP_PID,
    pidFilePid: FOLLOWUP_PID,
    registrationId: FOLLOWUP_REGISTRATION_ID,
  };

  const runtime = {
    async nodeLogOffset() {
      logOffset += 10;
      return logOffset;
    },
    async createSession() { return SESSION_ID; },
    async waitForRunner() { return { pid: BASELINE_PID }; },
    async waitForExecutionOwnershipTransitionSince(sessionId, offset, operation) {
      if (offset < 30) {
        return {
          sessionId,
          operation,
          ownershipGeneration: BASELINE_GENERATION,
          time: operation === "acquire" ? 10 : 20,
          applied: true,
        };
      }
      trace.push(`followup-${operation}`);
      if (!appliedAcquire && operation === "acquire") {
        throw new Error("no applied follow-up acquire transition");
      }
      if (operation === "acquire") {
        followupAcquireObserved = true;
        trace.push("followup-acquire:applied");
      }
      return {
        sessionId: followupTransition.sessionId ?? sessionId,
        operation,
        ownershipGeneration: followupTransition.ownershipGeneration
          ?? BASELINE_GENERATION + 1,
        time: operation === "acquire" ? 30 : 40,
        applied: true,
      };
    },
    async waitForRunnerOperationStateSince(_sessionId, _offset, expectedActive) {
      trace.push(`followup-operation-${expectedActive ? "active" : "inactive"}`);
      return { activeRunnerOperations: expectedActive ? [{ sessionId: SESSION_ID }] : [] };
    },
    async sessionExecutionOwnership(sessionId) {
      assert.equal(sessionId, SESSION_ID);
      ownershipReadCount += 1;
      if (ownershipReadCount === 1) {
        return { ...ownerlessBaseline, status: "running", owner: baselineOwner };
      }
      if (ownershipReadCount === 2) return ownerlessBaseline;
      if (followupAcquireObserved && !followupOwnerRead) {
        followupOwnerRead = true;
        trace.push("followup-owner-point-read");
        return followupActiveOwnership;
      }
      if (!appliedAcquire) trace.push("followup-ownerless-final-point-read");
      return finalOwnership;
    },
    async executionCommandFingerprint() { return "101"; },
    async waitForMarker(_sessionId, marker) {
      if (marker.includes("BASELINE")) return { messages: [] };
      trace.push("followup-marker-wait");
      return { messages: [] };
    },
    async waitForTerminal(sessionId) {
      assert.equal(sessionId, SESSION_ID);
      if (!baselineTerminalObserved) {
        baselineTerminalObserved = true;
        trace.push("baseline-terminal");
      } else {
        trace.push("followup-terminal");
      }
      return "completed";
    },
    async waitForTerminalRunnerRetirementSince(
      _sessionId,
      _offset,
      registrationId,
      expectedPid,
    ) {
      if (registrationId === BASELINE_REGISTRATION_ID) {
        return {
          retirement: { time: 25 },
          registration: {
            present: false,
            identityPid: null,
            pidFilePid: null,
            registrationId,
          },
        };
      }
      assert.equal(registrationId, FOLLOWUP_REGISTRATION_ID);
      assert.equal(expectedPid, FOLLOWUP_PID);
      trace.push("followup-retirement");
      runnerAlive = false;
      registrationPresent = false;
      return {
        retirement: { time: 45 },
        registration: {
          present: false,
          identityPid: null,
          pidFilePid: null,
          registrationId,
        },
      };
    },
    async installActivationFailureFault() {},
    async intervene() { return { status: "accepted" }; },
    async waitForDistinctRunnerRegistration() { return followupRegistration; },
    async waitForActivationFailureFault() {
      return {
        semanticReachCount: counter,
        attemptedGeneration: counter > 0 ? BASELINE_GENERATION + 1 : null,
        attemptedCommandFingerprint: counter > 0 ? "202" : null,
      };
    },
    async activationFailureFaultCount() {
      trace.push("counter-confirmed");
      return {
        semanticReachCount: counter,
        attemptedGeneration: counter > 0 ? BASELINE_GENERATION + 1 : null,
        attemptedCommandFingerprint: counter > 0 ? "202" : null,
      };
    },
    async activationFailureFaultCountAfterHorizon(horizonMs) {
      return {
        semanticReachCount: counter,
        semanticReachCountBeforeHorizon: counter,
        attemptedGeneration: counter > 0 ? BASELINE_GENERATION + 1 : null,
        attemptedCommandFingerprint: counter > 0 ? "202" : null,
        retryHorizonMs: horizonMs,
        stable: true,
      };
    },
    async executionAcquireEnvelopeSourceSeq(sessionId, registrationId, pid) {
      trace.push(`envelope:${sessionId}:${registrationId}:${pid}`);
      assert.equal(sessionId, SESSION_ID);
      assert.equal(registrationId, FOLLOWUP_REGISTRATION_ID);
      assert.equal(pid, FOLLOWUP_PID);
      return 8;
    },
    async observeDistinctRunnerRegistrationInventoryUntil() {
      return {
        observations: [{
          registrationId: FOLLOWUP_REGISTRATION_ID,
          identityPid: FOLLOWUP_PID,
        }],
        registrationCount: 1,
        pidCount: 1,
        identityCount: 1,
      };
    },
    async countTimelineEvents() { return 0; },
    runnerAlive() { return runnerAlive; },
    async runnerExecutionRegistration() {
      return registrationPresent
        ? followupRegistration
        : {
            present: false,
            identityPid: null,
            pidFilePid: null,
            registrationId: FOLLOWUP_REGISTRATION_ID,
          };
    },
    async terminateObservedLabRunnerRegistration() {
      trace.push("cleanup-terminate-runner");
      runnerAlive = false;
      registrationPresent = false;
      return {
        present: false,
        identityPid: null,
        pidFilePid: null,
        registrationId: FOLLOWUP_REGISTRATION_ID,
      };
    },
    async removeLabRunnerRegistration() {
      trace.push("cleanup-remove-registration");
      registrationPresent = false;
    },
    async removeActivationFailureFault() {
      if (cleanupFailure) throw new Error("injected cleanup failure");
    },
    async activationFailureFaultResidue() {
      return { triggerCount: 0, functionCount: 0, counterCount: 0 };
    },
  };
  const recorder = {
    async logOffsets() { return { node: 0, orch: 0 }; },
    async invariant() { return { violations: [], newViolations: [], settled: true }; },
    async event(action, details) {
      trace.push(action);
      events.push({ action, details, trace: [...trace] });
    },
    async captureLogs() { return { node: [], orch: [] }; },
    async scenario() {},
  };
  return { runtime, recorder, trace, events };
}

async function runPredicateScenario(t, options) {
  const previousMutation = process.env.LAB_ACTIVATE_ROLLBACK_MUTATION;
  process.env.LAB_ACTIVATE_ROLLBACK_MUTATION = "predicate_misplaced";
  t.after(() => {
    if (previousMutation === undefined) {
      delete process.env.LAB_ACTIVATE_ROLLBACK_MUTATION;
    } else {
      process.env.LAB_ACTIVATE_ROLLBACK_MUTATION = previousMutation;
    }
  });
  const harness = predicateLifecycleHarness(options);
  const result = await runCanonicalScenario(
    "activate-rollback",
    harness.runtime,
    harness.recorder,
  );
  harness.trace.push("scenario-finalized");
  return { ...harness, result };
}

test("applied follow-up acquire is bound before a zero counter is classified", async (t) => {
  const { trace } = await runPredicateScenario(t, { appliedAcquire: true });
  assert.ok(trace.indexOf("followup-acquire") >= 0, JSON.stringify(trace));
  assert.ok(trace.indexOf("followup-acquire:applied") >= 0, JSON.stringify(trace));
  assert.ok(trace.indexOf("followup-owner-point-read") >= 0, JSON.stringify(trace));
  const envelopeIndex = trace.indexOf(
    `envelope:${SESSION_ID}:${FOLLOWUP_REGISTRATION_ID}:${FOLLOWUP_PID}`,
  );
  assert.ok(
    trace.indexOf("followup-acquire")
      < trace.indexOf("followup-owner-point-read"),
    JSON.stringify(trace),
  );
  assert.ok(
    trace.indexOf("followup-owner-point-read") < envelopeIndex,
    JSON.stringify(trace),
  );
  assert.ok(
    envelopeIndex < trace.indexOf("counter-confirmed"),
    JSON.stringify(trace),
  );
});

test("zero after an applied acquire is classified as a missed predicate", async (t) => {
  const { result } = await runPredicateScenario(t, { appliedAcquire: true });
  assert.equal(result.status, "passed", JSON.stringify(result.failure));
  assert.deepEqual(result.verdict.mutationObservation, {
    sentinel: "fault_predicate_missed_applied_acquire",
    observationPoint: "after_exact_followup_acquire",
    acquireEvidence: {
      sessionId: SESSION_ID,
      ownershipGeneration: BASELINE_GENERATION + 1,
      registrationId: FOLLOWUP_REGISTRATION_ID,
      pid: FOLLOWUP_PID,
    },
    semanticReachCount: 0,
  });
});

test("mutation observation cannot finalize or clean up before exact release and retirement", async (t) => {
  const { events, result, trace } = await runPredicateScenario(t, { appliedAcquire: true });
  const observed = events.find((event) => event.details?.mutationObservation != null);
  const cleanupIndex = trace.indexOf("cleanup-terminate-runner");
  const lifecycle = trace.filter((entry) => [
    "followup-acquire",
    "counter-confirmed",
    "followup-release",
    "followup-terminal",
    "followup-retirement",
    "scenario-finalized",
  ].includes(entry));

  assert.equal(result.status, "passed", JSON.stringify(result.failure));
  assert.equal(observed?.action, "fault_reached", JSON.stringify(events));
  assert.deepEqual(lifecycle, [
    "followup-acquire",
    "counter-confirmed",
    "followup-release",
    "followup-terminal",
    "followup-retirement",
    "scenario-finalized",
  ]);
  assert.ok(
    cleanupIndex === -1 || cleanupIndex > trace.indexOf("followup-retirement"),
    JSON.stringify(trace),
  );
});

test("only a terminal follow-up with no applied acquire emits the no-transition verdict once", async (t) => {
  const { events, result, trace } = await runPredicateScenario(t, { appliedAcquire: false });
  const sentinelEvents = events.filter(
    (event) => event.details?.mutationObservation?.sentinel
      === "sessions_row_acquire_transition_not_reached",
  );

  assert.equal(result.status, "passed", JSON.stringify(result.failure));
  assert.equal(trace.includes("followup-acquire"), false, JSON.stringify(trace));
  assert.equal(trace.includes("followup-owner-point-read"), false, JSON.stringify(trace));
  assert.ok(trace.includes("followup-operation-active"), JSON.stringify(trace));
  assert.ok(trace.includes("followup-operation-inactive"), JSON.stringify(trace));
  assert.ok(trace.includes("followup-retirement"), JSON.stringify(trace));
  for (const prerequisite of [
    "followup-operation-inactive",
    "followup-terminal",
    "followup-retirement",
    "followup-ownerless-final-point-read",
  ]) {
    assert.ok(
      sentinelEvents[0]?.trace.includes(prerequisite),
      `${prerequisite} missing before no-transition observation: ${JSON.stringify(sentinelEvents)}`,
    );
  }
  assert.ok(
    trace.indexOf("followup-terminal") < trace.indexOf("scenario-finalized"),
    JSON.stringify(trace),
  );
  assert.equal(sentinelEvents.length, 1, JSON.stringify(events));
  assert.equal(result.after.executionGeneration, BASELINE_GENERATION);
  assert.equal(result.after.owner, null);
  assert.equal(
    sentinelEvents[0].details.mutationObservation.observationPoint,
    "after_followup_terminal",
  );
  assert.deepEqual(result.verdict.mutationDetection, {
    detected: true,
    sentinel: "sessions_row_acquire_transition_not_reached",
  });
});

test("wrong follow-up session cannot pass the applied-acquire evidence gate", async (t) => {
  const { result } = await runPredicateScenario(t, {
    appliedAcquire: true,
    followupTransition: {
      sessionId: "wrong-session",
    },
  });

  assert.equal(result.status, "failed");
  assert.match(result.failure.message, /exact follow-up execution acquire/i);
  assert.equal(result.verdict?.mutationObservation ?? null, null);
});

test("the exact follow-up envelope is the identity control for acquire evidence", async (t) => {
  const { trace } = await runPredicateScenario(t, { appliedAcquire: true });
  assert.ok(
    trace.includes(
      `envelope:${SESSION_ID}:${FOLLOWUP_REGISTRATION_ID}:${FOLLOWUP_PID}`,
    ),
    JSON.stringify(trace),
  );
});

test("wrong follow-up generation cannot pass the applied-acquire evidence gate", async (t) => {
  const { result } = await runPredicateScenario(t, {
    appliedAcquire: true,
    followupTransition: {
      ownershipGeneration: BASELINE_GENERATION + 2,
    },
  });

  assert.equal(result.status, "failed");
  assert.match(result.failure.message, /exact follow-up execution acquire/i);
  assert.equal(result.verdict?.mutationObservation ?? null, null);
});

test("active-owner generation must match the applied transition generation", async (t) => {
  const { result } = await runPredicateScenario(t, {
    appliedAcquire: true,
    followupOwner: { executionGeneration: BASELINE_GENERATION + 2 },
  });
  assert.equal(result.status, "failed");
  assert.match(result.failure.message, /exact follow-up execution acquire/i);
  assert.equal(result.verdict?.mutationObservation ?? null, null);
});

test("wrong follow-up registration cannot pass the applied-acquire evidence gate", async (t) => {
  const { result } = await runPredicateScenario(t, {
    appliedAcquire: true,
    followupOwner: {
      registrationId: "wrong-registration",
    },
  });

  assert.equal(result.status, "failed");
  assert.match(result.failure.message, /exact follow-up execution acquire/i);
  assert.equal(result.verdict?.mutationObservation ?? null, null);
});

test("wrong follow-up PID cannot pass the applied-acquire evidence gate", async (t) => {
  const { result } = await runPredicateScenario(t, {
    appliedAcquire: true,
    followupOwner: {
      pid: FOLLOWUP_PID + 1,
    },
  });

  assert.equal(result.status, "failed");
  assert.match(result.failure.message, /exact follow-up execution acquire/i);
  assert.equal(result.verdict?.mutationObservation ?? null, null);
});

test("a nonzero semantic counter emits no predicate-missed sentinel", async (t) => {
  const { events, result } = await runPredicateScenario(t, {
    appliedAcquire: true,
    counter: 1,
  });

  assert.equal(result.status, "failed");
  assert.equal(
    events.filter((event) => event.details?.mutationObservation != null).length,
    0,
  );
});

test("cleanup failure is reported alongside an already observed mutation verdict", async (t) => {
  const { events, result } = await runPredicateScenario(t, {
    appliedAcquire: false,
    cleanupFailure: true,
  });
  const observed = events.find((event) => (
    event.details?.mutationObservation?.sentinel
      === "sessions_row_acquire_transition_not_reached"
  ));

  assert.ok(observed, `mutation observation was not recorded: ${JSON.stringify(events)}`);
  assert.equal(result.status, "failed");
  assert.ok(
    result.verdict,
    `recorded mutation observation was lost during cleanup: ${JSON.stringify(result)}`,
  );
  assert.deepEqual(result.verdict.mutationDetection, {
    detected: true,
    sentinel: "sessions_row_acquire_transition_not_reached",
  });
  assert.equal(
    result.verdict.mutationObservation.observationPoint,
    "after_followup_terminal",
  );
  assert.match(result.cleanupFailure.message, /injected cleanup failure/);
});
