import pino from "pino";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { SessionDeliveryRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import type { EngineExecuteParams } from "../../src/engine/protocol.js";
import { engineEventFrame } from "../../src/runner/frame_protocol.js";
import { RunnerProcessEngineProxy } from
  "../../src/runner/runner_process_engine_proxy.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import {
  TaskDeliveryLedgerGate,
  type DeliveryLedgerAdmission,
} from "../../src/task/task_delivery_ledger_gate.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "../db/full_schema_postgres_harness.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });
const SESSION_ID = "session-d-reconciliation";
const agent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

type RestoreAggregateState = "consumed" | "delivered" | "dead_letter";

interface LocalInboxRow {
  interventionId: string;
  message: InterventionMessage;
}

interface RestoreObservation {
  aggregateState: RestoreAggregateState;
  discarded: boolean;
  restoredExecutions: number;
}

interface RestoreGateCompatibility {
  discardIfConsumed?: (
    message: InterventionMessage,
    task: Task,
  ) => Promise<boolean>;
  discardIfRestoreSuppressed?: (
    message: InterventionMessage,
    task: Task,
  ) => Promise<boolean>;
}

let postgresHarness: FullSchemaPostgresHarness;
let repository: SessionDeliveryRepository;

beforeAll(async () => {
  postgresHarness = await createFullSchemaPostgresHarness();
  repository = new SessionDeliveryRepository(postgresHarness.sql);
}, 45_000);

beforeEach(async () => {
  await postgresHarness.sql`DELETE FROM session_delivery_relation_consumptions`;
  await postgresHarness.sql`DELETE FROM session_deliveries`;
  await postgresHarness.sql`DELETE FROM sessions`;
  await postgresHarness.sql`
    INSERT INTO sessions (session_id, session_type, status, agent_id)
    VALUES (${SESSION_ID}, 'codex', 'completed', ${agent.id})
  `;
});

afterAll(async () => {
  await postgresHarness.cleanup();
});

function makeTask(status: "completed" | "running" = "completed"): Task {
  return {
    agentSessionId: SESSION_ID,
    prompt: "previous prompt",
    status,
    profileId: agent.id,
    createdAt: new Date("2026-08-23T20:00:00.000Z"),
    ...(status === "completed"
      ? {
          completedAt: new Date("2026-08-23T20:01:00.000Z"),
          terminalEventId: 10,
        }
      : {}),
    lastEventId: 10,
    lastReadEventId: 10,
    interventionQueue: [],
  };
}

function makeRouteLedgerGate(restoreGate: TaskDeliveryLedgerGate) {
  const admit = vi.fn(async (params: {
    deliveryId?: string;
    text: string;
    user: string;
  }): Promise<DeliveryLedgerAdmission> => {
    const deliveryId = params.deliveryId;
    if (!deliveryId) return { kind: "legacy" };
    return {
      kind: "admitted",
      deliveryId,
      row: {
        delivery_id: deliveryId,
        intent: "durable_next_turn",
        source: "completion_notifier",
        completion_id: `completion:${deliveryId}`,
        relation_key: `relation:${deliveryId}`,
        producer_terminal_revision: null,
        parent_delivery_id: null,
        caller_turn_id: null,
        lease_owner: "route-contract",
        attempt_count: 1,
        created_at: new Date("2026-08-23T20:02:00.000Z"),
        payload: {
          text: params.text,
          user: params.user,
          attachment_paths: null,
          context: null,
          caller_info: null,
          followup_task_ids: null,
        },
        payload_hash: `hash:${deliveryId}`,
      } as never,
    };
  });
  const discardIfRestoreSuppressed = vi.fn(async (
    message: InterventionMessage,
    task: Task,
  ) => {
    const compatibility = restoreGate as unknown as RestoreGateCompatibility;
    const discard = compatibility.discardIfRestoreSuppressed
      ?? compatibility.discardIfConsumed;
    if (!discard) {
      throw new Error("delivery restore suppression capability is unavailable");
    }
    return await discard.call(restoreGate, message, task);
  });
  return {
    admit,
    beginDispatch: vi.fn(async (admission: DeliveryLedgerAdmission) => admission),
    recordResult: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => undefined),
    recordReservationRetry: vi.fn(async () => "retryable" as const),
    recordConsumed: vi.fn(async () => undefined),
    recordTurnStarted: vi.fn(async () => "turn-contract"),
    discardIfConsumed: discardIfRestoreSuppressed,
    discardIfRestoreSuppressed,
  } as unknown as TaskDeliveryLedgerGate;
}

function makeRunner(localRows: readonly LocalInboxRow[]) {
  const openRows = new Map(localRows.map((row) => [row.interventionId, row]));
  const executed: EngineExecuteParams[] = [];
  const dispatcher = {
    executeFrames: vi.fn((params: EngineExecuteParams) => (async function* () {
      executed.push(params);
      const interventionId = params.runnerInterventionId;
      if (interventionId && !openRows.has(interventionId)) {
        throw new Error(`execute_intervention_claim_failed:${interventionId}`);
      }
      yield engineEventFrame({
        type: "assistant_message",
        content: `handled:${params.prompt}`,
      });
      yield engineEventFrame({ type: "complete", result: "done", timestamp: 1 });
      if (interventionId) openRows.delete(interventionId);
    })()),
    prepareSession: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    detachHost: vi.fn(async () => undefined),
    waitForSessionAck: vi.fn(async () => null),
    recoverPendingInterventions: vi.fn(async () => [...openRows.values()]),
    discardIntervention: vi.fn(async (interventionId: string) => {
      openRows.delete(interventionId);
    }),
    invoke: vi.fn(async () => undefined),
  };
  const runner: TaskRunnerRuntime = {
    engine: new RunnerProcessEngineProxy(
      "codex",
      agent.workspace_dir,
      dispatcher as never,
    ),
    dispatcher: dispatcher as never,
    eventPersistence: "runner",
  };
  return { runner, openRows, executed, dispatcher };
}

function deliveryMessage(deliveryId: string, text: string): InterventionMessage {
  return {
    text,
    user: "system",
    source: "completion_notifier",
    deliveryId,
    deliveryIntent: "durable_next_turn",
    completionId: `completion:${deliveryId}`,
    relationKey: `relation:${deliveryId}`,
  };
}

function makeHarness(input: {
  restoreGate: TaskDeliveryLedgerGate;
  localRows?: readonly LocalInboxRow[];
  taskStatus?: "completed" | "running";
}) {
  const task = makeTask(input.taskStatus);
  const persistenceDouble = makeEventPersistenceTestDouble();
  const ledgerGate = makeRouteLedgerGate(input.restoreGate);
  const { runner, openRows, executed, dispatcher } = makeRunner(input.localRows ?? []);
  const db = {
    updateSession: vi.fn(async () => undefined),
    setClaudeSessionId: vi.fn(async () => undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn(async () => undefined),
    emitSessionUpdated: vi.fn(async () => undefined),
  } as unknown as SessionBroadcaster;
  const executor = new TaskExecutor(
    () => runner.engine,
    db,
    persistenceDouble.persistence,
    broadcaster,
    silentLogger,
    undefined,
    undefined,
    undefined,
    undefined,
    ledgerGate,
  );
  const autoResumeTransition = new AutoResumeTransition({
    logger: silentLogger,
    persistence: persistenceDouble.persistence,
  });
  const queued = {
    delivered: false,
    queued: true,
    queuePosition: 1,
    consumeWhen: "next_turn",
    reason: "queue_only_policy",
  } as const;
  const runningInterventionTransition = {
    deliver: vi.fn(async () => queued),
    queueOnly: vi.fn(async () => queued),
  } as unknown as Pick<RunningInterventionTransition, "deliver" | "queueOnly">;
  const route = new TaskInterventionRoute({
    getTask: () => task,
    loadEvictedTask: vi.fn(async () => null),
    rememberTask: vi.fn(),
    runningInterventionTransition,
    autoResumeTransition,
    deliveryLedgerGate: ledgerGate,
  });
  const start = async () => {
    executor.startExecutionWithRunner(task, agent, runner);
    await task.executionPromise;
  };
  const resume = async (message: InterventionMessage) => {
    const result = await route.addIntervention({
      agentSessionId: task.agentSessionId,
      ...message,
    }, () => executor.startExecutionWithRunner(task, agent, runner));
    await task.executionPromise;
    return result;
  };
  return { task, route, start, resume, openRows, executed, dispatcher };
}

async function seedRepositoryProof(
  aggregateState: RestoreAggregateState,
): Promise<{ message: InterventionMessage; row: SessionDeliveryRow }> {
  const deliveryId = `delivery-${aggregateState}`;
  const message = deliveryMessage(deliveryId, `stale ${aggregateState}`);
  await repository.register({
    deliveryId,
    targetSessionId: SESSION_ID,
    relationKey: message.relationKey!,
    completionId: message.completionId!,
    intent: message.deliveryIntent!,
    source: message.source!,
    payloadHash: `hash:${deliveryId}`,
    payload: { text: message.text, user: message.user },
  });
  if (aggregateState === "dead_letter") {
    await repository.markUncertain(deliveryId, undefined, "contract dead letter");
  } else {
    await repository.claimForTarget(deliveryId, SESSION_ID, "d-contract");
    await repository.beginDispatch(deliveryId, "d-contract");
    await repository.markDelivered(deliveryId, `receipt:${deliveryId}`);
    if (aggregateState === "consumed") {
      await repository.markConsumed(deliveryId, `turn:${deliveryId}`);
    }
  }
  const row = await repository.get(deliveryId);
  if (!row) throw new Error(`repository proof missing: ${deliveryId}`);
  return { message, row };
}

function observeRestore(
  aggregateState: RestoreAggregateState,
  harness: ReturnType<typeof makeHarness>,
  interventionId: string,
): RestoreObservation {
  return {
    aggregateState,
    discarded: harness.dispatcher.discardIntervention.mock.calls.some(
      ([discardedId]) => discardedId === interventionId,
    ),
    restoredExecutions: harness.executed.filter(
      (params) => params.runnerInterventionId === interventionId,
    ).length,
  };
}

function restoreViolations(observation: RestoreObservation): string[] {
  if (observation.aggregateState === "delivered") {
    return [
      ...(observation.discarded ? ["delivered_discarded"] : []),
      ...(observation.restoredExecutions === 1
        ? []
        : ["delivered_execution_count"]),
    ];
  }
  return [
    ...(observation.discarded ? [] : [`${observation.aggregateState}_not_discarded`]),
    ...(observation.restoredExecutions === 0
      ? []
      : [`${observation.aggregateState}_restored`]),
  ];
}

describe.sequential("central delivery ↔ runner inbox reconciliation contract", () => {
  it.each([
    ["consumed", "consumed"],
    ["delivered", "delivered"],
    ["dead_letter", "uncertain"],
  ] as const)(
    "derives aggregate %s from the real repository transition",
    async (aggregateState, lowLevelState) => {
      const proof = await seedRepositoryProof(aggregateState);
      const observation = {
        aggregateState: proof.row.aggregate_state,
        lowLevelState: proof.row.state,
        targetReceiptId: proof.row.target_receipt_id,
      };

      process.stdout.write(`D_RECONCILIATION_PROOF ${JSON.stringify(observation)}\n`);
      expect(observation.aggregateState).toBe(aggregateState);
      expect(observation.lowLevelState).toBe(lowLevelState);
      expect(Boolean(observation.targetReceiptId)).toBe(aggregateState !== "dead_letter");
    },
  );

  it.each(["consumed", "dead_letter"] as const)(
    "discards local restore after aggregate %s and executes only the fresh resume",
    async (aggregateState) => {
      const proof = await seedRepositoryProof(aggregateState);
      const restoreGate = new TaskDeliveryLedgerGate(true, repository as never);
      const harness = makeHarness({
        restoreGate,
        localRows: [{ interventionId: proof.row.delivery_id, message: proof.message }],
      });

      await expect(harness.resume(
        deliveryMessage("delivery-fresh", "fresh resume"),
      )).resolves.toEqual({ autoResumed: true });

      const observation = observeRestore(
        aggregateState,
        harness,
        proof.row.delivery_id,
      );
      process.stdout.write(`D_RECONCILIATION_RESTORE ${JSON.stringify(observation)}\n`);
      expect(restoreViolations(observation)).toEqual([]);
      expect(harness.executed.map((input) => input.prompt)).toEqual(["fresh resume"]);
    },
  );

  it("restores aggregate delivered exactly once after restart", async () => {
    const proof = await seedRepositoryProof("delivered");
    const restoreGate = new TaskDeliveryLedgerGate(true, repository as never);
    const harness = makeHarness({
      restoreGate,
      localRows: [{ interventionId: proof.row.delivery_id, message: proof.message }],
      taskStatus: "running",
    });

    await harness.start();

    const observation = observeRestore("delivered", harness, proof.row.delivery_id);
    process.stdout.write(`D_RECONCILIATION_RESTORE ${JSON.stringify(observation)}\n`);
    expect(restoreViolations(observation)).toEqual([]);
    expect(harness.executed.map((input) => input.prompt))
      .toEqual([proof.message.text]);
  });

  it("auto-resumes a central delivery when no local inbox row exists", async () => {
    const restoreGate = new TaskDeliveryLedgerGate(true, repository as never);
    const harness = makeHarness({ restoreGate });

    await expect(harness.resume(
      deliveryMessage("delivery-central-only", "central only"),
    )).resolves.toEqual({ autoResumed: true });

    expect(harness.executed.map((input) => input.prompt)).toEqual(["central only"]);
    expect([...harness.openRows.keys()]).toEqual([]);
    expect(harness.task.status).toBe("completed");
  });

  it("settles a matching local inbox row when central auto-resume completes", async () => {
    const deliveryId = "delivery-shared";
    const message = deliveryMessage(deliveryId, "shared delivery");
    const restoreGate = new TaskDeliveryLedgerGate(true, repository as never);
    const harness = makeHarness({
      restoreGate,
      localRows: [{ interventionId: deliveryId, message }],
    });

    await expect(harness.resume(message)).resolves.toEqual({ autoResumed: true });

    expect(harness.executed.map((input) => input.prompt)).toEqual(["shared delivery"]);
    expect([...harness.openRows.keys()]).toEqual([]);
  });

  it.each([
    [
      "remove_dead_letter_suppression",
      { aggregateState: "dead_letter", discarded: true, restoredExecutions: 0 },
      { aggregateState: "dead_letter", discarded: false, restoredExecutions: 1 },
      ["dead_letter_not_discarded", "dead_letter_restored"],
    ],
    [
      "add_delivered_suppression",
      { aggregateState: "delivered", discarded: false, restoredExecutions: 1 },
      { aggregateState: "delivered", discarded: true, restoredExecutions: 0 },
      ["delivered_discarded", "delivered_execution_count"],
    ],
  ] as const)(
    "mutation %s makes the bidirectional restore contract RED",
    (mutation, ideal, mutated, expectedViolations) => {
      expect(restoreViolations(ideal)).toEqual([]);
      const violations = restoreViolations(mutated);
      process.stdout.write(
        `D_RECONCILIATION_MUTATION ${JSON.stringify({ mutation, violations })}\n`,
      );
      expect(violations).toEqual(expectedViolations);
    },
  );
});
