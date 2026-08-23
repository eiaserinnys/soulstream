import assert from "node:assert/strict";
import test from "node:test";

import { MUTATION_COVERAGE } from "./fault-harness-mutation.mjs";
import { runnerOperationSnapshots } from "./fault-harness-runtime.mjs";
import {
  SCENARIO_DEFINITIONS,
  buildInterventionPayload,
  countMatchingTimelineEvents,
  evaluateInvariantSnapshot,
  newInvariantViolations,
  parseHarnessArguments,
  redactEvidenceLine,
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

test("fault catalog is complete and F1 explicitly covers both host signals", () => {
  assert.deepEqual(Object.keys(SCENARIO_DEFINITIONS), [
    "steady-state",
    "restart-adopt",
    "restart-intervention-window",
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
    "restart-adopt",
    "restart-intervention-window",
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
