import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIORITY_FAULT_SCENARIOS,
  aggregateScenarioExecutions,
  runScenarioInventory,
} from "./fault-harness-suite.mjs";

test("a scenario timeout is isolated and every later fault scenario remains reached", async () => {
  const launched = [];
  const executions = await runScenarioInventory(PRIORITY_FAULT_SCENARIOS, async (id) => {
    launched.push(id);
    if (id === "F11") return { exitCode: 124 };
    if (id === "F9") {
      return { exitCode: 1, harnessStatus: "failed_new_violation", scenarioStatus: "failed" };
    }
    if (id === "dead-owner") {
      return {
        exitCode: 1,
        harnessStatus: "inconclusive",
        scenarioStatus: "inconclusive_timing_window",
      };
    }
    return { exitCode: 0, harnessStatus: "passed", scenarioStatus: "passed" };
  });

  const aggregate = aggregateScenarioExecutions(PRIORITY_FAULT_SCENARIOS, executions);

  assert.deepEqual(launched, PRIORITY_FAULT_SCENARIOS);
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
