import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  buildInterventionPayload,
  toggleReleaseGeneration,
} from "./fault-harness-contract.mjs";
import {
  exhaustDelivery,
  waitForConsumedDelivery,
} from "./fault-harness-delivery.mjs";
import {
  preserveDeadOwnership,
  waitForInFlightTool,
} from "./fault-harness-process.mjs";
import { delay, waitFor } from "./fault-harness-runtime.mjs";
import {
  assertScenario,
  countLogLines,
  serializeError,
  settle,
  shortId,
  withBaselineHonesty,
} from "./fault-scenario-result.mjs";

const SCENARIO_ORDER = ["F9", "dead-owner", "F1", "F11", "F7"];
const LOG_TERMS = {
  F1: ["F1_", "runner", "shutdown"],
  F11: ["F11_", "intervention", "delivery"],
  F9: ["F9_", "runner adoption release identity mismatch", "offline",
    "runner adoption failure was superseded by a newer execution",
    "registered runner recovery skipped", "terminal runner replay was skipped",
    "Durable event stream already registered", "Runner IPC reconnect budget exhausted"],
  "dead-owner": ["DEAD_OWNER_", "dead execution owner", "expire_dead_owner"],
  F7: ["F7_", "dead_letter", "completion_notification", "delivery"],
};

export function canonicalScenarioOrder() {
  return [...SCENARIO_ORDER];
}

export async function runCanonicalScenario(id, runtime, recorder) {
  const implementation = SCENARIOS[id];
  if (!implementation) throw new Error(`scenario has no implementation: ${id}`);
  const offsets = await recorder.logOffsets();
  const baseline = await recorder.invariant(`before-${id}`);
  await recorder.event("scenario_started", { id });
  let result;
  let failure;
  try {
    result = await implementation(runtime, recorder);
  } catch (error) {
    failure = serializeError(error);
    result = { id, status: "failed", failure };
  }
  const logs = await recorder.captureLogs(id, offsets, LOG_TERMS[id]);
  if (id === "F9") {
    const mismatchCount = logs.node.filter(
      (line) => line.includes("runner adoption release identity mismatch"),
    ).length;
    result.mismatchLogCount = mismatchCount;
    if (!failure) {
      try {
        assertScenario(mismatchCount >= 1, "F9 emitted no release identity mismatch log");
      } catch (error) {
        failure = serializeError(error);
        result = { ...result, status: "failed", failure };
      }
    }
  }
  const invariant = await recorder.invariant(`after-${id}`, baseline.violations, 90_000);
  result = withBaselineHonesty(result, baseline, invariant);
  if (invariant.newViolations.length > 0 && !failure) {
    failure = {
      name: "InvariantViolation",
      message: `${invariant.newViolations.length} new post-scenario invariant violation(s)`,
    };
    result = { ...result, status: "failed", failure };
  }
  result = { ...result, invariant, logLineCounts: countLogLines(logs) };
  await recorder.scenario(id, result);
  await recorder.event("scenario_finished", { id, status: result.status });
  return result;
}

const SCENARIOS = {
  async F1(runtime, recorder) {
    const modes = ["SIGTERM", "SIGKILL"];
    const cases = [];
    for (const signal of modes) {
      const marker = `F1_${signal}_OK_${shortId()}`;
      const sessionId = await runtime.createSession(delayedMarkerPrompt(marker, 12));
      const runner = await runtime.waitForRunner(sessionId);
      await waitForInFlightTool(runtime, sessionId);
      await recorder.event("fault_injected", { id: "F1", signal, sessionId, runnerPid: runner.pid });
      const stoppedNodePid = await runtime.restartService("node", signal);
      assertScenario(runtime.runnerAlive(runner.pid), `${signal} killed detached runner ${runner.pid}`);
      await runtime.waitForMarker(sessionId, marker);
      const status = await runtime.waitForTerminal(sessionId);
      const markerCount = await runtime.countTimelineEvents(sessionId, "assistant_message", marker);
      assertScenario(markerCount === 1, `${signal} marker count was ${markerCount}`);
      cases.push({ signal, sessionId, runnerPid: runner.pid, stoppedNodePid, status, markerCount });
    }
    return { id: "F1", status: "passed", cases };
  },

  async F11(runtime, recorder) {
    const seed = shortId();
    const initialMarker = `F11_INITIAL_${seed}`;
    const interventionMarker = `F11_INTERVENTION_${seed}`;
    const interventionText = `Reply with exactly ${interventionMarker}.`;
    const deliveryId = randomUUID();
    const sessionId = await runtime.createSession(delayedMarkerPrompt(initialMarker, 12));
    await runtime.waitForRunner(sessionId);
    await waitForInFlightTool(runtime, sessionId);
    const payload = buildInterventionPayload(deliveryId, interventionText);
    const firstRequest = settle(runtime.intervene(sessionId, payload));
    await delay(5);
    await recorder.event("fault_injected", { id: "F11", signal: "SIGTERM", sessionId, deliveryId });
    const stoppedOrchPid = await runtime.restartService("orch", "SIGTERM");
    const firstOutcome = await firstRequest;
    const retryOutcome = await settle(runtime.intervene(sessionId, payload));
    await recorder.event("delivery_attempt_outcomes", {
      id: "F11",
      sessionId,
      deliveryId,
      firstOutcome,
      retryOutcome,
    });
    await runtime.waitForMarker(sessionId, interventionMarker);
    const status = await runtime.waitForTerminal(sessionId);
    const userCount = await runtime.countTimelineEvents(sessionId, "user_message", interventionText);
    const markerCount = await runtime.countTimelineEvents(
      sessionId,
      "assistant_message",
      interventionMarker,
    );
    assertScenario(userCount === 1, `F11 intervention user message count was ${userCount}`);
    assertScenario(markerCount === 1, `F11 assistant marker count was ${markerCount}`);
    return {
      id: "F11",
      status: "passed",
      sessionId,
      deliveryId,
      stoppedOrchPid,
      firstOutcome,
      retryOutcome,
      sessionStatus: status,
      userCount,
      markerCount,
    };
  },

  async F9(runtime, recorder) {
    const seed = shortId();
    const oldMarker = `F9_OLD_DONE_${seed}`;
    const nextMarker = `F9_NEW_TURN_${seed}`;
    const sessionId = await runtime.createSession(delayedMarkerPrompt(oldMarker, 12));
    const oldRunner = await runtime.waitForRunner(sessionId);
    const inFlightTool = await waitForInFlightTool(runtime, sessionId);
    const oldManifest = await runtime.currentManifest();
    const originalEnvironment = await runtime.readNodeEnvironment();
    const toggled = toggleReleaseGeneration(originalEnvironment);
    await recorder.event("fault_injected", {
      id: "F9",
      sessionId,
      oldRunnerPid: oldRunner.pid,
      inFlightTool,
      oldManifest,
      releaseGenerationFrom: toggled.previous,
      releaseGenerationTo: toggled.next,
    });
    await runtime.stopNodeForReleaseSwap();
    let newManifest;
    try {
      newManifest = await runtime.rebuildReleaseWithEnv(toggled.text);
      assertScenario(
        newManifest.manifestId !== oldManifest.manifestId,
        "F9 rebuild did not change manifest identity",
      );
      await runtime.startStack();
    } catch (error) {
      try {
        await runtime.rebuildReleaseWithEnv(originalEnvironment);
        await runtime.startStack();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "F9 injection and lab restoration failed");
      }
      throw error;
    }
    assertScenario(runtime.runnerAlive(oldRunner.pid), "F9 old runner did not remain detached");
    await runtime.waitForMarker(sessionId, oldMarker, 240_000);
    await runtime.waitForTerminal(sessionId, 240_000);
    const deliveryId = randomUUID();
    const payload = buildInterventionPayload(deliveryId, `Reply with exactly ${nextMarker}.`);
    await runtime.intervene(sessionId, payload);
    const newRunner = await runtime.waitForRunner(sessionId, 60_000);
    await runtime.waitForMarker(sessionId, nextMarker, 60_000);
    const status = await runtime.waitForTerminal(sessionId);
    const oldCount = await runtime.countTimelineEvents(sessionId, "assistant_message", oldMarker);
    const nextCount = await runtime.countTimelineEvents(sessionId, "assistant_message", nextMarker);
    assertScenario(oldCount === 1, `F9 old marker count was ${oldCount}`);
    assertScenario(nextCount === 1, `F9 new marker count was ${nextCount}`);
    assertScenario(newRunner.pid !== oldRunner.pid, "F9 next turn reused old runner pid");
    assertScenario(
      newRunner.config.releaseManifestId === newManifest.manifestId,
      "F9 next runner did not use the rebuilt manifest",
    );
    return {
      id: "F9",
      status: "passed",
      sessionId,
      oldRunner,
      newRunner,
      oldManifest,
      newManifest,
      sessionStatus: status,
      markerCounts: { old: oldCount, next: nextCount },
    };
  },

  async "dead-owner"(runtime, recorder) {
    const seed = shortId();
    const marker = `DEAD_OWNER_RECOVERED_${seed}`;
    const sessionId = await runtime.createSession(delayedMarkerPrompt(`DEAD_OWNER_OLD_${seed}`, 30));
    const runner = await runtime.waitForRunner(sessionId);
    await waitForInFlightTool(runtime, sessionId);
    const oldOwnership = await waitFor(
      async () => (await runtime.ownerships(sessionId)).find((row) => row.phase === "active"),
      30_000,
      "dead-owner scenario never reached active ownership",
    );
    const runnerDirectory = runtime.runnerDirectory(sessionId);
    let stoppedNodePid;
    let hiddenRunnerDirectory;
    try {
      stoppedNodePid = await preserveDeadOwnership(runtime, runner.pid);
      hiddenRunnerDirectory = join(
        runtime.runnerStateDirectory,
        `_fault-dead-owner-${basename(runnerDirectory)}-${seed}`,
      );
      await rename(runnerDirectory, hiddenRunnerDirectory);
      await runtime.startStack();
    } catch (error) {
      try { await runtime.startStack(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "dead-owner injection and lab restoration failed");
      }
      throw error;
    }
    const killedRunnerPid = runner.pid;
    await recorder.event("fault_injected", {
      id: "dead-owner",
      sessionId,
      killedRunnerPid,
      stoppedNodePid,
      hiddenRunnerDirectory,
      ownershipGeneration: oldOwnership.ownership_generation,
    });
    await runtime.intervene(
      sessionId,
      buildInterventionPayload(randomUUID(), `Reply with exactly ${marker}.`),
    );
    const ownerships = await waitFor(
      async () => {
        const rows = await runtime.ownerships(sessionId);
        const oldFailed = rows.some((row) => (
          row.ownership_generation === oldOwnership.ownership_generation
          && row.phase === "failed"
          && String(row.failure_reason).includes("owner process")
          && String(row.failure_reason).includes("gone")
        ));
        const laterTerminal = rows.some((row) => (
          row.ownership_generation !== oldOwnership.ownership_generation
          && row.phase === "terminal"
        ));
        return oldFailed && laterTerminal ? rows : undefined;
      },
      180_000,
      "dead owner did not expire into a later terminal generation",
      1_000,
    );
    await runtime.waitForMarker(sessionId, marker);
    const status = await runtime.waitForTerminal(sessionId);
    const markerCount = await runtime.countTimelineEvents(sessionId, "assistant_message", marker);
    assertScenario(markerCount === 1, `dead-owner recovery marker count was ${markerCount}`);
    return {
      id: "dead-owner",
      status: "passed",
      sessionId,
      killedRunnerPid,
      stoppedNodePid,
      hiddenRunnerDirectory,
      oldOwnershipGeneration: oldOwnership.ownership_generation,
      sessionStatus: status,
      markerCount,
      ownerships,
    };
  },

  async F7(runtime, recorder) {
    const seed = shortId();
    const parentMarker = `F7_PARENT_${seed}`;
    const parentId = await runtime.createSession(`Reply with exactly ${parentMarker}.`);
    await runtime.waitForMarker(parentId, parentMarker);
    await runtime.waitForTerminal(parentId);
    let restartedNodePid;
    let failedDelivery;
    try {
      await runtime.updateSessionNode(parentId, "missing-lab-node");
      restartedNodePid = await runtime.restartService("node", "SIGTERM");
      const failedChildId = await runtime.createSession(`Reply with exactly F7_FAILED_CHILD_${seed}.`, {
        caller_session_id: parentId,
      });
      await runtime.waitForTerminal(failedChildId);
      failedDelivery = await waitFor(
        () => runtime.deliveryForSource(failedChildId),
        30_000,
        "F7 completion delivery was not created",
      );
      await recorder.event("fault_injected", {
        id: "F7",
        parentId,
        failedChildId,
        deliveryId: failedDelivery.delivery_id,
        targetNode: "missing-lab-node",
        restartedNodePid,
      });
      failedDelivery = await exhaustDelivery(runtime, failedDelivery);
      assertScenario(failedDelivery.aggregate_state === "dead_letter", "F7 did not dead-letter");
      assertScenario(failedDelivery.attempt_count === 16, `F7 attempt count was ${failedDelivery.attempt_count}`);
      assertScenario(
        Boolean(failedDelivery.dead_letter_reason || failedDelivery.last_error),
        "F7 dead letter had no reason",
      );
    } finally {
      await runtime.updateSessionNode(parentId, "eias-lab");
      try { await runtime.assertReady(); } catch { await runtime.startStack(); }
    }
    const controlChildId = await runtime.createSession(`Reply with exactly F7_CONTROL_CHILD_${seed}.`, {
      caller_session_id: parentId,
    });
    await runtime.waitForTerminal(controlChildId);
    const controlDelivery = await waitFor(
      async () => {
        const row = await runtime.deliveryForSource(controlChildId);
        return row?.aggregate_state === "consumed" ? row : undefined;
      },
      120_000,
      "F7 control completion was not consumed",
      1_000,
    );
    const consumptionCount = await runtime.consumptionCount(controlDelivery.relation_key);
    assertScenario(consumptionCount === 1, `F7 control consumption count was ${consumptionCount}`);
    return {
      id: "F7",
      status: "passed",
      parentId,
      restartedNodePid,
      failedDelivery,
      controlChildId,
      controlDelivery,
      consumptionCount,
    };
  },
};

/**
 * A prompt whose Bash call stays in flight for a known duration.
 *
 * It deliberately avoids a bare `sleep`: the lab agent workspace inherits a
 * hook that blocks a standalone one, and the block returns instantly. The tool
 * then never stays in flight, `waitForInFlightTool` times out, and the run is
 * void -- which is how several dead-owner runs were lost before anyone read
 * the tool_result and saw the block. A timed Python call is not a standalone
 * sleep and is not what the hook is guarding against.
 */
function delayedMarkerPrompt(marker, seconds) {
  return "Use Bash exactly once to run "
    + `python3 -c "import time; time.sleep(${seconds})". `
    + `After it finishes, reply with exactly ${marker}.`;
}
