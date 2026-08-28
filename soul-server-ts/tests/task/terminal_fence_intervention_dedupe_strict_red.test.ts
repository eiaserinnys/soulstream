import { setImmediate } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  CALLER_SESSION_ID,
  createStoppedProductHarness,
  deliveryParams,
  RETRY_DELIVERY_ID,
  SESSION_ID,
  type RuntimeCounters,
} from "./terminal_fence_intervention_dedupe_harness.js";

interface TerminalRetryObservation extends RuntimeCounters {
  ledgerRowCount: number;
  ledgerState: string;
  aggregateState: string;
  attemptCount: number;
  taskStatus: string;
  terminalRevision: number | null;
  expectedTerminalRevision: number;
  interventionSentEffects: number;
  callerSessionId: string | null;
  targetSessionId: string | null;
}

interface FreshIntentObservation extends RuntimeCounters {
  retryCandidateOpen: boolean;
  interventionSentEffects: number;
  callerSessionId: string | null;
  targetSessionId: string | null;
}

describe("terminal fence intervention retry product RED", () => {
  it("holds a pre-stop retried delivery without reopening execution", async () => {
    const harness = await createStoppedProductHarness();
    const runtime = harness.startRuntime();
    try {
      await harness.taskManager.addIntervention(harness.retryParams, runtime.onResume);
      await settleProductBoundary();
      const row = harness.repository.row(RETRY_DELIVERY_ID);
      const observation: TerminalRetryObservation = {
        ...runtime.counters(),
        ledgerRowCount: harness.repository.count(RETRY_DELIVERY_ID),
        ledgerState: row.state,
        aggregateState: row.aggregate_state,
        attemptCount: row.attempt_count,
        taskStatus: harness.task.status,
        terminalRevision: harness.task.terminalEventId ?? null,
        expectedTerminalRevision: harness.terminalRevision,
        interventionSentEffects: harness.interventionSentCount(),
        callerSessionId: harness.task.callerSessionId ?? null,
        targetSessionId: row.target_session_id,
      };
      const violations = terminalRetryViolations(observation);
      console.info("TERMINAL_FENCE_INTERVENTION_RETRY_RED", JSON.stringify({
        observation,
        violations,
      }, null, 2));
      expect(violations).toEqual([]);
    } finally {
      runtime.release();
    }
  });

  it("opens one fresh post-stop intent and admits the held retry without a second semantic effect", async () => {
    const harness = await createStoppedProductHarness();
    const runtime = harness.startRuntime();
    try {
      await harness.taskManager.addIntervention(
        deliveryParams("fresh-post-stop-delivery", "genuinely fresh post-stop input"),
        runtime.onResume,
      );
      await settleProductBoundary();
      await harness.taskManager.addIntervention(harness.retryParams, runtime.onResume);
      await settleProductBoundary();
      const retryRow = harness.repository.row(RETRY_DELIVERY_ID);
      const observation: FreshIntentObservation = {
        ...runtime.counters(),
        retryCandidateOpen:
          retryRow.aggregate_state === "pending"
          && (retryRow.state === "pending" || retryRow.state === "queued")
          && harness.task.interventionQueue.some(
            (message) => message.deliveryId === RETRY_DELIVERY_ID,
          ),
        interventionSentEffects: harness.interventionSentCount(),
        callerSessionId: harness.task.callerSessionId ?? null,
        targetSessionId: retryRow.target_session_id,
      };
      const violations = freshIntentViolations(observation);
      console.info("TERMINAL_FENCE_FRESH_INTENT_RED", JSON.stringify({
        observation,
        violations,
      }, null, 2));
      expect(violations).toEqual([]);
    } finally {
      runtime.release();
    }
  });

  it("names every inverse mutation independently of caller and canonical delivery lineage", () => {
    const terminalBaseline: TerminalRetryObservation = {
      ledgerRowCount: 1,
      ledgerState: "pending",
      aggregateState: "pending",
      attemptCount: 1,
      taskStatus: "interrupted",
      terminalRevision: 501,
      expectedTerminalRevision: 501,
      interventionSentEffects: 1,
      automaticStarts: 0,
      executionAcquires: 0,
      turnStarts: 0,
      modelCalls: 0,
      callerSessionId: CALLER_SESSION_ID,
      targetSessionId: SESSION_ID,
    };
    const terminalMutations: Array<[
      string,
      Partial<TerminalRetryObservation>,
      string,
    ]> = [
      ["delete", { ledgerRowCount: 0 }, "pre-stop-retry-delivery-deleted"],
      ["consume", { ledgerState: "consumed", aggregateState: "consumed" },
        "pre-stop-retry-delivery-not-held"],
      ["reopen", { taskStatus: "running" }, "canonical-user-stop-terminal-reopened"],
      ["clear terminal revision", { terminalRevision: null }, "terminal-revision-fence-cleared"],
      ["automatic start", { automaticStarts: 1 }, "automatic-start-after-terminal-retry"],
      ["acquire", { executionAcquires: 1 }, "execution-acquire-after-terminal-retry"],
      ["turn", { turnStarts: 1 }, "turn-start-after-terminal-retry"],
      ["model", { modelCalls: 1 }, "model-call-after-terminal-retry"],
      ["duplicate semantic effect", { interventionSentEffects: 2 },
        "intervention-sent-semantic-effect-not-exactly-once"],
      ["caller lineage", { callerSessionId: "different-caller" },
        "caller-lineage-changed"],
      ["canonical target", { targetSessionId: "different-target" },
        "delivery-left-canonical-session-lineage"],
    ];
    expect(terminalRetryViolations(terminalBaseline)).toEqual([]);
    for (const [name, mutation, expected] of terminalMutations) {
      expect(
        terminalRetryViolations({ ...terminalBaseline, ...mutation }),
        name,
      ).toContain(expected);
    }

    const freshBaseline: FreshIntentObservation = {
      automaticStarts: 1,
      executionAcquires: 1,
      turnStarts: 2,
      modelCalls: 1,
      retryCandidateOpen: true,
      interventionSentEffects: 1,
      callerSessionId: CALLER_SESSION_ID,
      targetSessionId: SESSION_ID,
    };
    expect(freshIntentViolations(freshBaseline)).toEqual([]);
    for (const [name, mutation, expected] of [
      ["no fresh generation", { automaticStarts: 0 }, "fresh-intent-generation-not-exactly-once"],
      ["duplicate fresh generation", { automaticStarts: 2 },
        "fresh-intent-generation-not-exactly-once"],
      ["no acquire", { executionAcquires: 0 }, "fresh-intent-acquire-not-exactly-once"],
      ["duplicate acquire", { executionAcquires: 2 },
        "fresh-intent-acquire-not-exactly-once"],
      ["no model", { modelCalls: 0 }, "fresh-intent-model-call-not-exactly-once"],
      ["retry not opened", { retryCandidateOpen: false }, "held-retry-not-opened-by-fresh-intent"],
      ["duplicate effect", { interventionSentEffects: 2 },
        "intervention-sent-semantic-effect-not-exactly-once"],
      ["caller lineage", { callerSessionId: "different-caller" }, "caller-lineage-changed"],
      ["canonical target", { targetSessionId: "different-target" },
        "delivery-left-canonical-session-lineage"],
    ] as Array<[string, Partial<FreshIntentObservation>, string]>) {
      expect(freshIntentViolations({ ...freshBaseline, ...mutation }), name).toContain(expected);
    }
  });
});

function terminalRetryViolations(observation: TerminalRetryObservation): string[] {
  const violations: string[] = [];
  if (observation.ledgerRowCount !== 1) violations.push("pre-stop-retry-delivery-deleted");
  if (
    observation.aggregateState !== "pending"
    || (observation.ledgerState !== "pending" && observation.ledgerState !== "queued")
    || observation.attemptCount < 1
  ) violations.push("pre-stop-retry-delivery-not-held");
  if (observation.taskStatus !== "interrupted") {
    violations.push("canonical-user-stop-terminal-reopened");
  }
  if (observation.terminalRevision !== observation.expectedTerminalRevision) {
    violations.push("terminal-revision-fence-cleared");
  }
  if (observation.automaticStarts !== 0) {
    violations.push("automatic-start-after-terminal-retry");
  }
  if (observation.executionAcquires !== 0) {
    violations.push("execution-acquire-after-terminal-retry");
  }
  if (observation.turnStarts !== 0) violations.push("turn-start-after-terminal-retry");
  if (observation.modelCalls !== 0) violations.push("model-call-after-terminal-retry");
  if (observation.interventionSentEffects !== 1) {
    violations.push("intervention-sent-semantic-effect-not-exactly-once");
  }
  appendLineageViolations(violations, observation);
  return violations;
}

function freshIntentViolations(observation: FreshIntentObservation): string[] {
  const violations: string[] = [];
  if (observation.automaticStarts !== 1) {
    violations.push("fresh-intent-generation-not-exactly-once");
  }
  if (observation.executionAcquires !== 1) {
    violations.push("fresh-intent-acquire-not-exactly-once");
  }
  if (observation.modelCalls !== 1) {
    violations.push("fresh-intent-model-call-not-exactly-once");
  }
  if (!observation.retryCandidateOpen) violations.push("held-retry-not-opened-by-fresh-intent");
  if (observation.interventionSentEffects !== 1) {
    violations.push("intervention-sent-semantic-effect-not-exactly-once");
  }
  appendLineageViolations(violations, observation);
  return violations;
}

function appendLineageViolations(
  violations: string[],
  observation: Pick<TerminalRetryObservation, "callerSessionId" | "targetSessionId">,
): void {
  if (observation.callerSessionId !== CALLER_SESSION_ID) {
    violations.push("caller-lineage-changed");
  }
  if (observation.targetSessionId !== SESSION_ID) {
    violations.push("delivery-left-canonical-session-lineage");
  }
}

async function settleProductBoundary(): Promise<void> {
  await setImmediate();
  await setImmediate();
}
