import { randomUUID } from "node:crypto";

import { defineHarnessBoundary } from "./fault-harness-boundary.mjs";
import { buildInterventionPayload } from "./fault-harness-contract.mjs";
import { waitForConsumedDelivery } from "./fault-harness-delivery.mjs";
import { delay } from "./fault-harness-runtime.mjs";
import {
  assertScenario,
  shortId,
  withBaselineHonesty,
} from "./fault-scenario-result.mjs";

/** Runs traffic cycles and waits for every worker before returning or throwing. */
export const runTrafficCycles = defineHarnessBoundary({
  name: "traffic_workers_settle_before_return",
  what: "a failed traffic worker is rethrown only after every sibling worker has stopped",
  async implementation(options, runtime, recorder, worker = runCycleWorker) {
    const queue = Array.from({ length: options.cycles }, (_, index) => index + 1);
    const results = [];
    const state = { stopping: false };
    const settled = await Promise.allSettled(
      Array.from({ length: options.concurrency }, (_, workerIndex) => (
        worker(
          workerIndex + 1, queue, results, options.intervalSeconds, runtime, recorder, state,
        )
      )),
    );
    const failures = settled
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    if (failures.length > 0) {
      const error = failures.length === 1
        ? failures[0]
        : new AggregateError(failures, `${failures.length} traffic cycle workers failed`);
      throw error;
    }
    return results.sort((left, right) => left.cycle - right.cycle);
  },
  async contract(run) {
    const firstFailure = new Error("contract worker failed");
    let siblingFinished = false;
    const worker = async (workerIndex) => {
      if (workerIndex === 1) throw firstFailure;
      await delay(25);
      siblingFinished = true;
    };
    let caught;
    try {
      await run(
        { concurrency: 2, cycles: 2, intervalSeconds: 0 },
        {},
        {},
        worker,
      );
    } catch (error) {
      caught = error;
    }
    assertScenario(caught === firstFailure, "the failing worker was not rethrown");
    assertScenario(
      siblingFinished,
      "the worker failure escaped before its sibling finished",
    );
  },
});

async function runCycleWorker(
  worker, queue, results, intervalSeconds, runtime, recorder, state,
) {
  try {
    await driveCycles(worker, queue, results, intervalSeconds, runtime, recorder, state);
  } catch (error) {
    state.stopping = true;
    throw error;
  }
}

async function driveCycles(worker, queue, results, intervalSeconds, runtime, recorder, state) {
  while (queue.length > 0 && !state.stopping) {
    const cycle = queue.shift();
    if (cycle === undefined) return;
    const baseline = await recorder.invariant(`before-cycle-${cycle}`);
    const result = await runTrafficCycle(cycle, worker, runtime, recorder);
    results.push(result);
    const invariant = await recorder.invariant(
      `after-cycle-${cycle}`,
      baseline.violations,
      90_000,
    );
    result.invariant = invariant;
    if (invariant.newViolations.length > 0) result.status = "failed";
    Object.assign(result, withBaselineHonesty(result, baseline, invariant));
    await recorder.scenario(`cycle-${cycle}`, result);
    if (queue.length > 0 && !state.stopping) await delay(intervalSeconds * 1_000);
  }
}

async function runTrafficCycle(cycle, worker, runtime, recorder) {
  const seed = shortId();
  const parentMarker = `CYCLE_PARENT_${seed}`;
  const initialMarker = `CYCLE_INITIAL_${seed}`;
  const finalMarker = `CYCLE_FINAL_${seed}`;
  const parentId = await runtime.createSession(
    `Reply with exactly ${parentMarker}. When a child completion arrives, acknowledge it briefly.`,
  );
  await runtime.waitForMarker(parentId, parentMarker);
  await runtime.waitForTerminal(parentId);
  const sessionId = await runtime.createSession(`Reply with exactly ${initialMarker}.`, {
    caller_session_id: parentId,
  });
  await runtime.waitForMarker(sessionId, initialMarker);
  await runtime.waitForTerminal(sessionId);
  const initialDelivery = await waitForConsumedDelivery(
    runtime,
    sessionId,
    "initial cycle completion",
  );
  const cancelText = "Use Bash once to run "
    + 'python3 -c "import time; time.sleep(12)"'
    + `, then reply CYCLE_CANCELLED_${seed}.`;
  await runtime.intervene(sessionId, buildInterventionPayload(randomUUID(), cancelText));
  await runtime.waitForRunner(sessionId);
  await delay(1_000);
  await runtime.interrupt(sessionId);
  const interruptedStatus = await runtime.waitForTerminal(sessionId);
  const interruptedDelivery = await waitForConsumedDelivery(
    runtime,
    sessionId,
    "interrupted cycle completion",
    initialDelivery.delivery_id,
  );
  await runtime.intervene(
    sessionId,
    buildInterventionPayload(randomUUID(), `Reply with exactly ${finalMarker}.`),
  );
  await runtime.waitForMarker(sessionId, finalMarker);
  const finalStatus = await runtime.waitForTerminal(sessionId);
  const completionDelivery = await waitForConsumedDelivery(
    runtime,
    sessionId,
    "final cycle completion",
    interruptedDelivery.delivery_id,
  );
  const consumptionCount = await runtime.consumptionCount(completionDelivery.relation_key);
  const initialCount = await runtime.countTimelineEvents(sessionId, "assistant_message", initialMarker);
  const finalCount = await runtime.countTimelineEvents(sessionId, "assistant_message", finalMarker);
  assertScenario(initialCount === 1 && finalCount === 1, "traffic cycle lost or duplicated a marker");
  assertScenario(consumptionCount === 1, `traffic cycle completion consumption count was ${consumptionCount}`);
  await recorder.event("traffic_cycle_finished", { cycle, worker, sessionId, finalStatus });
  return {
    id: `cycle-${cycle}`,
    status: "passed",
    cycle,
    worker,
    parentId,
    sessionId,
    interruptedStatus,
    finalStatus,
    markerCounts: { initial: initialCount, final: finalCount },
    completionDeliveries: {
      initial: initialDelivery,
      interrupted: interruptedDelivery,
      final: completionDelivery,
    },
    consumptionCount,
  };
}
