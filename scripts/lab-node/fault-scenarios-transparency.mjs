import { randomUUID } from "node:crypto";

import { buildDurableDeliverySeed } from "./fault-harness-contract.mjs";
import { waitForInFlightTool } from "./fault-harness-process.mjs";
import { waitFor } from "./fault-harness-runtime.mjs";
import { settle, shortId } from "./fault-scenario-result.mjs";
import {
  buildTransparencyObservation,
  expectedTransparencyObservation,
  transparencyDifferences,
} from "./fault-transparency-oracle.mjs";

const TOOL_SECONDS = 90;
const ADOPTION_WINDOW_SECONDS = 20;
const GENERAL_CALLER_OUTCOME = Object.freeze({
  status: "fulfilled",
  value: Object.freeze({ accepted: true }),
});

let steadyBaselines;

export const TRANSPARENCY_LOG_TERMS = Object.freeze({
  "steady-state": ["STEADY_", "intervention", "delivery", "tool_result"],
  "restart-adopt": ["RESTART_ADOPT_", "adopt", "runner", "tool_result"],
  "restart-intervention-window": [
    "RESTART_WINDOW_",
    "intervention",
    "delivery",
    "adopt",
    "503",
  ],
});

export const TRANSPARENCY_SCENARIOS = Object.freeze({
  async "steady-state"(runtime, recorder) {
    const general = await runGeneralControl(runtime, recorder);
    const intervention = await runInterventionControl(runtime, recorder);
    const generalDifferences = transparencyDifferences(
      expectedTransparencyObservation("general"),
      general.observation,
    );
    const interventionDifferences = transparencyDifferences(
      expectedTransparencyObservation("intervention"),
      intervention.observation,
    );
    steadyBaselines = {
      general: general.observation,
      intervention: intervention.observation,
    };
    return {
      id: "steady-state",
      status: generalDifferences.length === 0 && interventionDifferences.length === 0
        ? "passed"
        : "failed",
      authoredContract: {
        general: expectedTransparencyObservation("general"),
        intervention: expectedTransparencyObservation("intervention"),
      },
      generalDifferences,
      interventionDifferences,
      general,
      intervention,
    };
  },

  async "restart-adopt"(runtime, recorder) {
    const seed = shortId();
    const initialMarker = `TRANSPARENT_GENERAL_DONE_${seed}`;
    const initialPrompt = delayedMarkerPrompt(initialMarker);
    const manifestBefore = await runtime.currentManifest();
    const sessionId = await runtime.createSession(initialPrompt);
    const runnerBefore = await runtime.waitForRunner(sessionId);
    const inFlightTool = await waitForInFlightTool(runtime, sessionId);
    const ownershipBefore = await activeOwnership(runtime, sessionId);
    await recorder.event("restart_adopt_precondition", {
      sessionId,
      runnerBefore,
      inFlightTool,
      ownershipBefore,
      manifestBefore,
    });
    const stoppedNodePid = await runtime.restartService("node", "SIGTERM");
    const adoptedOwnership = await waitFor(
      async () => (await runtime.ownerships(sessionId)).find((row) => (
        row.owner_kind === "adopted_runner"
        && row.pid === runnerBefore.pid
        && row.phase === "active"
      )),
      60_000,
      "same-release runner was not adopted after node restart",
      250,
    );
    const runnerAfter = await runtime.waitForRunner(sessionId);
    const manifestAfter = await runtime.currentManifest();
    await runtime.waitForMarker(sessionId, initialMarker, 180_000);
    const terminalStatus = await runtime.waitForTerminal(sessionId, 180_000);
    const timeline = await runtime.timeline(sessionId);
    const observation = buildTransparencyObservation({
      timeline,
      terminalStatus,
      initialPrompt,
      initialMarker,
      callerOutcome: GENERAL_CALLER_OUTCOME,
    });
    const differences = transparencyDifferences(
      expectedTransparencyObservation("general"),
      observation,
    );
    const steadyDifferences = steadyBaselines
      ? transparencyDifferences(steadyBaselines.general, observation)
      : null;
    const structuralFailures = [];
    if (runnerAfter.pid !== runnerBefore.pid) structuralFailures.push("runner pid changed");
    if (JSON.stringify(runnerAfter.config) !== JSON.stringify(runnerBefore.config)) {
      structuralFailures.push("runner config changed");
    }
    if (JSON.stringify(manifestAfter) !== JSON.stringify(manifestBefore)) {
      structuralFailures.push("release manifest changed");
    }
    return {
      id: "restart-adopt",
      status: differences.length === 0 && structuralFailures.length === 0 ? "passed" : "failed",
      sessionId,
      stoppedNodePid,
      runnerBefore,
      runnerAfter,
      ownershipBefore,
      adoptedOwnership,
      manifestBefore,
      manifestAfter,
      observation,
      authoredContract: expectedTransparencyObservation("general"),
      contractDifferences: differences,
      steadyObservationDifferences: steadyDifferences,
      structuralFailures,
    };
  },

  async "restart-intervention-window"(runtime, recorder) {
    const spec = interventionSpec();
    const sessionId = await runtime.createSession(spec.initialPrompt);
    const runnerBefore = await runtime.waitForRunner(sessionId);
    const inFlightTool = await waitForInFlightTool(runtime, sessionId);
    await activeOwnership(runtime, sessionId);
    const delivery = await prepareDurableIntervention(runtime, sessionId, spec.interventionText);
    await runtime.installAdoptionWindow(sessionId, ADOPTION_WINDOW_SECONDS);
    await runtime.deliveries.installQueuedCasFault(delivery.deliveryId);
    let restartPromise;
    let restartOutcome;
    let scenarioError;
    let scenarioResult;
    let deliveryCleanup;
    try {
      restartPromise = settle(runtime.restartService("node", "SIGTERM"));
      const observedWindow = await runtime.waitForAdoptionWindow(sessionId, 60_000);
      await recorder.event("adoption_window_observed", {
        sessionId,
        runnerPid: runnerBefore.pid,
        inFlightTool,
        observedWindow,
        deliveryId: delivery.deliveryId,
      });
      const callerOutcome = await settle(runtime.intervene(
        sessionId,
        delivery.intervention,
      ));
      restartOutcome = await restartPromise;
      await recorder.event("single_intervention_outcome", {
        sessionId,
        deliveryId: delivery.deliveryId,
        callerOutcome,
        restartOutcome,
        retryCount: 0,
      });
      const [contextMarkerOutcome, deliveryConsumptionOutcome] = await Promise.all([
        settle(runtime.waitForMarker(sessionId, spec.contextReply, 180_000)),
        settle(waitFor(
          async () => {
            const row = await runtime.deliveries.byId(delivery.deliveryId);
            return row?.aggregate_state === "consumed" ? row : undefined;
          },
          180_000,
          "recovery-window delivery was not consumed",
          500,
        )),
      ]);
      const terminalStatus = await runtime.waitForTerminal(sessionId, 180_000);
      const timeline = await runtime.timeline(sessionId);
      const deliveryRow = await runtime.deliveries.byId(delivery.deliveryId);
      const observation = buildTransparencyObservation({
        timeline,
        terminalStatus,
        initialPrompt: spec.initialPrompt,
        interventionText: spec.interventionText,
        initialMarker: spec.initialMarker,
        contextMarker: spec.contextMarker,
        contextToken: spec.contextToken,
        callerOutcome,
      });
      const differences = transparencyDifferences(
        expectedTransparencyObservation("intervention"),
        observation,
      );
      const steadyDifferences = steadyBaselines
        ? transparencyDifferences(steadyBaselines.intervention, observation)
        : null;
      scenarioResult = {
        id: "restart-intervention-window",
        status: differences.length === 0 ? "passed" : "failed",
        sessionId,
        deliveryId: delivery.deliveryId,
        runnerBefore,
        observedWindow,
        restartOutcome,
        callerOutcome,
        contextMarkerOutcome,
        deliveryConsumptionOutcome,
        delivery: deliveryRow,
        retryCount: 0,
        observation,
        authoredContract: expectedTransparencyObservation("intervention"),
        contractDifferences: differences,
        steadyObservationDifferences: steadyDifferences,
      };
    } catch (error) {
      scenarioError = error;
      throw error;
    } finally {
      if (restartPromise && !restartOutcome) restartOutcome = await restartPromise;
      const cleanupErrors = [];
      try {
        await runtime.deliveries.removeQueuedCasFault();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await runtime.removeAdoptionWindow();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        deliveryCleanup = await runtime.deliveries.removeSeed(delivery.deliveryId);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (scenarioError || cleanupErrors.length > 0) {
        throw new AggregateError(
          [...(scenarioError ? [scenarioError] : []), ...cleanupErrors],
          "restart-intervention-window injection and cleanup failed",
        );
      }
    }
    scenarioResult.cleanup = { delivery: deliveryCleanup };
    return scenarioResult;
  },
});

async function runGeneralControl(runtime, recorder) {
  const seed = shortId();
  const initialMarker = `TRANSPARENT_GENERAL_DONE_${seed}`;
  const initialPrompt = delayedMarkerPrompt(initialMarker);
  const sessionId = await runtime.createSession(initialPrompt);
  await runtime.waitForRunner(sessionId);
  const inFlightTool = await waitForInFlightTool(runtime, sessionId);
  await runtime.waitForMarker(sessionId, initialMarker, 180_000);
  const terminalStatus = await runtime.waitForTerminal(sessionId, 180_000);
  const timeline = await runtime.timeline(sessionId);
  const observation = buildTransparencyObservation({
    timeline,
    terminalStatus,
    initialPrompt,
    initialMarker,
    callerOutcome: GENERAL_CALLER_OUTCOME,
  });
  await recorder.event("steady_general_observation", { sessionId, inFlightTool, observation });
  return { sessionId, inFlightTool, observation };
}

async function runInterventionControl(runtime, recorder) {
  const spec = interventionSpec();
  const sessionId = await runtime.createSession(spec.initialPrompt);
  await runtime.waitForRunner(sessionId);
  const inFlightTool = await waitForInFlightTool(runtime, sessionId);
  const delivery = await prepareDurableIntervention(runtime, sessionId, spec.interventionText);
  const callerOutcome = await settle(runtime.intervene(
    sessionId,
    delivery.intervention,
  ));
  await runtime.waitForMarker(sessionId, spec.initialMarker, 180_000);
  await runtime.waitForMarker(sessionId, spec.contextReply, 180_000);
  const terminalStatus = await runtime.waitForTerminal(sessionId, 180_000);
  const timeline = await runtime.timeline(sessionId);
  const observation = buildTransparencyObservation({
    timeline,
    terminalStatus,
    initialPrompt: spec.initialPrompt,
    interventionText: spec.interventionText,
    initialMarker: spec.initialMarker,
    contextMarker: spec.contextMarker,
    contextToken: spec.contextToken,
    callerOutcome,
  });
  await recorder.event("steady_intervention_observation", {
    sessionId,
    deliveryId: delivery.deliveryId,
    inFlightTool,
    callerOutcome,
    observation,
  });
  return {
    sessionId,
    deliveryId: delivery.deliveryId,
    inFlightTool,
    callerOutcome,
    delivery: await runtime.deliveries.byId(delivery.deliveryId),
    observation,
  };
}

async function prepareDurableIntervention(runtime, sessionId, text) {
  const seed = shortId();
  const leaseOwner = `lab-transparent-${seed}`;
  const delivery = buildDurableDeliverySeed(randomUUID(), sessionId, text, leaseOwner);
  await runtime.deliveries.seed(delivery, { state: "claimed", leaseOwner });
  return delivery;
}

async function activeOwnership(runtime, sessionId) {
  return await waitFor(
    async () => (await runtime.ownerships(sessionId)).find((row) => row.phase === "active"),
    30_000,
    `session never reached active ownership: ${sessionId}`,
    250,
  );
}

function interventionSpec() {
  const seed = shortId();
  const contextToken = `TRANSPARENT_CONTEXT_${seed}`;
  const initialMarker = `TRANSPARENT_INITIAL_${seed}`;
  const contextMarker = `TRANSPARENT_FOLLOWUP_${seed}`;
  const contextReply = `${contextMarker}:${contextToken}`;
  const initialPrompt = `Remember the context token ${contextToken}. `
    + delayedMarkerPrompt(initialMarker);
  const interventionText = "Without asking me to resend anything, use the context token from "
    + `the first message and reply with exactly ${contextReply}.`;
  return {
    contextToken,
    initialMarker,
    contextMarker,
    contextReply,
    initialPrompt,
    interventionText,
  };
}

function delayedMarkerPrompt(marker) {
  return "Use Bash exactly once to run "
    + `python3 -c \"import time; time.sleep(${TOOL_SECONDS})\". `
    + `After it finishes, reply with exactly ${marker}.`;
}
