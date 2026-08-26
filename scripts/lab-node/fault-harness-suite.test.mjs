import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIORITY_FAULT_SCENARIOS,
  aggregateScenarioExecutions,
} from "./fault-harness-suite.mjs";

test("a scenario timeout is isolated and every later fault scenario remains reached", () => {
  const executions = [
    { id: "F7", exitCode: 0, scenarioStatus: "passed" },
    { id: "F11", exitCode: 124 },
    { id: "dead-owner", exitCode: 1, scenarioStatus: "inconclusive_timing_window" },
    { id: "F9", exitCode: 1, scenarioStatus: "failed" },
    { id: "F1", exitCode: 0, scenarioStatus: "passed" },
  ];

  const aggregate = aggregateScenarioExecutions(PRIORITY_FAULT_SCENARIOS, executions);

  assert.deepEqual(
    aggregate.scenarioResults.map(({ id, verdict }) => ({ id, verdict })),
    [
      { id: "F1", verdict: "passed" },
      { id: "F11", verdict: "timeout" },
      { id: "F9", verdict: "failed" },
      { id: "dead-owner", verdict: "inconclusive" },
      { id: "F7", verdict: "passed" },
    ],
  );
  assert.equal(aggregate.scenarioResults.every((result) => result.reached), true);
  assert.equal(aggregate.status, "failed");
});

test("aggregate rejects missing or duplicate scenario executions", () => {
  assert.throws(
    () => aggregateScenarioExecutions(["F1", "F11"], [
      { id: "F1", exitCode: 0, scenarioStatus: "passed" },
    ]),
    /missing scenario execution: F11/,
  );
  assert.throws(
    () => aggregateScenarioExecutions(["F1"], [
      { id: "F1", exitCode: 0, scenarioStatus: "passed" },
      { id: "F1", exitCode: 124 },
    ]),
    /duplicate scenario execution: F1/,
  );
});
