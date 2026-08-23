import { randomUUID } from "node:crypto";

import { buildInterventionPayload } from "./fault-harness-contract.mjs";
import { waitForInFlightTool } from "./fault-harness-process.mjs";
import { waitFor } from "./fault-harness-runtime.mjs";
import { assertScenario, settle, shortId } from "./fault-scenario-result.mjs";
import {
  buildTransparencyObservation,
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
    const baselineFailures = [
      ...validateGeneralObservation(general.observation),
      ...validateInterventionObservation(intervention.observation),
    ];
    steadyBaselines = {
      general: general.observation,
      intervention: intervention.observation,
    };
    return {
      id: "steady-state",
      status: baselineFailures.length === 0 ? "passed" : "failed",
      baselineFailures,
      general,
      intervention,
    };
  },

  async "restart-adopt"(runtime, recorder) {
    const baselines = await ensureSteadyBaselines(runtime, recorder);
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
    const differences = transparencyDifferences(baselines.general, observation);
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
      transparencyDifferences: differences,
      structuralFailures,
    };
  },

  async "restart-intervention-window"(runtime, recorder) {
    const baselines = await ensureSteadyBaselines(runtime, recorder);
    const spec = interventionSpec();
    const deliveryId = randomUUID();
    const sessionId = await runtime.createSession(spec.initialPrompt);
    const runnerBefore = await runtime.waitForRunner(sessionId);
    const inFlightTool = await waitForInFlightTool(runtime, sessionId);
    await activeOwnership(runtime, sessionId);
    await runtime.installAdoptionWindow(sessionId, ADOPTION_WINDOW_SECONDS);
    let restartPromise;
    let restartOutcome;
    let scenarioError;
    try {
      restartPromise = settle(runtime.restartService("node", "SIGTERM"));
      const observedWindow = await runtime.waitForAdoptionWindow(sessionId, 60_000);
      await recorder.event("adoption_window_observed", {
        sessionId,
        runnerPid: runnerBefore.pid,
        inFlightTool,
        observedWindow,
        deliveryId,
      });
      const callerOutcome = await settle(runtime.intervene(
        sessionId,
        buildInterventionPayload(deliveryId, spec.interventionText),
      ));
      restartOutcome = await restartPromise;
      await recorder.event("single_intervention_outcome", {
        sessionId,
        deliveryId,
        callerOutcome,
        restartOutcome,
        retryCount: 0,
      });
      const contextMarkerOutcome = await settle(
        runtime.waitForMarker(sessionId, spec.contextReply, 180_000),
      );
      const terminalStatus = await runtime.waitForTerminal(sessionId, 180_000);
      const timeline = await runtime.timeline(sessionId);
      const delivery = await runtime.deliveryById(deliveryId);
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
      const differences = transparencyDifferences(baselines.intervention, observation);
      return {
        id: "restart-intervention-window",
        status: differences.length === 0 ? "passed" : "failed",
        sessionId,
        deliveryId,
        runnerBefore,
        observedWindow,
        restartOutcome,
        callerOutcome,
        contextMarkerOutcome,
        delivery,
        retryCount: 0,
        observation,
        transparencyDifferences: differences,
      };
    } catch (error) {
      scenarioError = error;
      throw error;
    } finally {
      if (restartPromise && !restartOutcome) restartOutcome = await restartPromise;
      try {
        await runtime.removeAdoptionWindow();
      } catch (cleanupError) {
        if (scenarioError) {
          throw new AggregateError(
            [scenarioError, cleanupError],
            "restart-intervention-window injection and cleanup failed",
          );
        }
        throw cleanupError;
      }
    }
  },
});

async function ensureSteadyBaselines(runtime, recorder) {
  if (steadyBaselines) return steadyBaselines;
  const general = await runGeneralControl(runtime, recorder);
  const intervention = await runInterventionControl(runtime, recorder);
  const failures = [
    ...validateGeneralObservation(general.observation),
    ...validateInterventionObservation(intervention.observation),
  ];
  assertScenario(failures.length === 0, `steady control is red: ${failures.join("; ")}`);
  steadyBaselines = {
    general: general.observation,
    intervention: intervention.observation,
  };
  await recorder.event("implicit_steady_baseline_captured", { general, intervention });
  return steadyBaselines;
}

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
  const deliveryId = randomUUID();
  const sessionId = await runtime.createSession(spec.initialPrompt);
  await runtime.waitForRunner(sessionId);
  const inFlightTool = await waitForInFlightTool(runtime, sessionId);
  const callerOutcome = await settle(runtime.intervene(
    sessionId,
    buildInterventionPayload(deliveryId, spec.interventionText),
  ));
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
    deliveryId,
    inFlightTool,
    callerOutcome,
    observation,
  });
  return { sessionId, deliveryId, inFlightTool, callerOutcome, observation };
}

function validateGeneralObservation(observation) {
  return validateObservation(observation, {
    initialDemand: 1,
    interventionDemand: 0,
    toolStart: 1,
    toolResult: 1,
    toolResultError: 0,
    initialReply: 1,
    contextReply: 0,
  });
}

function validateInterventionObservation(observation) {
  const failures = validateObservation(observation, {
    initialDemand: 1,
    interventionDemand: 1,
    toolStart: 1,
    toolResult: 1,
    toolResultError: 0,
    initialReply: 0,
    contextReply: 1,
  });
  if (observation.callerOutcome?.status !== "fulfilled") {
    failures.push("intervention caller observed failure");
  }
  return failures;
}

function validateObservation(observation, expectedCounts) {
  const failures = [];
  if (observation.terminalStatus !== "completed") {
    failures.push(`terminal status was ${observation.terminalStatus}`);
  }
  for (const [name, expected] of Object.entries(expectedCounts)) {
    if (observation.counts[name] !== expected) {
      failures.push(`${name} count was ${observation.counts[name]}, expected ${expected}`);
    }
  }
  if (observation.visibleErrors.length > 0) {
    failures.push(`${observation.visibleErrors.length} user/agent-visible error signal(s)`);
  }
  return failures;
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
