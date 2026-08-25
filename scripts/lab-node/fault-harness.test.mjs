import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EvidenceRecorder } from "./fault-harness-evidence.mjs";
import { MUTATION_COVERAGE } from "./fault-harness-mutation.mjs";
import {
  classifyHarnessStatus,
  preflightRefusalReasons,
} from "./fault-scenario-result.mjs";
import { canonicalScenarioOrder } from "./fault-scenarios.mjs";
import {
  assertMatchingProvenance,
  assertFetchRefspecCoversMain,
  LabRuntime,
  runnerOperationSnapshots,
} from "./fault-harness-runtime.mjs";
import {
  SCENARIO_DEFINITIONS,
  autoResumeHandoffViolations,
  buildDurableDeliverySeed,
  buildInterventionPayload,
  countMatchingTimelineEvents,
  evaluateInvariantSnapshot,
  inPostTurnAutoResumeHandoffWindow,
  newInvariantViolations,
  parseHarnessArguments,
  redactEvidenceLine,
  restartWindowContinuityViolations,
  restartWindowDurableViolations,
  toggleReleaseGeneration,
} from "./fault-harness-contract.mjs";

test("assistant marker detection ignores the marker echoed by the user prompt", () => {
  const timeline = {
    messages: [
      { event_type: "user_message", payload: { text: "Reply exactly MARKER." } },
      { event_type: "assistant_message", payload: { content: "working" } },
    ],
  };
  assert.equal(countMatchingTimelineEvents(timeline, "assistant_message", "MARKER"), 0);
  timeline.messages.push({
    event_type: "assistant_message",
    payload: { content: "MARKER" },
  });
  assert.equal(countMatchingTimelineEvents(timeline, "assistant_message", "MARKER"), 1);
});

test("runner operation snapshots expose active-turn presence without patch-specific logs", () => {
  const snapshots = runnerOperationSnapshots([
    "not json",
    JSON.stringify({
      time: 1,
      msg: "node event loop delay summary",
      activeRunnerOperations: [{ sessionId: "session-a", operation: "execute" }],
    }),
    JSON.stringify({
      time: 2,
      msg: "node event loop delay summary",
      activeRunnerOperations: [],
    }),
  ].join("\n"));
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].activeRunnerOperations[0].sessionId, "session-a");
  assert.deepEqual(snapshots[1].activeRunnerOperations, []);
});

test("lab verdict refuses a bundle built from a different checkout", () => {
  assert.doesNotThrow(() => assertMatchingProvenance("8470285a", "8470285a"));
  assert.throws(
    () => assertMatchingProvenance("b02adf1c", "8470285a"),
    /lab provenance mismatch: bundle b02adf1c != checkout 8470285a/,
  );
  assert.doesNotThrow(() => assertFetchRefspecCoversMain([
    "+refs/heads/*:refs/remotes/origin/*",
  ]));
  assert.throws(
    () => assertFetchRefspecCoversMain([
      "+refs/heads/lab-node:refs/remotes/origin/lab-node",
    ]),
    /does not fetch origin\/main/,
  );
});

test("intervention acceptance uses the explicit 60 second deadline", async () => {
  const runtime = new LabRuntime({
    LAB_ROOT: "/home/eias/services/soulstream-lab",
    LAB_REPO: "/home/eias/services/soulstream-lab/repo",
    LAB_ORCH_PORT: "5300",
    LAB_NODE_PORT: "3116",
    LAB_POSTGRES_CONTAINER: "soulstream-lab-postgres",
    LAB_POSTGRES_DB: "soulstream_lab",
    LAB_POSTGRES_USER: "soulstream_lab",
    LAB_AUTH_BEARER_TOKEN: "test-token",
    LAB_INTERVENTION_ACCEPTANCE_TIMEOUT_MS: "60000",
  });
  runtime.postJson = async (...args) => args;
  const call = await runtime.intervene("session-a", { text: "hello" });
  assert.equal(call[2], 60_000);
});

test("preflight refuses invariant, central-state, ownership, and runner residue", () => {
  assert.deepEqual(preflightRefusalReasons({
    violations: [],
    nonterminalSessions: [],
    openOwnerships: [],
    runnerProcesses: [],
  }), []);
  assert.deepEqual(preflightRefusalReasons({
    violations: [{ invariant: "runner_terminal_projection", count: 1 }],
    nonterminalSessions: [{ session_id: "old", status: "running" }],
    openOwnerships: [{ session_id: "old", ownership_generation: 2 }],
    runnerProcesses: [{ pid: 42 }],
  }), [
    "invariant:runner_terminal_projection",
    "nonterminal_session:old:running",
    "open_ownership:old:2",
    "runner_process:42",
  ]);
});

test("top-level status separates new violations from harness errors", () => {
  assert.equal(classifyHarnessStatus({ fatalFailure: { message: "boom" } }),
    "failed_harness_error");
  assert.equal(classifyHarnessStatus({ failureCount: 1 }), "failed_new_violation");
  assert.equal(classifyHarnessStatus({ inconclusiveCount: 1 }), "inconclusive");
  assert.equal(classifyHarnessStatus({}), "passed");
});

test("result evidence records the exact checkout, bundle, origin main, and refspec", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lab-evidence-provenance-"));
  try {
    const provenance = {
      checkoutCommit: "a".repeat(40),
      bundleSourceCommit: "a".repeat(40),
      originMainCommit: "b".repeat(40),
      fetchRefspecs: ["+refs/heads/*:refs/remotes/origin/*"],
      releaseManifestId: "sha256-release",
      releaseCohortId: "sha256-cohort",
    };
    const recorder = new EvidenceRecorder({}, "run", directory, provenance);
    await recorder.finish({ status: "passed" });
    const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
    assert.deepEqual(result.provenance, provenance);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("auto-resume oracle rejects response loss, duplicate consumption, and runner replacement", () => {
  const clean = {
    attempts: [{
      deliveryReceiptCount: 1,
      consumptionCount: 1,
      userMessageCount: 1,
      turnBoundaryCount: 2,
      successfulTurnBoundaryCount: 2,
      childTerminalStatus: "completed",
      parentTerminalStatus: "completed",
      oldPid: 41,
      observedPids: [41],
    }],
    executionPromiseBlockedCount: 0,
    replacementLogCount: 0,
    socketErrorCount: 0,
  };
  assert.deepEqual(autoResumeHandoffViolations(clean), []);
  for (const mutation of [
    { attempts: [{ ...clean.attempts[0], turnBoundaryCount: 1, successfulTurnBoundaryCount: 1 }] },
    { attempts: [{ ...clean.attempts[0], consumptionCount: 2 }] },
    { attempts: [{ ...clean.attempts[0], deliveryReceiptCount: 2 }] },
    { attempts: [{ ...clean.attempts[0], observedPids: [41, 42] }] },
    { executionPromiseBlockedCount: 1 },
    { socketErrorCount: 1 },
  ]) {
    assert.notDeepEqual(autoResumeHandoffViolations({ ...clean, ...mutation }), []);
  }
});

test("auto-resume only judges attempts in the first second after the turn ends", () => {
  assert.equal(inPostTurnAutoResumeHandoffWindow(1), true);
  assert.equal(inPostTurnAutoResumeHandoffWindow(1_000), true);
  assert.equal(inPostTurnAutoResumeHandoffWindow(-1), false);
  assert.equal(inPostTurnAutoResumeHandoffWindow(0), false);
  assert.equal(inPostTurnAutoResumeHandoffWindow(1_001), false);
  assert.equal(inPostTurnAutoResumeHandoffWindow(null), false);
});

test("restart-window oracle rejects loss, duplicates, residue, in-flight, and replacement mutations", () => {
  const clean = {
    acceptance: { status: "ok", outcome: "queued" },
    interventionCount: 1,
    oldAssistantCount: 1,
    assistantCount: 1,
    inboxRemainingCount: 0,
    inFlightCount: 0,
    oldPid: 41,
    newPid: 41,
    oldReleaseManifestId: "release-old",
    newReleaseManifestId: "release-old",
    replacementLogCount: 0,
  };
  assert.deepEqual(restartWindowContinuityViolations(clean), []);
  for (const mutation of [
    { acceptance: { status: "ok", outcome: "deferred", delivered: false } },
    { interventionCount: 0 },
    { interventionCount: 2 },
    { oldAssistantCount: 0 },
    { assistantCount: 2 },
    { inboxRemainingCount: 1 },
    { inFlightCount: 1 },
    { newPid: 42 },
    { replacementLogCount: 1 },
  ]) {
    assert.notDeepEqual(restartWindowContinuityViolations({ ...clean, ...mutation }), []);
  }
});

test("restart-window durable oracle rejects receipt, consumption, response, and adoption mutations", () => {
  const clean = {
    acceptance: { status: "ok", outcome: "queued" },
    delivery: {
      state: "consumed",
      aggregate_state: "consumed",
      target_receipt_id: "event:17",
    },
    deliveryCount: 1,
    interventionCount: 1,
    assistantCount: 1,
    inboxRemainingCount: 0,
    inFlightCount: 0,
    sessionStatus: "completed",
    oldPid: 41,
    newPid: 41,
    oldReleaseManifestId: "release-old",
    newReleaseManifestId: "release-old",
    replacementLogCount: 0,
  };
  assert.deepEqual(restartWindowDurableViolations(clean), []);
  for (const mutation of [
    { acceptance: { status: "rejected", reason: { message: "HTTP 503 NODE_UNAVAILABLE" } } },
    { deliveryCount: 0, delivery: null },
    { deliveryCount: 2 },
    { delivery: { ...clean.delivery, state: "pending", aggregate_state: "pending" } },
    { delivery: { ...clean.delivery, target_receipt_id: null } },
    { interventionCount: 0 },
    { interventionCount: 2 },
    { assistantCount: 0 },
    { assistantCount: 2 },
    { inboxRemainingCount: 1 },
    { inFlightCount: 1 },
    { sessionStatus: "running" },
    { newPid: 42 },
    { newReleaseManifestId: "release-new" },
    { replacementLogCount: 1 },
  ]) {
    assert.notDeepEqual(restartWindowDurableViolations({ ...clean, ...mutation }), []);
  }
});

test("fault catalog is complete and F1 explicitly covers both host signals", () => {
  assert.deepEqual(Object.keys(SCENARIO_DEFINITIONS), [
    "steady-state",
    "auto-resume-handoff",
    "restart-adopt",
    "restart-intervention-window",
    "restart-window-durable",
    "delivery-revival",
    "delivery-exact-once",
    "delivery-fifo",
    "delivery-accepted-cas",
    "F1",
    "F11",
    "F9",
    "dead-owner",
    "runner-death-live-host",
    "activate-rollback",
    "F7",
  ]);
  assert.deepEqual(SCENARIO_DEFINITIONS.F1.modes, ["SIGTERM", "SIGKILL"]);
  for (const scenario of Object.values(SCENARIO_DEFINITIONS)) {
    assert.ok(scenario.injection.length > 0);
    assert.ok(scenario.expectedOutcome.length > 0);
    assert.ok(scenario.verdict.length > 0);
  }
});

test("delivery scenarios follow normal controls and precede accident reproductions", () => {
  assert.deepEqual(canonicalScenarioOrder(), [
    "steady-state",
    "auto-resume-handoff",
    "restart-adopt",
    "restart-intervention-window",
    "restart-window-durable",
    "delivery-revival",
    "delivery-exact-once",
    "delivery-fifo",
    "delivery-accepted-cas",
    "runner-death-live-host",
    "activate-rollback",
    "F9",
    "dead-owner",
    "F1",
    "F11",
    "F7",
  ]);
});

test("traffic loop defaults are bounded and concurrency above two is rejected", () => {
  assert.deepEqual(parseHarnessArguments(["cycle"]), {
    command: "cycle",
    concurrency: 1,
    cycles: 1,
    intervalSeconds: 300,
  });
  assert.deepEqual(
    parseHarnessArguments([
      "cycle",
      "--concurrency",
      "2",
      "--cycles",
      "3",
      "--interval-seconds",
      "0",
    ]),
    { command: "cycle", concurrency: 2, cycles: 3, intervalSeconds: 0 },
  );
  assert.throws(
    () => parseHarnessArguments(["cycle", "--concurrency", "3"]),
    /concurrency must be 1 or 2/,
  );
});

test("scenario CLI accepts the transparent baseline and restart gates", () => {
  for (const scenarioId of [
    "steady-state",
    "auto-resume-handoff",
    "restart-adopt",
    "restart-intervention-window",
    "restart-window-durable",
    "delivery-revival",
    "delivery-exact-once",
    "delivery-fifo",
    "delivery-accepted-cas",
  ]) {
    assert.deepEqual(parseHarnessArguments(["scenario", scenarioId]), {
      command: "scenario",
      scenarioId,
    });
  }
  assert.deepEqual(parseHarnessArguments(["scenario", "F9"]), {
    command: "scenario",
    scenarioId: "F9",
  });
  assert.deepEqual(parseHarnessArguments(["scenario", "runner-death-live-host"]), {
    command: "scenario",
    scenarioId: "runner-death-live-host",
  });
  assert.deepEqual(parseHarnessArguments(["scenario", "activate-rollback"]), {
    command: "scenario",
    scenarioId: "activate-rollback",
  });
  assert.deepEqual(parseHarnessArguments(["all"]), { command: "all" });
  assert.throws(
    () => parseHarnessArguments(["scenario", "unknown"]),
    /unknown scenario/,
  );
});

test("F9 manifest perturbation changes only a credential generation identity input", () => {
  const original = "PORT=3116\nSOUL_RUNNER_LEASE_TIMEOUT_MS=1800000\nATOM_ENABLED=false\n";
  const first = toggleReleaseGeneration(original);
  assert.equal(first.previous, null);
  assert.equal(first.next, "lab-fault-a");
  assert.equal(
    first.text,
    `${original}AUTH_BEARER_TOKEN_GENERATION=lab-fault-a\n`,
  );
  const second = toggleReleaseGeneration(first.text);
  assert.equal(second.previous, "lab-fault-a");
  assert.equal(second.next, "lab-fault-b");
  assert.equal(
    second.text,
    `${original}AUTH_BEARER_TOKEN_GENERATION=lab-fault-b\n`,
  );
  assert.equal(toggleReleaseGeneration(second.text).text, first.text);
});

test("F11 retry reuses a stable delivery id and exact-consume metadata", () => {
  const first = buildInterventionPayload(
    "delivery-f11-0001",
    "Reply exactly F11_INTERVENTION_OK.",
  );
  const retry = buildInterventionPayload(
    "delivery-f11-0001",
    "Reply exactly F11_INTERVENTION_OK.",
  );
  assert.deepEqual(retry, first);
  assert.equal(first.delivery_id, "delivery-f11-0001");
  assert.equal(first.delivery_intent, "human_live_steer");
  assert.equal(first.source, "lab_fault_harness");
});

test("delivery fault seeds preserve one canonical API and ledger identity", () => {
  const first = buildDurableDeliverySeed(
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "Reply exactly DELIVERY_OK.",
    "lab-cas",
  );
  const retry = buildDurableDeliverySeed(
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "Reply exactly DELIVERY_OK.",
    "lab-cas",
  );
  assert.deepEqual(retry, first);
  assert.equal(first.intervention.delivery_id, first.deliveryId);
  assert.equal(first.intervention.relation_key, first.relationKey);
  assert.equal(first.intervention.completion_id, first.completionId);
  assert.equal(first.payload.logical_message_id, first.deliveryId);
  assert.match(first.payloadHash, /^[0-9a-f]{64}$/);
});

test("distinct transport deliveries can retain one logical message identity", () => {
  const first = buildDurableDeliverySeed(
    "33333333-3333-4333-8333-333333333333",
    "22222222-2222-4222-8222-222222222222",
    "Reply exactly DELIVERY_RETRY_OK.",
    undefined,
    "client-message-1",
  );
  const retry = buildDurableDeliverySeed(
    "44444444-4444-4444-8444-444444444444",
    "22222222-2222-4222-8222-222222222222",
    "Reply exactly DELIVERY_RETRY_OK.",
    undefined,
    "client-message-1",
  );
  assert.notEqual(first.deliveryId, retry.deliveryId);
  assert.equal(first.payload.logical_message_id, retry.payload.logical_message_id);
});

test("invariant verdict distinguishes explained dead letters from ambiguity", () => {
  const clean = evaluateInvariantSnapshot({
    ownerlessRunning: 0,
    terminalProjectionMismatches: [],
    overdueRetries: 0,
    ambiguousUncertain: 0,
    reasonlessDeadLetters: 0,
    activationManifestMismatch: false,
  });
  assert.deepEqual(clean, []);

  const violations = evaluateInvariantSnapshot({
    ownerlessRunning: 1,
    terminalProjectionMismatches: [{ sessionId: "session-a" }],
    overdueRetries: 2,
    ambiguousUncertain: 1,
    reasonlessDeadLetters: 1,
    activationManifestMismatch: true,
  });
  assert.deepEqual(
    violations.map((violation) => violation.invariant),
    [
      "ownerless_running",
      "runner_terminal_projection",
      "overdue_retry",
      "ambiguous_uncertain",
      "reasonless_dead_letter",
      "activation_manifest",
    ],
  );
});

test("invariant deltas preserve global samples without blaming later scenarios", () => {
  const before = [
    { invariant: "runner_terminal_projection", count: 1, examples: [{ sessionId: "old" }] },
  ];
  const after = [
    {
      invariant: "runner_terminal_projection",
      count: 2,
      examples: [{ sessionId: "old" }, { sessionId: "new" }],
    },
    { invariant: "overdue_retry", count: 1, examples: [] },
  ];
  assert.deepEqual(newInvariantViolations(before, after), [
    { invariant: "runner_terminal_projection", count: 1, examples: [{ sessionId: "new" }] },
    { invariant: "overdue_retry", count: 1, examples: [] },
  ]);
});

test("evidence redaction removes bearer tokens and known lab secrets", () => {
  const line = "Authorization: Bearer abc123 password=lab-secret token=abc123";
  const redacted = redactEvidenceLine(line, ["lab-secret", "abc123"]);
  assert.doesNotMatch(redacted, /abc123|lab-secret/);
  assert.match(redacted, /<redacted>/);
});

test("an unanswered user turn is a violation even when delivery bookkeeping is clean", () => {
  // The 260822 F9 reproduction produced exactly this snapshot: no dead
  // letters, no overdue retries, nothing uncertain, and a user turn that
  // never got a reply. The judge used to report it as healthy.
  const clean = {
    ownerlessRunning: 0,
    terminalProjectionMismatches: [],
    overdueRetries: 0,
    ambiguousUncertain: 0,
    reasonlessDeadLetters: 0,
    activationManifestMismatch: false,
    unansweredDemands: [
      { session_id: "f2620ddb", status: "completed", demand_event_id: 6,
        demand_event_type: "user_message", excerpt: "reply with the marker" },
    ],
  };
  const violations = evaluateInvariantSnapshot(clean);
  assert.deepEqual(violations.map((violation) => violation.invariant), ["unanswered_demand"]);
  assert.equal(violations[0].count, 1);

  const answered = { ...clean, unansweredDemands: [] };
  assert.deepEqual(evaluateInvariantSnapshot(answered), []);
});

test("a violation that clears while another appears is still reported", () => {
  // Counting hid this: one old violation resolving as one new one arrives
  // makes the delta zero, and the run passed while a session it had just
  // broken sat in the list.
  const before = [{
    invariant: "unanswered_demand",
    count: 1,
    examples: [{ session_id: "old-one" }],
  }];
  const after = [{
    invariant: "unanswered_demand",
    count: 1,
    examples: [{ session_id: "new-one" }],
  }];
  const fresh = newInvariantViolations(before, after);
  assert.equal(fresh.length, 1);
  assert.deepEqual(fresh[0].examples, [{ session_id: "new-one" }]);
});

test("ownerless running sessions are named, so a swap is not a wash", () => {
  // This used to be counted, and a count cannot tell an old violation clearing
  // from a new one arriving -- the two cancelled and the run passed.
  const before = evaluateInvariantSnapshot({
    ownerlessRunning: [{ session_id: "old-one" }],
    terminalProjectionMismatches: [],
    overdueRetries: [],
    ambiguousUncertain: [],
    reasonlessDeadLetters: [],
    activationManifestMismatch: false,
    unansweredDemands: [],
  });
  const after = evaluateInvariantSnapshot({
    ownerlessRunning: [{ session_id: "new-one" }],
    terminalProjectionMismatches: [],
    overdueRetries: [],
    ambiguousUncertain: [],
    reasonlessDeadLetters: [],
    activationManifestMismatch: false,
    unansweredDemands: [],
  });
  const fresh = newInvariantViolations(before, after);
  assert.equal(fresh.length, 1);
  assert.deepEqual(fresh[0].examples, [{ session_id: "new-one" }]);
});

test("every invariant the verdict can emit has a mutation that plants it", () => {
  // The gate that would have caught `user_message_loss` on the day it was
  // written. An invariant with no mutation has never been observed to fire;
  // shipping one is shipping a green light wired to nothing.
  const everyInvariant = evaluateInvariantSnapshot({
    ownerlessRunning: [{ session_id: "a" }],
    terminalProjectionMismatches: [{ sessionId: "a" }],
    overdueRetries: [{ delivery_id: "a" }],
    ambiguousUncertain: [{ delivery_id: "a" }],
    reasonlessDeadLetters: [{ delivery_id: "a" }],
    activationManifestMismatch: true,
    unansweredDemands: [{ session_id: "a", demand_event_id: 1 }],
  }).map((violation) => violation.invariant);

  const uncovered = everyInvariant.filter((name) => !MUTATION_COVERAGE.includes(name));
  assert.deepEqual(uncovered, [], `invariants with no mutation: ${uncovered.join(", ")}`);
});

test("the deleted judges are gone, not renamed", () => {
  // `user_message_loss` read a function parameter that every caller set to
  // `[]`; `unanswered_user_input` compared the newest input id against the
  // newest reply id, so one reply cleared every input at once. Neither is
  // repairable in place, and leaving either name alive would let a future
  // reader assume the coverage still exists.
  const names = evaluateInvariantSnapshot({
    ownerlessRunning: [],
    terminalProjectionMismatches: [],
    overdueRetries: [],
    ambiguousUncertain: [],
    reasonlessDeadLetters: [],
    activationManifestMismatch: true,
    unansweredDemands: [{ session_id: "a" }],
  }).map((violation) => violation.invariant);
  assert.ok(!names.includes("user_message_loss"));
  assert.ok(!names.includes("unanswered_user_input"));
  assert.ok(names.includes("unanswered_demand"));
});
