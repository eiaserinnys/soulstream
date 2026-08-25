import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { RunnerProcessEngineProxy } from "../../src/runner/runner_process_engine_proxy.js";
import { createTaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import {
  DELIVERY_INTENTS,
  type DeliveryIntent,
} from "../../src/task/delivery_contract.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import type {
  DeliveryLedgerAdmission,
  TaskDeliveryLedgerGate,
} from "../../src/task/task_delivery_ledger_gate.js";
import type { Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import {
  applyUnifiedRouteMutation,
  idealUnifiedExternalMessageObservation,
  readUnifiedRouteMutation,
  type IdleRouteEvidence,
  type RunningRouteEvidence,
  unifiedExternalMessageViolations,
} from "./task_intervention_unified_external_message_oracle.js";

const MUTATION = readUnifiedRouteMutation(
  process.env.SOULSTREAM_E_UNIFIED_ROUTE_MUTATION,
);
const silentLogger = pino({ level: "silent" });

describe("running external-message unified intervention contract", () => {
  it("is satisfiable when every running intent intervenes and every idle intent resumes", () => {
    expect(unifiedExternalMessageViolations(
      idealUnifiedExternalMessageObservation(),
    )).toEqual([]);
  });

  it("turns red when exactly one running intent is routed back to queue-only", () => {
    const mutated = applyUnifiedRouteMutation(
      idealUnifiedExternalMessageObservation(),
      "queue_one_running_intent",
    );
    expect(unifiedExternalMessageViolations(mutated)).toEqual([
      "running_intent_not_immediate:human_live_steer",
    ]);
  });

  it("routes every running external message through deliver and runner applyIntervention", async () => {
    const running: RunningRouteEvidence[] = [];
    const idle: IdleRouteEvidence[] = [];
    for (const intent of DELIVERY_INTENTS) {
      running.push(await observeRunningIntent(intent));
      idle.push(await observeIdleIntent(intent));
    }
    const observed = applyUnifiedRouteMutation({ running, idle }, MUTATION);
    const violations = unifiedExternalMessageViolations(observed);
    console.log(
      `E_UNIFIED_ROUTE_ORACLE (${MUTATION ?? "baseline"}) ${JSON.stringify(violations)}`,
    );
    expect(
      violations,
      `unified external-message route violations (${MUTATION ?? "baseline"}): `
        + `${JSON.stringify(violations)}\n${JSON.stringify(observed, null, 2)}`,
    ).toEqual([]);
  });
});

async function observeRunningIntent(
  intent: DeliveryIntent,
): Promise<RunningRouteEvidence> {
  const subject = makeSubject(intent, "running");
  const result = await subject.route.addIntervention(
    requestFor(intent, subject.task.agentSessionId),
    vi.fn(),
  );
  return {
    intent,
    deliverCalls: subject.deliver.mock.calls.length,
    queueOnlyCalls: subject.queueOnly.mock.calls.length,
    receiptStages: subject.stageIntervention.mock.calls.filter(
      ([input]) => input.queued === false,
    ).length,
    applyInterventionCalls: subject.applyIntervention.mock.calls.length,
    queuedStages: subject.stageIntervention.mock.calls.filter(
      ([input]) => input.queued === true,
    ).length,
    result: resultKind(result),
  };
}

async function observeIdleIntent(
  intent: DeliveryIntent,
): Promise<IdleRouteEvidence> {
  const subject = makeSubject(intent, "completed");
  const result = await subject.route.addIntervention(
    requestFor(intent, subject.task.agentSessionId),
    vi.fn(),
  );
  return {
    intent,
    resumeCalls: subject.resume.mock.calls.length,
    deliverCalls: subject.deliver.mock.calls.length,
    queueOnlyCalls: subject.queueOnly.mock.calls.length,
    applyInterventionCalls: subject.applyIntervention.mock.calls.length,
    result: resultKind(result),
  };
}

function makeSubject(intent: DeliveryIntent, status: "running" | "completed") {
  const deliveryId = deliveryIdFor(intent);
  const stageIntervention = vi.fn(async (input: { queued: boolean; event?: unknown }) => ({
    durability: "runner" as const,
    eventSourceSeq: input.event ? 1 : null,
    queuePosition: input.queued ? 1 : 0,
  }));
  const applyIntervention = vi.fn().mockResolvedValue({
    status: "delivered",
    mechanism: "active_turn",
  });
  const dispatcher = {
    stageIntervention,
    applyIntervention,
    waitForSessionAck: vi.fn().mockResolvedValue(101),
    dispatch: vi.fn(),
    executeFrames: vi.fn(),
    prepareSession: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    detachHost: vi.fn(),
    sendControlFrame: vi.fn(),
    requestContext: vi.fn(),
  };
  const task: Task = {
    agentSessionId: `unified-${status}-${intent}`,
    prompt: "original prompt",
    status,
    profileId: "codex-default",
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 3,
    interventionQueue: [],
    runner: createTaskRunnerRuntime(
      new RunnerProcessEngineProxy("codex", "/tmp/codex", dispatcher as never),
      dispatcher as never,
      "runner",
    ),
  };
  const runningTransition = new RunningInterventionTransition({
    broadcaster: { emitEventEnvelope: vi.fn() } as unknown as SessionBroadcaster,
    logger: silentLogger,
    liveRetryDelayMs: 0,
  });
  const deliver = vi.spyOn(runningTransition, "deliver");
  const queueOnly = vi.spyOn(runningTransition, "queueOnly");
  const resume = vi.fn().mockResolvedValue({ autoResumed: true });
  const admission = admitted(deliveryId, intent);
  const gate = {
    admit: vi.fn().mockResolvedValue(admission),
    beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
    recordResult: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
  } as Pick<
    TaskDeliveryLedgerGate,
    "admit" | "beginDispatch" | "recordResult" | "recordFailure"
  >;
  const route = new TaskInterventionRoute({
    getTask: () => task,
    loadEvictedTask: vi.fn().mockResolvedValue(null),
    rememberTask: vi.fn(),
    runningInterventionTransition: runningTransition,
    autoResumeTransition: {
      resume,
    } as unknown as Pick<AutoResumeTransition, "resume">,
    deliveryLedgerGate: gate,
  });
  return {
    route,
    task,
    deliver,
    queueOnly,
    resume,
    stageIntervention,
    applyIntervention,
  };
}

function admitted(
  deliveryId: string,
  intent: DeliveryIntent,
): DeliveryLedgerAdmission {
  return {
    kind: "admitted",
    deliveryId,
    row: {
      delivery_id: deliveryId,
      intent,
      source: sourceFor(intent),
      completion_id: `completion:${deliveryId}`,
      relation_key: `relation:${deliveryId}`,
      producer_terminal_revision: null,
      parent_delivery_id: null,
      caller_turn_id: null,
      lease_owner: "unified-route-test",
      created_at: new Date("2026-08-25T00:00:00.000Z"),
      payload: {
        text: `external ${intent}`,
        user: "external",
        attachment_paths: null,
        context: null,
        caller_info: null,
        followup_task_ids: null,
      },
      payload_hash: `hash:${deliveryId}`,
    } as never,
  };
}

function requestFor(intent: DeliveryIntent, agentSessionId: string) {
  const deliveryId = deliveryIdFor(intent);
  return {
    agentSessionId,
    text: `external ${intent}`,
    user: "external",
    deliveryId,
    deliveryIntent: intent,
    completionId: `completion:${deliveryId}`,
    relationKey: `relation:${deliveryId}`,
    source: sourceFor(intent),
  };
}

function sourceFor(intent: DeliveryIntent): string {
  if (intent === "human_live_steer") return "user_message";
  if (intent === "runtime_followup") return "claude_runtime_task_followup";
  if (intent === "durable_next_turn") return "schedule_dispatcher";
  return "completion_notifier";
}

function deliveryIdFor(intent: DeliveryIntent): string {
  return {
    human_live_steer: "11111111-1111-4111-8111-111111111111",
    durable_next_turn: "22222222-2222-4222-8222-222222222222",
    completion_notification: "33333333-3333-4333-8333-333333333333",
    runtime_followup: "44444444-4444-4444-8444-444444444444",
  }[intent];
}

function resultKind(result: unknown): "delivered" | "queued" | "resumed" | "other" {
  if (!result || typeof result !== "object") return "other";
  if ("autoResumed" in result) return "resumed";
  if ("delivered" in result && result.delivered === true) return "delivered";
  if ("queued" in result && result.queued === true) return "queued";
  return "other";
}
