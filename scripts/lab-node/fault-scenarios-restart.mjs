import { randomUUID } from "node:crypto";

import { buildInterventionPayload } from "./fault-harness-contract.mjs";
import { preserveDeadOwnership, waitForInFlightTool } from "./fault-harness-process.mjs";
import { waitFor } from "./fault-harness-runtime.mjs";

/**
 * Unattended ownership convergence.
 *
 * The existing scenarios all inject while a runner turn is in flight, and each
 * of them ends by delivering another message. That final message is what arms
 * every recovery path we have: expiry, lease sweeps, and dead-owner reclaim
 * are all reached from a reserve attempt.
 *
 * The four stale production ownership rows found on 260822 had no such
 * message. Two of them had been open since 08-19 on sessions that were already
 * `completed`. Nothing was ever going to contend for them, so nothing ever
 * reclaimed them. F13 keeps deliberately quiet after the injection so that
 * only an unattended sweep can make it pass.
 */
export const RESTART_SCENARIO_ORDER = ["F13"];

export const RESTART_LOG_TERMS = {
  F13: [
    "F13_",
    "expired an execution ownership",
    "reservation lease expired",
    "execution owner process",
    "stale execution ownership",
  ],
};

const MID_TURN_SLEEP_SECONDS = 300;

export const RESTART_SCENARIOS = {
  /**
   * An ownership nobody will contend for again must still converge.
   *
   * The runner and the host both die mid-turn, and then *nothing happens* — no
   * message, no resume attempt. Every recovery trigger in the reserve path is
   * therefore never armed. The row has to be reclaimed by a periodic sweep or
   * it stays open forever, which is exactly what the four stale production
   * rows were.
   */
  async F13(runtime, recorder) {
    const seed = shortId();
    const marker = `F13_RECOVERED_${seed}`;
    const sessionId = await runtime.createSession(
      `Use Bash exactly once to run sleep ${MID_TURN_SLEEP_SECONDS}. `
      + `After it finishes, reply with exactly F13_OLD_${seed}.`,
    );
    const runner = await runtime.waitForRunner(sessionId);
    await waitForInFlightTool(runtime, sessionId);
    const openOwnership = await waitFor(
      async () => (await runtime.ownerships(sessionId)).find(
        (row) => row.phase === "active" || row.phase === "identity_proven",
      ),
      60_000,
      "F13 never reached an open ownership",
    );
    let stoppedNodePid;
    try {
      stoppedNodePid = await preserveDeadOwnership(runtime, runner.pid);
      await runtime.startStack();
    } catch (error) {
      try { await runtime.startStack(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "F13 injection and lab restoration failed");
      }
      throw error;
    }
    await recorder.event("fault_injected", {
      id: "F13",
      sessionId,
      killedRunnerPid: runner.pid,
      stoppedNodePid,
      ownershipGeneration: openOwnership.ownership_generation,
      note: "no message is delivered; only an unattended sweep can reclaim this row",
    });

    // Deliberately quiet. Nothing here contends for the ownership.
    const converged = await settle(waitFor(
      async () => {
        const stuck = await stuckOwnerships(runtime, sessionId);
        return stuck.length === 0 ? true : undefined;
      },
      300_000,
      "F13 open ownership was never reclaimed by an unattended sweep",
      5_000,
    ));
    const ownershipsAfterSweep = await runtime.ownerships(sessionId);
    await recorder.event("unattended_sweep_outcome", {
      id: "F13",
      sessionId,
      converged: converged.status,
      ownerships: ownershipsAfterSweep,
    });
    assertScenario(
      converged.status === "fulfilled",
      `F13 ownership never converged without contention: ${converged.reason?.message}`,
    );

    // Only after proving the quiet path does the session have to accept work.
    const deliveryId = randomUUID();
    const interventionText = `Reply with exactly ${marker}.`;
    const messageLosses = [];
    let markerError;
    await runtime.intervene(sessionId, buildInterventionPayload(deliveryId, interventionText));
    try {
      await runtime.waitForMarker(sessionId, marker, 300_000);
    } catch (error) {
      markerError = serializeError(error);
      messageLosses.push({ sessionId, deliveryId, text: interventionText, detail: markerError.message });
    }
    await recorder.invariant("F13-message-delivery", messageLosses);
    assertScenario(!markerError, `F13 lost or stuck a message: ${markerError?.message}`);
    const status = await runtime.waitForTerminal(sessionId, 240_000);
    const markerCount = await runtime.countTimelineEvents(sessionId, "assistant_message", marker);
    assertScenario(markerCount === 1, `F13 recovery marker count was ${markerCount}`);
    return {
      id: "F13",
      status: "passed",
      sessionId,
      killedRunnerPid: runner.pid,
      stoppedNodePid,
      openOwnershipGeneration: openOwnership.ownership_generation,
      ownershipsAfterSweep,
      sessionStatus: status,
      markerCount,
    };
  },
};

/** Non-terminal ownership rows whose owner cannot possibly still be running. */
async function stuckOwnerships(runtime, sessionId) {
  const rows = await runtime.ownerships(sessionId);
  return rows.filter((row) => {
    if (["terminal", "failed", "retired"].includes(row.phase)) return false;
    if (row.pid === null || row.pid === undefined) return true;
    return !runtime.runnerAlive(Number(row.pid));
  });
}

function assertScenario(condition, message) {
  if (!condition) throw new Error(message);
}

async function settle(promise) {
  try { return { status: "fulfilled", value: await promise }; } catch (error) {
    return { status: "rejected", reason: serializeError(error) };
  }
}

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function shortId() {
  return randomUUID().slice(0, 8).toUpperCase();
}
