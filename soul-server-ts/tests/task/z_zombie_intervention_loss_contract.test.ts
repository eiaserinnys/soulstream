import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionRow } from "../../src/db/session_db.js";
import { RunnerProcessEngineProxy } from
  "../../src/runner/runner_process_engine_proxy.js";
import { createTaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { TaskDeliveryLedgerGate } from
  "../../src/task/task_delivery_ledger_gate.js";
import { hydrateEvictedTaskFromSessionRow } from
  "../../src/task/task_evicted_hydration.js";
import type { AddInterventionParams } from
  "../../src/task/task_intervention_route.js";
import { TaskInterventionRoute } from
  "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from
  "./event_persistence_test_double.js";
import {
  applyZombieInterventionMutation,
  readZombieInterventionMutation,
  ZOMBIE_INTERVENTION_MUTATIONS,
  type InterventionAttemptObservation,
  type ZombieInterventionObservation,
  type ZombieInterventionMutation,
  zombieInterventionViolations,
} from "./z_zombie_intervention_loss_oracle.js";

const silentLogger = pino({ level: "silent" });
const ZOMBIE_DELIVERY_ID = "92000000-0000-4000-8000-000000000001";
const RECOVERED_DELIVERY_ID = "92000000-0000-4000-8000-000000000002";
const MUTATION = readZombieInterventionMutation(
  process.env.SOULSTREAM_Z_INTERVENTION_MUTATION,
);
const MUTATION_SENTINELS: Record<ZombieInterventionMutation, string> = {
  erase_terminal_truth: "terminal_truth_missing",
  admit_without_consumer: "terminal_without_consumer_admitted:zombie",
  drop_durable_input: "durable_input_not_exactly_once:recovered",
  drop_model_consumption: "model_input_not_exactly_once:recovered",
  drop_auto_resume: "auto_resume_not_exactly_once:zombie",
};

describe("zombie intervention strict causal contract", () => {
  it("same-harness terminal-truth counterfactual GREEN reaches every axis", async () => {
    const observation = applyZombieInterventionMutation(
      await observeZombieInterventionContract(projectTerminalTruthDouble),
      MUTATION,
    );
    const violations = zombieInterventionViolations(observation);
    process.stdout.write(
      `Z_COUNTERFACTUAL (${MUTATION ?? "fixed"}) ${JSON.stringify(violations)}\n`,
    );
    expect(violations).toEqual([]);
  });

  it.each(ZOMBIE_INTERVENTION_MUTATIONS)(
    "turns the same-harness counterfactual RED under %s",
    async (mutation) => {
      const violations = zombieInterventionViolations(
        applyZombieInterventionMutation(
          await observeZombieInterventionContract(projectTerminalTruthDouble),
          mutation,
        ),
      );
      process.stdout.write(
        `Z_MUTATION ${mutation} ${JSON.stringify(violations)}\n`,
      );
      expect(violations).toContain(MUTATION_SENTINELS[mutation]);
      expect(violations.length).toBeGreaterThan(0);
    },
  );

  it("counterfactual reaches the corrected product boundary balance", async () => {
    const observation = await observeZombieInterventionContract(
      projectTerminalTruthDouble,
    );
    expect(observation.productBoundaryCalls).toEqual({
      terminalTruth: 1,
      runningInterventionAdmission: 1,
      autoResume: 1,
      durableInput: 2,
      modelConsumption: 2,
    });
  });

  it("fresh main RED: a terminal zombie cannot admit and lose an intervention", async () => {
    const observation = await observeZombieInterventionContract();
    const violations = zombieInterventionViolations(observation);
    process.stdout.write(
      `Z_PRODUCT_DIAGNOSTIC ${JSON.stringify(observation.diagnostic)}\n`,
    );
    process.stdout.write(`Z_STRICT_CAUSAL_RED ${JSON.stringify(violations)}\n`);
    expect(
      violations,
      `zombie intervention violations: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });
});

async function observeZombieInterventionContract(
  terminalTruthProjection: (task: Task) => void = () => {},
): Promise<ZombieInterventionObservation> {
  const zombieTask = hydrateEvictedTaskFromSessionRow(
    zombieSessionRow(),
    silentLogger,
  );
  if (!zombieTask) throw new Error("zombie session row did not hydrate");
  terminalTruthProjection(zombieTask);

  const zombie = await observeAttempt(zombieTask, ZOMBIE_DELIVERY_ID, false);
  const recoveredTask = healthyRunningTask();
  const recovered = await observeAttempt(
    recoveredTask,
    RECOVERED_DELIVERY_ID,
    true,
  );
  const terminalEventIds = zombieTask.terminationEventRecorded
    && zombieTask.terminalEventId !== undefined
    ? [zombieTask.terminalEventId]
    : [];
  return {
    terminalEventIds,
    attempts: [zombie.observation, recovered.observation],
    productBoundaryCalls: {
      terminalTruth: terminalEventIds.length,
      runningInterventionAdmission:
        zombie.runningInterventionCalls + recovered.runningInterventionCalls,
      autoResume: zombie.autoResumeCalls + recovered.autoResumeCalls,
      durableInput: zombie.durableCalls + recovered.durableCalls,
      modelConsumption: zombie.modelCalls + recovered.modelCalls,
    },
    diagnostic: {
      hydratedStatus: zombieTask.status,
      zombieRouteResult: zombie.result,
    },
  };
}

async function observeAttempt(
  task: Task,
  deliveryId: string,
  consumerReady: boolean,
): Promise<{
  observation: InterventionAttemptObservation;
  runningInterventionCalls: number;
  autoResumeCalls: number;
  durableCalls: number;
  modelCalls: number;
  result: string;
}> {
  const ledgerClaimedDeliveryIds: string[] = [];
  const runningInterventionDeliveryIds: string[] = [];
  const autoResumeDeliveryIds: string[] = [];
  const durableInputDeliveryIds: string[] = [];
  const modelInputDeliveryIds: string[] = [];
  const persistence = makeEventPersistenceTestDouble(async (_sessionId, event) => {
    if (event.type === "intervention_sent" && event.text === textFor(deliveryId)) {
      durableInputDeliveryIds.push(deliveryId);
    }
  });
  const running = new RunningInterventionTransition({
    broadcaster: broadcaster(),
    logger: silentLogger,
    persistence: persistence.persistence,
    liveRetryDelayMs: 0,
  });
  if (consumerReady) {
    attachRecoveredRunner(task, durableInputDeliveryIds, modelInputDeliveryIds);
  }
  const ledger = ledgerGate(ledgerClaimedDeliveryIds);
  const route = new TaskInterventionRoute({
    getTask: () => task,
    loadEvictedTask: vi.fn().mockResolvedValue(null),
    rememberTask: vi.fn(),
    runningInterventionTransition: {
      deliver: vi.fn(async (...args: Parameters<typeof running.deliver>) => {
        runningInterventionDeliveryIds.push(deliveryId);
        return await running.deliver(...args);
      }),
    },
    autoResumeTransition: {
      resume: vi.fn(async (resumedTask, message, onResume) => {
        const resumedDeliveryId = requireValue(
          message.deliveryId,
          "auto-resume deliveryId",
        );
        autoResumeDeliveryIds.push(resumedDeliveryId);
        durableInputDeliveryIds.push(resumedDeliveryId);
        resumedTask.status = "running";
        await onResume(resumedTask);
        return { autoResumed: true as const };
      }),
    },
    deliveryLedgerGate: ledger.gate,
  });
  const result = await route.addIntervention(
    request(task.agentSessionId, deliveryId),
    () => {
      modelInputDeliveryIds.push(deliveryId);
    },
  );
  return {
    observation: {
      label: consumerReady ? "recovered" : "zombie",
      deliveryId,
      consumerReady,
      runningInterventionDeliveryIds,
      autoResumeDeliveryIds,
      durableInputDeliveryIds,
      modelInputDeliveryIds,
    },
    runningInterventionCalls: runningInterventionDeliveryIds.length,
    autoResumeCalls: autoResumeDeliveryIds.length,
    durableCalls: durableInputDeliveryIds.length,
    modelCalls: modelInputDeliveryIds.length,
    result: JSON.stringify(result),
  };
}

function projectTerminalTruthDouble(task: Task): void {
  if (task.terminationEventRecorded && task.terminationReason === "error_aborted") {
    task.status = "error";
  }
}

function attachRecoveredRunner(
  task: Task,
  durableInputDeliveryIds: string[],
  modelInputDeliveryIds: string[],
): void {
  const dispatcher = {
    hasActiveExecution: vi.fn().mockReturnValue(true),
    stageIntervention: vi.fn(async (input: {
      interventionId: string;
      queued: boolean;
      event?: unknown;
    }) => {
      if (!input.queued && input.event) {
        durableInputDeliveryIds.push(input.interventionId);
      }
      return {
        durability: "runner" as const,
        eventSourceSeq: input.event ? 1 : null,
        queuePosition: input.queued ? 1 : 0,
      };
    }),
    waitForSessionAck: vi.fn().mockResolvedValue(7002),
    applyIntervention: vi.fn(async (input: { interventionId: string }) => {
      modelInputDeliveryIds.push(input.interventionId);
      return { status: "delivered" as const, mechanism: "active_turn" as const };
    }),
    dispatch: vi.fn(),
    executeFrames: vi.fn(),
    prepareSession: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    detachHost: vi.fn(),
    sendControlFrame: vi.fn(),
    requestContext: vi.fn(),
  };
  task.modelPresetBackend = "codex";
  task.runner = createTaskRunnerRuntime(
    new RunnerProcessEngineProxy("codex", "/workspace/recovered", dispatcher as never),
    dispatcher as never,
    "runner",
  );
}

function ledgerGate(admittedDeliveryIds: string[]) {
  const rows = new Map<string, Record<string, unknown>>();
  const repository = {
    get: vi.fn(async (deliveryId: string) => rows.get(deliveryId) ?? null),
    register: vi.fn(async (params: Record<string, unknown>) => {
      const deliveryId = requireValue(params.deliveryId as string | undefined, "deliveryId");
      const row = {
        delivery_id: deliveryId,
        state: "pending",
        aggregate_state: "pending",
        intent: params.intent,
        source: params.source,
        completion_id: params.completionId,
        relation_key: params.relationKey,
        producer_terminal_revision: params.producerTerminalRevision ?? null,
        parent_delivery_id: params.parentDeliveryId ?? null,
        caller_turn_id: params.callerTurnId ?? null,
        target_session_id: params.targetSessionId,
        lease_owner: null,
        attempt_count: 0,
        created_at: params.createdAt
          ?? new Date("2026-08-26T01:08:03.004Z"),
        payload: params.payload,
        payload_hash: params.payloadHash,
      };
      rows.set(deliveryId, row);
      return { row, inserted: true, conflict: false };
    }),
    claimForTarget: vi.fn(async (
      deliveryId: string,
      targetSessionId: string,
      leaseOwner: string,
    ) => {
      const row = requireValue(rows.get(deliveryId), "registered delivery");
      const claimed = {
        ...row,
        state: "claimed",
        target_session_id: targetSessionId,
        lease_owner: leaseOwner,
      };
      rows.set(deliveryId, claimed);
      admittedDeliveryIds.push(deliveryId);
      return claimed;
    }),
    beginDispatch: vi.fn(async (deliveryId: string) => {
      const row = requireValue(rows.get(deliveryId), "claimed delivery");
      const dispatching = { ...row, state: "dispatching" };
      rows.set(deliveryId, dispatching);
      return dispatching;
    }),
    markQueued: vi.fn(async (deliveryId: string) => {
      const row = requireValue(rows.get(deliveryId), "dispatching delivery");
      const queued = { ...row, state: "queued" };
      rows.set(deliveryId, queued);
      return queued;
    }),
    markDelivered: vi.fn(async (deliveryId: string, receiptId: string) => {
      const row = requireValue(rows.get(deliveryId), "dispatching delivery");
      const delivered = {
        ...row,
        state: "delivered",
        aggregate_state: "delivered",
        target_receipt_id: receiptId,
      };
      rows.set(deliveryId, delivered);
      return delivered;
    }),
    markConsumed: vi.fn(async (deliveryId: string, receiptId: string) => {
      const row = requireValue(rows.get(deliveryId), "delivered delivery");
      const consumed = {
        ...row,
        state: "consumed",
        aggregate_state: "consumed",
        target_receipt_id: receiptId,
      };
      rows.set(deliveryId, consumed);
      return consumed;
    }),
    markUncertain: vi.fn(),
    markConsumedByRelation: vi.fn(),
    recordRelationConsumed: vi.fn(),
    retryLeasedDelivery: vi.fn(),
    markPendingSuperseded: vi.fn(),
    notifications: {
      stageWithQueuedDelivery: vi.fn(),
      get: vi.fn(),
      markPublished: vi.fn(),
      retry: vi.fn(),
    },
  };
  const gate = new TaskDeliveryLedgerGate(true, repository as never);
  return { gate, admitSpy: vi.spyOn(gate, "admit") };
}

function request(agentSessionId: string, deliveryId: string): AddInterventionParams {
  return {
    agentSessionId,
    text: textFor(deliveryId),
    user: "dashboard",
    source: "user_message",
    deliveryId,
    deliveryIntent: "human_live_steer",
    completionId: `message:${deliveryId}`,
    relationKey: `user_message:${agentSessionId}:${deliveryId}`,
  };
}

function zombieSessionRow(): SessionRow {
  return {
    session_id: "ab7ea625-1e09-4b0b-a162-646d171f4053",
    folder_id: null,
    display_name: "quarantined zombie",
    node_id: "eias-linegames-wsl",
    session_type: "claude",
    status: "running",
    prompt: "R2 migration",
    client_id: "dashboard",
    claude_session_id: "3ac24836-03b3-4af0-8e75-500337938d3e",
    last_message: null,
    metadata: null,
    was_running_at_shutdown: false,
    last_event_id: 397,
    last_read_event_id: 225,
    created_at: new Date("2026-08-26T00:00:00.000Z"),
    updated_at: new Date("2026-08-26T01:25:09.000Z"),
    agent_id: "writer-seosoyoung",
    caller_session_id: null,
    predecessor_session_id: null,
    away_summary: null,
    termination_reason: "error_aborted",
    termination_detail: "Runner host request timed out after 30000ms",
    termination_event_id: 387,
    last_assistant_text: null,
  };
}

function healthyRunningTask(): Task {
  return {
    agentSessionId: "track-z-recovered-counterfactual",
    prompt: "recovered foreground",
    status: "running",
    profileId: "track-z-red",
    createdAt: new Date("2026-08-26T03:00:00.000Z"),
    lastEventId: 7001,
    lastReadEventId: 7000,
    interventionQueue: [],
  };
}

function broadcaster(): SessionBroadcaster {
  return { emitEventEnvelope: vi.fn() } as unknown as SessionBroadcaster;
}

function textFor(deliveryId: string): string {
  return `track-z intervention ${deliveryId}`;
}

function requireValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}
