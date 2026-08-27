import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  autoResumeHandoffViolations,
  buildInterventionPayload,
  inPostTurnAutoResumeHandoffWindow,
  restartWindowContinuityViolations,
  restartWindowDurableViolations,
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
import {
  ACTIVATE_ROLLBACK_RETRY_BUDGET,
  activateRollbackMutationDetection,
  activateRollbackViolations,
  observeActivationFailureOutcome,
  observeRaiseRemovedMutationViolation,
  requestedActivateRollbackMutation,
} from "./fault-activate-rollback.mjs";
import {
  DELIVERY_LOG_TERMS,
  DELIVERY_SCENARIOS,
} from "./fault-scenarios-delivery.mjs";
import {
  TRANSPARENCY_LOG_TERMS,
  TRANSPARENCY_SCENARIOS,
} from "./fault-scenarios-transparency.mjs";

const SCENARIO_ORDER = [
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
];
const LOG_TERMS = {
  ...TRANSPARENCY_LOG_TERMS,
  ...DELIVERY_LOG_TERMS,
  F1: ["F1_", "runner", "shutdown"],
  F11: ["F11_", "intervention", "delivery"],
  "auto-resume-handoff": ["completion_notification", "auto_resume",
    "registered runner recovery skipped", "activeRunnerOperations", "connect ENOENT",
    "runner.sock"],
  "restart-window-durable": ["RESTART_WINDOW_DURABLE_", "NODE_UNAVAILABLE", "intervention"],
  F9: ["F9_", "runner adoption release identity mismatch", "release_superseded", "offline",
    "runner adoption failure was superseded by a newer execution",
    "registered runner recovery skipped", "terminal runner replay was skipped",
    "Durable event stream already registered", "Runner IPC reconnect budget exhausted"],
  "dead-owner": ["DEAD_OWNER_", "dead execution owner", "expire_dead_owner"],
  "runner-death-live-host": [
    "RUNNER_DEATH_LIVE_HOST_",
    "activeRunnerOperations",
    "expire_dead_owner",
  ],
  "activate-rollback": [
    "ACTIVATE_ROLLBACK_",
    "lab injected sessions-row execution acquire failure",
    "spawned runner rollback failed",
    "execution acquire",
  ],
  F7: ["F7_", "dead_letter", "completion_notification", "delivery"],
};
// The isolated lab fixes the recovery scan at 15 seconds. One full scan plus
// scheduling slack proves the non-transactional counter did not advance again.
const ACTIVATE_ROLLBACK_RETRY_HORIZON_MS = 17_000;

async function observePredicateMisplacedLifecycle({
  runtime,
  recorder,
  sessionId,
  followupRegistration,
  baselineAdmission,
  expectedGeneration,
  faultObservationOffset,
}) {
  await runtime.waitForTerminal(sessionId, 30_000);
  await runtime.waitForTerminalRunnerRetirementSince(
    sessionId,
    faultObservationOffset,
    followupRegistration.registrationId,
    followupRegistration.identityPid,
  );
  const evidence = await runtime.executionAcquireApplicationEvidence({
    sessionId,
    expectedGeneration,
    registrationId: followupRegistration.registrationId,
    pid: followupRegistration.identityPid,
  });
  assertScenario(
    evidence?.classification !== "conflict",
    `harness evidence conflict: ${evidence?.conflict ?? "unknown"}`,
  );
  assertScenario(
    evidence?.classification === "applied" || evidence?.classification === "no_transition",
    "harness evidence conflict: invalid acquire classification",
  );
  const event = evidence.event;
  const application = evidence.application;
  if (event !== null) {
    assertScenario(
      event.sessionId === sessionId
        && event.phase === "execution_acquire"
        && Number.isSafeInteger(event.eventId)
        && event.eventId > 0,
      "central acquire evidence identity mismatch",
    );
  }
  if (evidence.classification === "applied") {
    assertScenario(
      application?.applied === true
        && application.sessionId === sessionId
        && application.ownershipGeneration === expectedGeneration
        && application.registrationId === followupRegistration.registrationId
        && application.pid === followupRegistration.identityPid
        && typeof application.executionCommandId === "string"
        && event?.transitionId === `acquire:${application.executionCommandId}`,
      "central acquire evidence identity mismatch",
    );
  } else if (event !== null || application !== null) {
    assertScenario(
      event !== null
        && application?.applied === false
        && application.sessionId === sessionId
        && typeof application.executionCommandId === "string"
        && event.transitionId === `acquire:${application.executionCommandId}`,
      "central acquire evidence identity mismatch",
    );
  }

  let acquireTransition = null;
  if (evidence.classification === "applied") {
    acquireTransition = await runtime.waitForExecutionOwnershipTransitionSince(
      sessionId,
      faultObservationOffset,
      "acquire",
    );
    assertScenario(
      acquireTransition.sessionId === sessionId
        && acquireTransition.operation === "acquire"
        && acquireTransition.applied === true
        && acquireTransition.ownershipGeneration === expectedGeneration,
      "activate rollback did not observe the exact follow-up execution acquire",
    );
  }
  const counter = await runtime.activationFailureFaultCount();
  let releaseTransition = null;
  if (evidence.classification === "applied") {
    releaseTransition = await runtime.waitForExecutionOwnershipTransitionSince(
      sessionId,
      faultObservationOffset,
      "release",
    );
    assertScenario(
      releaseTransition.sessionId === sessionId
        && releaseTransition.operation === "release"
        && releaseTransition.applied === true
        && releaseTransition.ownershipGeneration === expectedGeneration,
      "activate rollback did not observe the exact follow-up execution release",
    );
  }
  const commandId = application?.executionCommandId ?? null;
  const attemptedCommandFingerprint = typeof commandId === "string"
    ? await runtime.executionCommandFingerprint(commandId)
    : null;
  const mutationObservation = counter.semanticReachCount !== 0
    ? null
    : evidence.classification === "applied"
      ? {
          sentinel: "fault_predicate_missed_applied_acquire",
          observationPoint: "after_durable_followup_lifecycle",
          acquireEvidence: {
            source: "central_event_receipt_join",
            eventId: event.eventId,
            sessionId,
            ownershipGeneration: application.ownershipGeneration,
            registrationId: application.registrationId,
            pid: application.pid,
            executionCommandId: application.executionCommandId,
          },
          semanticReachCount: 0,
        }
      : {
          sentinel: "sessions_row_acquire_transition_not_reached",
          observationPoint: "after_durable_followup_lifecycle",
          semanticReachCount: 0,
        };
  const reach = {
    semanticReachCount: counter.semanticReachCount,
    semanticReachCountBeforeHorizon: counter.semanticReachCount,
    attemptedGeneration: evidence.classification === "applied" ? expectedGeneration : null,
    attemptedCommandFingerprint,
    retryHorizonMs: 0,
    stable: true,
  };
  const followupAdmissionDistinct = followupRegistration.registrationId
      !== baselineAdmission.registrationId
    && (evidence.classification !== "applied"
      || application.ownershipGeneration === expectedGeneration)
    && commandId !== baselineAdmission.executionCommandId;
  await recorder.event("fault_reached", {
    id: "activate-rollback",
    sessionId,
    runnerPid: followupRegistration.identityPid,
    mutation: "predicate_misplaced",
    semanticReachCount: reach.semanticReachCount,
    attemptedGeneration: reach.attemptedGeneration,
    attemptedCommandFingerprint: reach.attemptedCommandFingerprint,
    followupRegistration,
    baselineAdmission,
    mutationObservation,
    evidenceClassification: evidence.classification,
    acquireTransition,
    releaseTransition,
  });
  return {
    reach,
    mutationObservation,
    followupAdmissionDistinct,
    evidence,
  };
}

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
    const replacementTerms = [
      "runner adoption release identity mismatch",
      "release_superseded",
      "runner adoption failure was superseded by a newer execution",
    ];
    const mismatchCount = logs.node.filter((line) => replacementTerms.some(
      (term) => line.includes(term),
    )).length;
    result.mismatchLogCount = mismatchCount;
    if (!failure) {
      try {
        const violations = restartWindowContinuityViolations({
          ...result.continuityObservation,
          replacementLogCount: mismatchCount,
        });
        assertScenario(violations.length === 0, `F9 continuity failed: ${violations.join("; ")}`);
      } catch (error) {
        failure = serializeError(error);
        result = { ...result, status: "failed", failure };
      }
    }
  }
  if (id === "restart-window-durable") {
    const replacementTerms = [
      "runner adoption release identity mismatch",
      "release_superseded",
      "runner adoption failure was superseded by a newer execution",
    ];
    const replacementCount = logs.node.filter((line) => replacementTerms.some(
      (term) => line.includes(term),
    )).length;
    result.replacementLogCount = replacementCount;
    if (!failure) {
      try {
        const violations = restartWindowDurableViolations({
          ...result.observation,
          replacementLogCount: replacementCount,
        });
        assertScenario(
          violations.length === 0,
          `restart-window durable delivery failed: ${violations.join("; ")}`,
        );
      } catch (error) {
        failure = serializeError(error);
        result = { ...result, status: "failed", failure };
      }
    }
  }
  if (id === "auto-resume-handoff") {
    const inWindowAttempts = result.attempts?.filter(
      (attempt) => attempt.observation.inTimingWindow,
    ) ?? [];
    const inWindowSessionIds = inWindowAttempts.map((attempt) => attempt.parentId);
    const inWindowNodeLogs = logs.node.filter((line) => (
      inWindowSessionIds.some((sessionId) => line.includes(sessionId))
    ));
    const blockedCount = inWindowNodeLogs.filter((line) => (
      line.includes("registered runner recovery skipped")
      && line.includes("execution_promise")
    )).length;
    const replacementCount = inWindowNodeLogs.filter((line) => (
      line.includes("release_superseded")
      || line.includes("runner adoption failure was superseded by a newer execution")
    )).length;
    const socketErrorCount = inWindowNodeLogs.filter((line) => (
      line.includes("connect ENOENT") && line.includes("runner.sock")
    )).length;
    result.executionPromiseBlockedCount = blockedCount;
    result.replacementLogCount = replacementCount;
    result.socketErrorCount = socketErrorCount;
    if (!failure && inWindowAttempts.length === 0) {
      result = {
        ...result,
        status: "inconclusive_timing_window",
        reason: "no attempt entered the (0,+1000ms] post-turn runner handoff window",
      };
    } else if (!failure) {
      try {
        const violations = autoResumeHandoffViolations({
          attempts: inWindowAttempts.map((attempt) => attempt.observation),
          executionPromiseBlockedCount: blockedCount,
          replacementLogCount: replacementCount,
          socketErrorCount,
        });
        assertScenario(violations.length === 0, `auto-resume handoff failed: ${violations.join("; ")}`);
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
  ...TRANSPARENCY_SCENARIOS,
  ...DELIVERY_SCENARIOS,

  async "auto-resume-handoff"(runtime, recorder) {
    const attempts = [];
    const childSleepSecondsByAttempt = [8.3, 8.5, 8.7, 8.9];
    for (const [index, childSleepSeconds] of childSleepSecondsByAttempt.entries()) {
      const attempt = index + 1;
      const parentId = await runtime.createSession(
        "Use Bash exactly once to run python3 -c \"import time; time.sleep(12)\". "
        + "After it finishes, briefly state that the command completed.",
      );
      const oldRunner = await runtime.waitForRunner(parentId);
      await waitForInFlightTool(runtime, parentId);
      const childId = await runtime.createSession(
        `Use Bash exactly once to run python3 -c \"import time; time.sleep(${childSleepSeconds})\". `
        + "After it finishes, report the result of two plus two in one sentence.",
        { caller_session_id: parentId },
      );
      const childTerminalStatus = await runtime.waitForTerminal(childId);
      const childTerminalAt = await runtime.sessionEndedAt(childId);
      const delivery = await waitForConsumedDelivery(
        runtime,
        childId,
        `auto-resume handoff attempt ${attempt}`,
      );
      const parentTerminalStatus = await runtime.waitForTerminal(parentId);
      const timeline = await runtime.timeline(parentId);
      const turnBoundaries = await runtime.turnResults(parentId);
      const parentFirstTurnEndedAt = turnBoundaries[0]?.created_at ?? null;
      const handoffDeltaMs = timestampDeltaMs(childTerminalAt, parentFirstTurnEndedAt);
      const ownerships = await runtime.ownerships(parentId);
      const observedPids = [...new Set(ownerships.map((row) => row.pid).filter(Boolean))];
      const consumptionCount = await runtime.consumptionCount(delivery.relation_key);
      const messages = timeline.messages ?? [];
      const observation = {
        attemptNumber: attempt,
        deliveryReceiptCount: messages.filter((message) => (
          message.event_type === "session_notification"
          && message.payload?.delivery_id === delivery.delivery_id
        )).length,
        consumptionCount,
        userMessageCount: messages.filter((message) => message.event_type === "user_message").length,
        turnBoundaryCount: turnBoundaries.length,
        successfulTurnBoundaryCount: turnBoundaries.filter(
          (message) => message.payload?.success === true,
        ).length,
        childTerminalStatus,
        parentTerminalStatus,
        childSleepSeconds,
        childTerminalAt,
        parentFirstTurnEndedAt,
        handoffDeltaMs,
        inTimingWindow: inPostTurnAutoResumeHandoffWindow(handoffDeltaMs),
        oldPid: oldRunner.pid,
        observedPids,
      };
      attempts.push({ parentId, childId, oldRunner, observedPids, delivery, ownerships, observation });
      await recorder.event("auto_resume_handoff_observed", { attempt, ...attempts.at(-1) });
    }
    return { id: "auto-resume-handoff", status: "passed", attempts };
  },

  async "restart-window-durable"(runtime, recorder) {
    const seed = shortId();
    const marker = `RESTART_WINDOW_DURABLE_${seed}`;
    const sessionId = await runtime.createSession(delayedMarkerPrompt(`RESTART_WINDOW_BASE_${seed}`, 30));
    const oldRunner = await runtime.waitForRunner(sessionId);
    await waitForInFlightTool(runtime, sessionId);
    const deliveryId = randomUUID();
    const payload = buildInterventionPayload(deliveryId, `Reply with exactly ${marker}.`);
    await runtime.stopNodeForReleaseSwap();
    let callerOutcome;
    try {
      callerOutcome = await settle(runtime.intervene(sessionId, payload));
    } finally {
      await runtime.startStack();
    }
    const newRunnerOutcome = await settle(runtime.waitForRunner(sessionId, 60_000));
    const [markerOutcome, deliveryOutcome] = await Promise.all([
      settle(runtime.waitForMarker(sessionId, marker, 90_000)),
      settle(waitFor(
        async () => {
          const row = await runtime.deliveryById(deliveryId);
          return row?.aggregate_state === "consumed" ? row : undefined;
        },
        90_000,
        "restart-window intervention delivery did not reach consumed",
        1_000,
      )),
    ]);
    const terminalOutcome = await settle(runtime.waitForTerminal(sessionId, 30_000));
    const acceptance = callerOutcome.status === "fulfilled"
      ? callerOutcome.value
      : callerOutcome;
    const newRunner = newRunnerOutcome.status === "fulfilled"
      ? newRunnerOutcome.value
      : undefined;
    const delivery = await runtime.deliveryById(deliveryId);
    const deliveryCount = await runtime.deliveryCountById(deliveryId);
    const interventionCount = await runtime.countTimelineEvents(
      sessionId,
      "intervention_sent",
      payload.text,
    );
    const assistantCount = await runtime.countTimelineEvents(
      sessionId,
      "assistant_message",
      marker,
    );
    const inboxRemainingCount = runtime.runnerInterventionInboxCount(sessionId);
    const ownerships = await runtime.ownerships(sessionId);
    const inFlightOwnerships = ownerships.filter((row) => (
      row.phase === "reserved" || row.phase === "identity_proven" || row.phase === "active"
    ));
    const sessionStatus = await runtime.sessionStatus(sessionId);
    const observation = {
      acceptance,
      delivery,
      deliveryCount,
      interventionCount,
      assistantCount,
      inboxRemainingCount,
      inFlightCount: inFlightOwnerships.length,
      sessionStatus,
      oldPid: oldRunner.pid,
      newPid: newRunner?.pid,
      oldReleaseManifestId: oldRunner.config.releaseManifestId,
      newReleaseManifestId: newRunner?.config.releaseManifestId,
      replacementLogCount: 0,
    };
    await recorder.event("restart_window_durable_attempted", {
      sessionId,
      deliveryId,
      callerOutcome,
      markerOutcome,
      deliveryOutcome,
      terminalOutcome,
      observation,
    });
    return {
      id: "restart-window-durable",
      status: "passed",
      sessionId,
      deliveryId,
      callerOutcome,
      newRunnerOutcome,
      markerOutcome,
      deliveryOutcome,
      terminalOutcome,
      ownerships,
      observation,
    };
  },
  async "runner-death-live-host"(runtime, recorder) {
    const seed = shortId();
    const oldMarker = `RUNNER_DEATH_LIVE_HOST_OLD_${seed}`;
    const nextMarker = `RUNNER_DEATH_LIVE_HOST_RECOVERED_${seed}`;
    const sessionId = await runtime.createSession(delayedMarkerPrompt(oldMarker, 90));
    const runner = await runtime.waitForRunner(sessionId);
    await waitForInFlightTool(runtime, sessionId);
    const oldOwnership = await waitFor(
      async () => (await runtime.ownerships(sessionId)).find((row) => row.phase === "active"),
      30_000,
      "runner-death-live-host never reached active ownership",
    );
    const runnerDirectory = runtime.runnerDirectory(sessionId);
    let hiddenRunnerDirectory;
    let scenarioError;
    try {
      const activeObservationOffset = await runtime.nodeLogOffset();
      const activeOperationSnapshot = await runtime.waitForRunnerOperationStateSince(
        sessionId,
        activeObservationOffset,
        true,
      );
      const settlementObservationOffset = await runtime.nodeLogOffset();
      await recorder.event("fault_injected", {
        id: "runner-death-live-host",
        sessionId,
        runnerPid: runner.pid,
        signal: "SIGTERM",
        ownershipGeneration: oldOwnership.ownership_generation,
        nodeRestarted: false,
        reserveAttemptedBeforeSettlement: false,
        interventionAttemptedBeforeSettlement: false,
        activeOperationSnapshot,
      });
      await runtime.killRunnerPid(runner.pid, "SIGTERM");
      await waitFor(
        () => runtime.runnerAlive(runner.pid) ? undefined : true,
        60_000,
        "SIGTERM did not terminate the in-flight runner",
        250,
      );
      hiddenRunnerDirectory = join(
        runtime.runnerStateDirectory,
        `_fault-runner-death-live-host-${basename(runnerDirectory)}-${seed}`,
      );
      await rename(runnerDirectory, hiddenRunnerDirectory);
      const settledOperationSnapshot = await runtime.waitForRunnerOperationStateSince(
        sessionId,
        settlementObservationOffset,
        false,
      );
      const terminalBeforeResume = await runtime.waitForTerminal(sessionId, 60_000);
      const settledOwnerships = await runtime.ownerships(sessionId);
      await runtime.intervene(
        sessionId,
        buildInterventionPayload(randomUUID(), `Reply with exactly ${nextMarker}.`),
      );
      const replacement = await runtime.waitForRunner(sessionId, 60_000);
      await runtime.waitForMarker(sessionId, nextMarker, 120_000);
      const status = await runtime.waitForTerminal(sessionId);
      const markerCount = await runtime.countTimelineEvents(
        sessionId,
        "assistant_message",
        nextMarker,
      );
      assertScenario(markerCount === 1, `runner death recovery marker count was ${markerCount}`);
      assertScenario(replacement.pid !== runner.pid, "runner death reused the killed runner pid");
      return {
        id: "runner-death-live-host",
        status: "passed",
        sessionId,
        killedRunnerPid: runner.pid,
        replacementRunnerPid: replacement.pid,
        oldOwnershipGeneration: oldOwnership.ownership_generation,
        settledOwnerships,
        terminalBeforeResume,
        activeOperationSnapshot,
        settledOperationSnapshot,
        sessionStatus: status,
        markerCount,
        nodeRestarted: false,
        reserveAttemptedBeforeSettlement: false,
        interventionAttemptedBeforeSettlement: false,
      };
    } catch (error) {
      scenarioError = error;
      throw error;
    } finally {
      if (hiddenRunnerDirectory) {
        try {
          await runtime.removeFaultRunnerDirectory(hiddenRunnerDirectory);
        } catch (cleanupError) {
          if (scenarioError) {
            throw new AggregateError(
              [scenarioError, cleanupError],
              "runner-death-live-host injection and cleanup failed",
            );
          }
          throw cleanupError;
        }
      }
    }
  },

  async "activate-rollback"(runtime, recorder) {
    const seed = shortId();
    const baselineMarker = `ACTIVATE_ROLLBACK_BASELINE_${seed}`;
    const rejectedMarker = `ACTIVATE_ROLLBACK_SHOULD_NOT_RUN_${seed}`;
    const mutation = requestedActivateRollbackMutation();
    let runner;
    let scenarioError;
    let scenarioResult;
    let cleanupResidue;
    let cleanupFailure;
    let postCleanupRegistration;
    let postCleanupOwnership;
    const baselineAdmissionOffset = await runtime.nodeLogOffset();
    const sessionId = await runtime.createSession(`Reply with exactly ${baselineMarker}.`);
    const baselineRunner = await runtime.waitForRunner(sessionId);
    const baselineAcquire = await runtime.waitForExecutionOwnershipTransitionSince(
      sessionId,
      baselineAdmissionOffset,
      "acquire",
    );
    const baselineOwnership = await waitFor(
      async () => {
        const snapshot = await runtime.sessionExecutionOwnership(sessionId);
        return snapshot?.owner !== null ? snapshot : undefined;
      },
      30_000,
      "activate-rollback baseline never acquired sessions-row execution ownership",
      100,
    );
    assertScenario(
      baselineOwnership.owner.pid === baselineRunner.pid,
      "activate-rollback baseline runner did not match sessions-row owner",
    );
    const baselineCommandFingerprint = await runtime.executionCommandFingerprint(
      baselineOwnership.owner.executionCommandId,
    );
    const baselineDrainOffset = await runtime.nodeLogOffset();
    await runtime.waitForMarker(sessionId, baselineMarker);
    await runtime.waitForTerminal(sessionId);
    const before = await waitFor(
      async () => {
        const snapshot = await runtime.sessionExecutionOwnership(sessionId);
        return snapshot?.status === "completed"
          && snapshot.owner === null
          && Number.isSafeInteger(snapshot.executionGeneration)
          && Number.isSafeInteger(snapshot.terminalRevision)
          ? snapshot
          : undefined;
      },
      30_000,
      "activate-rollback baseline did not settle with an ownerless terminal revision",
      250,
    );
    const baselineRelease = await runtime.waitForExecutionOwnershipTransitionSince(
      sessionId,
      baselineDrainOffset,
      "release",
    );
    assertScenario(
      baselineAcquire.ownershipGeneration === baselineOwnership.executionGeneration
        && baselineRelease.ownershipGeneration === baselineOwnership.executionGeneration,
      "activate-rollback baseline acquire/release generation did not match sessions-row ownership",
    );
    const baselineRetirement = await runtime.waitForTerminalRunnerRetirementSince(
      sessionId,
      baselineDrainOffset,
      baselineOwnership.owner.registrationId,
      baselineRunner.pid,
    );
    const baselineAdmission = {
      pid: baselineRunner.pid,
      executionGeneration: baselineOwnership.executionGeneration,
      registrationId: baselineOwnership.owner.registrationId,
      executionCommandId: baselineOwnership.owner.executionCommandId,
      commandFingerprint: baselineCommandFingerprint,
      acquiredAt: baselineAcquire.time,
      releasedAt: baselineRelease.time,
      retiredAt: baselineRetirement.retirement.time,
      retiredRegistration: baselineRetirement.registration,
    };
    await recorder.event("baseline_admission_drained", {
      id: "activate-rollback",
      sessionId,
      baselineAdmission,
    });
    await runtime.installActivationFailureFault(8, mutation);
    try {
      const faultObservationOffset = await runtime.nodeLogOffset();
      const deliveryId = randomUUID();
      const interventionOutcomePromise = settle(runtime.intervene(
        sessionId,
        buildInterventionPayload(
          deliveryId,
          `Reply with exactly ${rejectedMarker}.`,
        ),
      ));
      const followupRegistrationPromise = settle(
        runtime.waitForDistinctRunnerRegistration(
          sessionId,
          baselineAdmission.registrationId,
        ),
      );
      const predicateMutation = mutation === "predicate_misplaced";
      const initialReach = predicateMutation
        ? null
        : await runtime.waitForActivationFailureFault(30_000);
      const followupRegistrationOutcome = await followupRegistrationPromise;
      assertScenario(
        followupRegistrationOutcome.status === "fulfilled",
        `activate rollback did not observe a distinct follow-up runner: `
          + `${followupRegistrationOutcome.reason?.message ?? "unknown"}`,
      );
      const followupRegistration = followupRegistrationOutcome.value;
      runner = { pid: followupRegistration.identityPid };
      const faultEnvelopeSourceSeq = predicateMutation
        ? null
        : await runtime.executionAcquireEnvelopeSourceSeq(
          sessionId,
          followupRegistration.registrationId,
          followupRegistration.identityPid,
        );
      if (!predicateMutation) {
        await recorder.event("fault_reached", {
          id: "activate-rollback",
          sessionId,
          runnerPid: runner.pid,
          mutation,
          semanticReachCount: initialReach.semanticReachCount,
          attemptedGeneration: initialReach.attemptedGeneration,
          attemptedCommandFingerprint: initialReach.attemptedCommandFingerprint,
          followupRegistration,
          baselineAdmission,
          mutationObservation: null,
        });
      }
      const deadLetterPromise = mutation === "raise_removed" || predicateMutation
        ? Promise.resolve({ status: "not_expected", value: null })
        : settle(runtime.waitForEventIngressDeadLetterSince(
          sessionId,
          faultEnvelopeSourceSeq,
          faultObservationOffset,
        ));
      const followupInventoryPromise = runtime.observeDistinctRunnerRegistrationInventoryUntil(
        sessionId,
        baselineAdmission.registrationId,
        mutation === "raise_removed" || predicateMutation
          ? interventionOutcomePromise
          : deadLetterPromise,
        [followupRegistration],
      );
      const interventionOutcome = await interventionOutcomePromise;
      let mutationObservation = null;
      let followupAdmissionDistinct;
      let reach;
      let followupInventory;
      let deadLetterOutcome;
      if (predicateMutation) {
        const predicateLifecycle = await observePredicateMisplacedLifecycle({
          runtime,
          recorder,
          sessionId,
          followupRegistration,
          baselineAdmission,
          expectedGeneration: before.executionGeneration + 1,
          faultObservationOffset,
        });
        mutationObservation = predicateLifecycle.mutationObservation;
        followupAdmissionDistinct = predicateLifecycle.followupAdmissionDistinct;
        reach = predicateLifecycle.reach;
        followupInventory = await followupInventoryPromise;
        deadLetterOutcome = await deadLetterPromise;
      } else if (mutation === "raise_removed") {
        await observeRaiseRemovedMutationViolation({
          waitForObservation: (observe) => waitFor(
            observe,
            120_000,
            "activate rollback did not observe an owner commit or rejected marker",
            1_000,
          ),
          observeOwnerCommit: async () => {
            const ownership = await runtime.sessionExecutionOwnership(sessionId);
            return ownership.executionGeneration === before.executionGeneration + 1
              && ownership.owner === null
              ? ownership
              : undefined;
          },
          observeMarker: () => runtime.countTimelineEvents(
            sessionId,
            "assistant_message",
            rejectedMarker,
          ),
        });
      } else if (mutation === "cleanup_removed") {
        await delay(2_000);
      } else {
        await waitFor(
          () => runtime.runnerAlive(runner.pid) ? undefined : true,
          15_000,
          "activate rollback left the spawned child live",
          100,
        );
      }
      if (!predicateMutation) {
        ({ reach, followupInventory, deadLetterOutcome } = await observeActivationFailureOutcome({
            deadLetterPromise,
            observeRetryHorizon: () => runtime.activationFailureFaultCountAfterHorizon(
              ACTIVATE_ROLLBACK_RETRY_HORIZON_MS,
            ),
            followupInventoryPromise,
          }));
        followupAdmissionDistinct = followupRegistration.registrationId
            !== baselineAdmission.registrationId
          && initialReach.attemptedGeneration === before.executionGeneration + 1
          && initialReach.attemptedCommandFingerprint !== null
          && initialReach.attemptedCommandFingerprint !== baselineAdmission.commandFingerprint;
      }
      const after = await runtime.sessionExecutionOwnership(sessionId);
      const markerCount = await runtime.countTimelineEvents(
        sessionId,
        "assistant_message",
        rejectedMarker,
      );
      const observation = {
        semanticReachCount: reach.semanticReachCount,
        semanticReachCountBeforeHorizon: reach.semanticReachCountBeforeHorizon,
        retryHorizonStable: reach.stable,
        retryBudget: ACTIVATE_ROLLBACK_RETRY_BUDGET,
        retryHorizonMs: reach.retryHorizonMs,
        faultEnvelopeSourceSeq,
        deadLetterCode: deadLetterOutcome.status === "fulfilled"
          ? deadLetterOutcome.value.code
          : null,
        deadLetterSourceSeq: deadLetterOutcome.status === "fulfilled"
          ? deadLetterOutcome.value.sourceSeq
          : null,
        baselineAdmissionDrained: true,
        followupAdmissionDistinct,
        followupRegistrationObservationCount: followupInventory.registrationCount,
        followupPidObservationCount: followupInventory.pidCount,
        followupRegistrationIdentityObservationCount: followupInventory.identityCount,
        followupRegistrationObservations: followupInventory.observations,
        baselineRegistrationId: baselineAdmission.registrationId,
        followupRegistrationId: followupRegistration.registrationId,
        baselineCommandFingerprint: baselineAdmission.commandFingerprint,
        attemptedCommandFingerprint: reach.attemptedCommandFingerprint,
        attemptedGeneration: reach.attemptedGeneration,
        acquireApplied: after.executionGeneration !== before.executionGeneration
          || after.owner !== null,
        generationBefore: before.executionGeneration,
        generationAfter: after.executionGeneration,
        ownerBefore: before.owner,
        ownerAfter: after.owner,
        terminalRevisionBefore: before.terminalRevision,
        terminalRevisionAfter: after.terminalRevision,
        childAlive: runtime.runnerAlive(runner.pid),
        registrationPresent: (await runtime.runnerExecutionRegistration(sessionId)).present,
        markerCount,
      };
      const violations = activateRollbackViolations(observation);
      let mutationDetection;
      if (mutation) {
        mutationDetection = activateRollbackMutationDetection(mutation, observation);
        assertScenario(
          mutationDetection.detected,
          `activate-rollback mutation was not detected: ${mutation}`,
        );
      } else {
        assertScenario(
          violations.length === 0,
          `activate-rollback contract failed: ${violations.join("; ")}`,
        );
      }
      const verdict = {
        mutation,
        semanticReachCount: observation.semanticReachCount,
        retryBudget: observation.retryBudget,
        retryHorizonStable: observation.retryHorizonStable,
        deadLetter: {
          code: observation.deadLetterCode,
          faultEnvelopeSourceSeq: observation.faultEnvelopeSourceSeq,
          sourceSeq: observation.deadLetterSourceSeq,
        },
        followupAdmissions: {
          registrationCount: observation.followupRegistrationObservationCount,
          pidCount: observation.followupPidObservationCount,
          identityCount: observation.followupRegistrationIdentityObservationCount,
        },
        acquireApplied: observation.acquireApplied,
        generation: [observation.generationBefore, observation.generationAfter],
        terminalRevision: [
          observation.terminalRevisionBefore,
          observation.terminalRevisionAfter,
        ],
        childAlive: observation.childAlive,
        markerCount: observation.markerCount,
        mutationObservation,
        violations,
        mutationDetection,
      };
      scenarioResult = {
        id: "activate-rollback",
        status: "passed",
        sessionId,
        deliveryId,
        runnerPid: runner.pid,
        mutation,
        mutationDetection,
        interventionOutcome,
        before,
        after,
        observation,
        violations,
        verdict,
      };
    } catch (error) {
      scenarioError = error;
    } finally {
      const cleanupErrors = [];
      try {
        await runtime.removeActivationFailureFault();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (runner) {
        try {
          postCleanupRegistration = await runtime.runnerExecutionRegistration(sessionId);
          if (runtime.runnerAlive(runner.pid)) {
            if (!postCleanupRegistration.present) {
              throw new Error("activate rollback left an unregistered runner child live");
            }
            postCleanupRegistration = await runtime.terminateObservedLabRunnerRegistration(
              sessionId,
              runner.pid,
            );
          }
          if (postCleanupRegistration.present) {
            await runtime.removeLabRunnerRegistration(sessionId, runner.pid);
            postCleanupRegistration = await runtime.runnerExecutionRegistration(sessionId);
          }
          if (postCleanupRegistration.present) {
            throw new Error("activate rollback left a live runner registration");
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        cleanupResidue = await runtime.activationFailureFaultResidue();
        if (
          cleanupResidue.triggerCount !== 0
          || cleanupResidue.functionCount !== 0
          || cleanupResidue.counterCount !== 0
        ) {
          throw new Error(`activate rollback fault residue: ${JSON.stringify(cleanupResidue)}`);
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        postCleanupOwnership = await runtime.sessionExecutionOwnership(sessionId);
        if (postCleanupOwnership?.owner !== null) {
          throw new Error("activate rollback left a sessions-row execution registration");
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        const cleanupAggregate = new AggregateError(
          [...(scenarioError ? [scenarioError] : []), ...cleanupErrors],
          "activate-rollback injection and cleanup failed",
        );
        if (scenarioError || scenarioResult?.verdict?.mutationObservation == null) {
          throw cleanupAggregate;
        }
        cleanupFailure = serializeError(
          cleanupErrors.length === 1 ? cleanupErrors[0] : cleanupAggregate,
        );
        scenarioResult = {
          ...scenarioResult,
          status: "failed",
          cleanupFailure,
        };
      }
    }
    if (scenarioError) throw scenarioError;
    const completedResult = {
      ...scenarioResult,
      cleanup: {
        faultObjects: cleanupResidue,
        childAlive: runner ? runtime.runnerAlive(runner.pid) : false,
        registrationPresent: postCleanupRegistration?.present ?? false,
        sessionsRowOwner: postCleanupOwnership?.owner ?? null,
      },
      ...(cleanupFailure ? { cleanupFailure } : {}),
    };
    process.stdout.write(
      `ACTIVATE_ROLLBACK_${mutation ? "MUTATION" : "VERDICT"} `
        + `${JSON.stringify({ ...completedResult.verdict, cleanup: completedResult.cleanup })}\n`,
    );
    return completedResult;
  },

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
    const restartWindowDeliveryId = randomUUID();
    const restartWindowPayload = buildInterventionPayload(
      restartWindowDeliveryId,
      `Reply with exactly ${nextMarker}.`,
    );
    const restartWindowText = restartWindowPayload.text;
    await runtime.stopNodeForReleaseSwap();
    let newManifest;
    let acceptanceOutcome;
    try {
      newManifest = await runtime.rebuildReleaseWithEnv(toggled.text);
      assertScenario(
        newManifest.manifestId !== oldManifest.manifestId,
        "F9 rebuild did not change manifest identity",
      );
      await runtime.startStack();
      acceptanceOutcome = await settle(runtime.intervene(sessionId, restartWindowPayload));
      await recorder.event("restart_window_delivery_accepted", {
        sessionId,
        deliveryId: restartWindowDeliveryId,
        acceptanceOutcome,
      });
    } catch (error) {
      try {
        await runtime.rebuildReleaseWithEnv(originalEnvironment);
        await runtime.startStack();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "F9 injection and lab restoration failed");
      }
      throw error;
    }
    const oldMarkerOutcome = await settle(runtime.waitForMarker(sessionId, oldMarker, 240_000));
    const oldTerminalOutcome = await settle(runtime.waitForTerminal(sessionId, 30_000));
    const newRunnerOutcome = await settle(runtime.waitForRunner(sessionId, 60_000));
    const newRunner = newRunnerOutcome.status === "fulfilled" ? newRunnerOutcome.value : undefined;
    const acceptance = acceptanceOutcome.status === "fulfilled"
      ? acceptanceOutcome.value
      : acceptanceOutcome;
    let nextMarkerOutcome = { status: "not_attempted" };
    let nextTerminalOutcome = { status: "not_attempted" };
    if (
      acceptanceOutcome.status === "fulfilled"
      && acceptance?.status === "ok"
      && ["delivered", "queued", "auto_resumed"].includes(acceptance.outcome)
    ) {
      nextMarkerOutcome = await settle(runtime.waitForMarker(sessionId, nextMarker, 120_000));
      nextTerminalOutcome = await settle(runtime.waitForTerminal(sessionId, 30_000));
    }
    const status = await runtime.sessionStatus(sessionId);
    const oldCount = await runtime.countTimelineEvents(sessionId, "assistant_message", oldMarker);
    const nextCount = await runtime.countTimelineEvents(sessionId, "assistant_message", nextMarker);
    const interventionCount = await runtime.countTimelineEvents(
      sessionId,
      "intervention_sent",
      restartWindowText,
    );
    const inboxRemainingCount = runtime.runnerInterventionInboxCount(sessionId);
    const ownerships = await runtime.ownerships(sessionId);
    const inFlightOwnerships = ownerships.filter((row) => (
      row.phase === "reserved" || row.phase === "identity_proven" || row.phase === "active"
    ));
    const continuityObservation = {
      acceptance,
      interventionCount,
      oldAssistantCount: oldCount,
      assistantCount: nextCount,
      inboxRemainingCount,
      inFlightCount: inFlightOwnerships.length,
      oldPid: oldRunner.pid,
      newPid: newRunner?.pid,
      oldReleaseManifestId: oldRunner.config.releaseManifestId,
      newReleaseManifestId: newRunner?.config.releaseManifestId,
      replacementLogCount: 0,
    };
    const continuityViolations = restartWindowContinuityViolations(continuityObservation);
    return {
      id: "F9",
      status: continuityViolations.length === 0 ? "passed" : "failed",
      reason: continuityViolations.length === 0
        ? undefined
        : `F9 continuity failed before log reconciliation: ${continuityViolations.join("; ")}`,
      sessionId,
      oldRunner,
      newRunner,
      oldMarkerOutcome,
      oldTerminalOutcome,
      newRunnerOutcome,
      nextMarkerOutcome,
      nextTerminalOutcome,
      oldManifest,
      newManifest,
      sessionStatus: status,
      markerCounts: { old: oldCount, next: nextCount },
      restartWindowDeliveryId,
      interventionCount,
      inboxRemainingCount,
      inFlightOwnerships,
      continuityObservation,
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

function timestampDeltaMs(later, earlier) {
  const laterMs = Date.parse(later ?? "");
  const earlierMs = Date.parse(earlier ?? "");
  return Number.isFinite(laterMs) && Number.isFinite(earlierMs)
    ? laterMs - earlierMs
    : null;
}
