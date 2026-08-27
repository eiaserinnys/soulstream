import assert from "node:assert/strict";
import test from "node:test";
import { runCanonicalScenario } from "./fault-scenarios.mjs";

const SESSION_ID = "session-lifecycle-red";
const BASELINE_REGISTRATION_ID = "registration-baseline";
const FOLLOWUP_REGISTRATION_ID = "registration-followup";
const BASELINE_PID = 101;
const FOLLOWUP_PID = 202;
const BASELINE_GENERATION = 4;
const FOLLOWUP_GENERATION = BASELINE_GENERATION + 1;
const FOLLOWUP_COMMAND_ID = "command-followup";

function durableEvidence(classification = "applied", patch = {}) {
  const applied = classification !== "no_transition";
  const base = {
    classification,
    logicalAcquireEventCount: 1,
    transportReceiptCount: 1,
    event: {
      eventId: 81,
      sessionId: SESSION_ID,
      phase: "execution_acquire",
      executionCommandId: FOLLOWUP_COMMAND_ID,
    },
    application: {
      applied,
      sessionId: SESSION_ID,
      ownershipGeneration: applied ? FOLLOWUP_GENERATION : null,
      registrationId: applied ? FOLLOWUP_REGISTRATION_ID : null,
      pid: applied ? FOLLOWUP_PID : null,
      executionCommandId: FOLLOWUP_COMMAND_ID,
    },
  };
  return {
    ...base,
    ...patch,
    event: patch.event === null ? null : { ...base.event, ...patch.event },
    application: patch.application === null
      ? null
      : { ...base.application, ...patch.application },
  };
}

function predicateLifecycleHarness({
  evidence = durableEvidence(),
  counter = 0,
  cleanupFailure = false,
  transition = {},
} = {}) {
  const trace = [];
  const events = [];
  const calls = {
    centralLookup: 0,
    followupMarker: 0,
    retryHorizon: 0,
    deadLetter: 0,
  };
  let logOffset = 0;
  let ownershipReadCount = 0;
  let baselineTerminalObserved = false;
  let runnerAlive = true;
  let registrationPresent = true;
  const appliedAcquire = evidence.classification === "applied";
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
      ? FOLLOWUP_GENERATION
      : BASELINE_GENERATION,
    terminalRevision: appliedAcquire ? 19 : 18,
    owner: null,
  };
  const followupRegistration = {
    present: true,
    identityPid: FOLLOWUP_PID,
    pidFilePid: FOLLOWUP_PID,
    registrationId: FOLLOWUP_REGISTRATION_ID,
  };

  const runtime = {
    async nodeLogOffset() { logOffset += 10; return logOffset; },
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
      if (!appliedAcquire) {
        throw new Error("positive ownership waiter used for a no-transition result");
      }
      return {
        sessionId: transition.sessionId ?? sessionId,
        operation,
        ownershipGeneration: transition.ownershipGeneration ?? FOLLOWUP_GENERATION,
        time: operation === "acquire" ? 30 : 40,
        applied: true,
      };
    },
    async waitForRunnerOperationStateSince(_sessionId, _offset, expectedActive) {
      trace.push(`legacy-operation-${expectedActive ? "active" : "inactive"}`);
      return { activeRunnerOperations: expectedActive ? [{ sessionId: SESSION_ID }] : [] };
    },
    async sessionExecutionOwnership(sessionId) {
      assert.equal(sessionId, SESSION_ID);
      ownershipReadCount += 1;
      if (ownershipReadCount === 1) {
        return { ...ownerlessBaseline, status: "running", owner: baselineOwner };
      }
      if (ownershipReadCount === 2) return ownerlessBaseline;
      trace.push("final-ownership-snapshot");
      return finalOwnership;
    },
    async executionAcquireApplicationEvidence(input) {
      calls.centralLookup += 1;
      trace.push("central-acquire-evidence-lookup");
      assert.deepEqual(input, {
        sessionId: SESSION_ID,
        expectedGeneration: FOLLOWUP_GENERATION,
        registrationId: FOLLOWUP_REGISTRATION_ID,
        pid: FOLLOWUP_PID,
        executionCommandId: FOLLOWUP_COMMAND_ID,
      });
      return evidence;
    },
    async executionCommandFingerprint() { return "101"; },
    async waitForMarker(_sessionId, marker) {
      if (marker.includes("BASELINE")) return { messages: [] };
      calls.followupMarker += 1;
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
          registration: { present: false, identityPid: null, pidFilePid: null, registrationId },
        };
      }
      assert.equal(registrationId, FOLLOWUP_REGISTRATION_ID);
      assert.equal(expectedPid, FOLLOWUP_PID);
      trace.push("followup-retirement");
      runnerAlive = false;
      registrationPresent = false;
      return {
        retirement: { time: 45 },
        registration: { present: false, identityPid: null, pidFilePid: null, registrationId },
      };
    },
    async installActivationFailureFault() {},
    async intervene() { return { status: "accepted" }; },
    async waitForDistinctRunnerRegistration() { return followupRegistration; },
    async waitForActivationFailureFault() {
      return {
        semanticReachCount: counter,
        attemptedGeneration: counter > 0 ? FOLLOWUP_GENERATION : null,
        attemptedCommandFingerprint: counter > 0 ? "202" : null,
      };
    },
    async activationFailureFaultCount() {
      trace.push("counter-confirmed");
      return {
        semanticReachCount: counter,
        attemptedGeneration: counter > 0 ? FOLLOWUP_GENERATION : null,
        attemptedCommandFingerprint: counter > 0 ? "202" : null,
      };
    },
    async activationFailureFaultCountAfterHorizon(horizonMs) {
      calls.retryHorizon += 1;
      return {
        semanticReachCount: counter,
        semanticReachCountBeforeHorizon: counter,
        attemptedGeneration: counter > 0 ? FOLLOWUP_GENERATION : null,
        attemptedCommandFingerprint: counter > 0 ? "202" : null,
        retryHorizonMs: horizonMs,
        stable: true,
      };
    },
    async waitForEventIngressDeadLetterSince() {
      calls.deadLetter += 1;
      return { code: "REPEATED_FAILURE", sourceSeq: 8 };
    },
    async executionAcquireEnvelopeSourceSeq() {
      trace.push("legacy-local-envelope-read");
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
      return registrationPresent ? followupRegistration : {
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
  return { runtime, recorder, trace, events, calls, evidence };
}

async function runPredicateScenario(t, options) {
  const previousMutation = process.env.LAB_ACTIVATE_ROLLBACK_MUTATION;
  process.env.LAB_ACTIVATE_ROLLBACK_MUTATION = "predicate_misplaced";
  t.after(() => {
    if (previousMutation === undefined) delete process.env.LAB_ACTIVATE_ROLLBACK_MUTATION;
    else process.env.LAB_ACTIVATE_ROLLBACK_MUTATION = previousMutation;
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

function observations(events) {
  return events.filter((event) => event.details?.mutationObservation != null);
}

test("durable applied evidence is consumed only after terminal retirement", async (t) => {
  const { calls, trace } = await runPredicateScenario(t);
  const lifecycle = trace.filter((entry) => [
    "followup-terminal",
    "followup-retirement",
    "central-acquire-evidence-lookup",
    "followup-acquire",
    "counter-confirmed",
    "followup-release",
    "scenario-finalized",
  ].includes(entry));
  assert.equal(calls.centralLookup, 1);
  assert.equal(trace.includes("legacy-local-envelope-read"), false, JSON.stringify(trace));
  assert.deepEqual(lifecycle, [
    "followup-terminal",
    "followup-retirement",
    "central-acquire-evidence-lookup",
    "followup-acquire",
    "counter-confirmed",
    "followup-release",
    "scenario-finalized",
  ]);
});

test("applied acquire plus a stable zero counter is a missed predicate", async (t) => {
  const { calls, result } = await runPredicateScenario(t);
  assert.deepEqual(calls, {
    centralLookup: 1,
    followupMarker: 0,
    retryHorizon: 0,
    deadLetter: 0,
  });
  assert.equal(result.status, "passed", JSON.stringify(result.failure));
  assert.deepEqual(result.verdict.mutationObservation, {
    sentinel: "fault_predicate_missed_applied_acquire",
    observationPoint: "after_durable_followup_lifecycle",
    acquireEvidence: {
      source: "central_event_receipt_join",
      eventId: 81,
      sessionId: SESSION_ID,
      ownershipGeneration: FOLLOWUP_GENERATION,
      registrationId: FOLLOWUP_REGISTRATION_ID,
      pid: FOLLOWUP_PID,
      executionCommandId: FOLLOWUP_COMMAND_ID,
    },
    semanticReachCount: 0,
  });
});

test("true no-transition is final ownerless generation stability, not operation snapshots", async (t) => {
  const { calls, events, result, trace } = await runPredicateScenario(t, {
    evidence: durableEvidence("no_transition"),
  });
  const sentinel = observations(events).filter((event) => (
    event.details.mutationObservation.sentinel
      === "sessions_row_acquire_transition_not_reached"
  ));
  assert.equal(result.status, "passed", JSON.stringify(result.failure));
  assert.equal(calls.centralLookup, 1);
  assert.equal(trace.some((entry) => entry.startsWith("legacy-operation-")), false);
  assert.equal(trace.includes("followup-acquire"), false);
  assert.equal(trace.includes("followup-release"), false);
  assert.equal(sentinel.length, 1, JSON.stringify(events));
  assert.equal(result.after.executionGeneration, BASELINE_GENERATION);
  assert.equal(result.after.owner, null);
  assert.equal(
    sentinel[0].details.mutationObservation.observationPoint,
    "after_durable_followup_lifecycle",
  );
});

const identityCases = [
  ["wrong session", { event: { sessionId: "wrong-session" } }],
  ["wrong registration", { application: { registrationId: "wrong-registration" } }],
  ["wrong PID", { application: { pid: FOLLOWUP_PID + 1 } }],
];
for (const [label, patch] of identityCases) {
  test(`${label} cannot pass the central acquire identity join`, async (t) => {
    const { events, result } = await runPredicateScenario(t, {
      evidence: durableEvidence("applied", patch),
    });
    assert.equal(result.status, "failed");
    assert.match(result.failure.message, /central acquire evidence identity/i);
    assert.equal(observations(events).length, 0);
  });
}

test("wrong applied transition generation cannot open the mutation observation", async (t) => {
  const { events, result } = await runPredicateScenario(t, {
    transition: { ownershipGeneration: FOLLOWUP_GENERATION + 1 },
  });
  assert.equal(result.status, "failed");
  assert.match(result.failure.message, /exact follow-up execution acquire/i);
  assert.equal(observations(events).length, 0);
});

test("canonical owner generation must match the applied transition", async (t) => {
  const { events, result } = await runPredicateScenario(t, {
    evidence: durableEvidence("applied", {
      application: { ownershipGeneration: FOLLOWUP_GENERATION + 1 },
    }),
  });
  assert.equal(result.status, "failed");
  assert.match(result.failure.message, /central acquire evidence identity/i);
  assert.equal(observations(events).length, 0);
});

test("logical duplicate, mixed application, and partial evidence are conflicts", async (t) => {
  const cases = [
    durableEvidence("conflict", {
      logicalAcquireEventCount: 2,
      transportReceiptCount: 2,
      conflict: "logical_event_duplicate",
    }),
    durableEvidence("conflict", {
      logicalAcquireEventCount: 1,
      transportReceiptCount: 2,
      conflict: "mixed_application",
    }),
    durableEvidence("conflict", {
      logicalAcquireEventCount: 1,
      transportReceiptCount: 0,
      conflict: "partial_evidence",
    }),
  ];
  const outcomes = [];
  for (const evidence of cases) {
    const run = await runPredicateScenario(t, { evidence });
    outcomes.push({
      status: run.result.status,
      message: run.result.failure?.message ?? "",
      observations: observations(run.events).length,
    });
  }
  assert.deepEqual(outcomes.map(({ status, observations }) => ({ status, observations })),
    cases.map(() => ({ status: "failed", observations: 0 })));
  for (const outcome of outcomes) {
    assert.match(outcome.message, /harness evidence conflict/i);
  }
});

test("a nonzero counter remains a no-sentinel control", async (t) => {
  const { events, result } = await runPredicateScenario(t, { counter: 1 });
  assert.equal(result.status, "failed");
  assert.equal(observations(events).length, 0);
});

test("durable evidence fixtures form an explicit MECE control", () => {
  assert.deepEqual(
    ["applied", "no_transition", "conflict"].map((kind) => (
      durableEvidence(kind).classification
    )),
    ["applied", "no_transition", "conflict"],
  );
});

test("cleanup failure is preserved beside an exact no-transition observation", async (t) => {
  const { events, result } = await runPredicateScenario(t, {
    evidence: durableEvidence("no_transition"),
    cleanupFailure: true,
  });
  const observed = observations(events).find((event) => (
    event.details.mutationObservation.sentinel
      === "sessions_row_acquire_transition_not_reached"
  ));
  assert.ok(observed, `mutation observation was not recorded: ${JSON.stringify(events)}`);
  assert.equal(result.status, "failed");
  assert.equal(
    result.verdict?.mutationDetection?.sentinel,
    "sessions_row_acquire_transition_not_reached",
    `recorded observation was lost during cleanup: ${JSON.stringify(result)}`,
  );
  assert.match(result.cleanupFailure?.message ?? "", /injected cleanup failure/);
});
