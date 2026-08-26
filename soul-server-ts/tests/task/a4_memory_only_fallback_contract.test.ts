import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import { RunnerProcessEngineProxy } from
  "../../src/runner/runner_process_engine_proxy.js";
import { RunnerSqliteEventOutbox } from
  "../../src/runner/sqlite_event_outbox.js";
import { createTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import { TaskDeliveryLedgerGate } from
  "../../src/task/task_delivery_ledger_gate.js";
import type {
  AddInterventionParams,
  AddInterventionResult,
} from "../../src/task/task_intervention_route.js";
import { TaskInterventionRoute } from
  "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import {
  RunningInterventionTransition,
  type RunningInterventionResult,
} from "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from
  "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from
  "./event_persistence_test_double.js";

const DELIVERY_ID = "a4000000-0000-4000-8000-000000000001";
const SESSION_ID = "a4000000-0000-4000-8000-000000000002";
const silentLogger = pino({ level: "silent" });
const tempDirectories: string[] = [];

type FailureProjection = (
  result: RunningInterventionResult,
  task: Task,
) => RunningInterventionResult;

interface Observation {
  result: AddInterventionResult;
  centralState: SessionDeliveryRow["state"];
  restoreAdmission: "admitted" | "suppressed";
  restoreReason: string | null;
  runnerPendingAfterRestart: number;
  memoryQueueCount: number;
  stageAttempts: number;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("A4 durable staging failure strict causal contract", () => {
  it("same-harness honest-failure counterfactual reaches every axis", async () => {
    const observation = await observeContract(projectHonestFailure);
    process.stdout.write(`A4_COUNTERFACTUAL ${JSON.stringify(observation)}\n`);
    expect(contractViolations(observation)).toEqual([]);
  });

  it("turns RED when a false queued acknowledgement is reintroduced", async () => {
    const observation = await observeContract(projectHonestFailure);
    const mutated = {
      ...observation,
      result: {
        delivered: false,
        queued: true,
        queuePosition: 1,
        consumeWhen: "next_turn",
        reason: "verdict_unknown",
      } as const,
    };
    const violations = contractViolations(mutated);
    process.stdout.write(`A4_MUTATION false_queued_ack ${JSON.stringify(violations)}\n`);
    expect(violations).toContain("false_queued_ack");
  });

  it("counterfactual reaches the intended product-boundary balance", async () => {
    const observation = await observeContract(projectHonestFailure);
    expect(observation).toMatchObject({
      centralState: "pending",
      restoreAdmission: "admitted",
      runnerPendingAfterRestart: 0,
      memoryQueueCount: 0,
      stageAttempts: 2,
    });
  });

  it("fresh main RED: durable staging failure cannot acknowledge volatile queueing", async () => {
    const observation = await observeContract();
    const violations = contractViolations(observation);
    process.stdout.write(`A4_PRODUCT_DIAGNOSTIC ${JSON.stringify(observation)}\n`);
    process.stdout.write(`A4_STRICT_CAUSAL_RED ${JSON.stringify(violations)}\n`);
    expect(
      violations,
      `A4 durability violations: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });
});

async function observeContract(
  projectFailure: FailureProjection = (result) => result,
): Promise<Observation> {
  const directory = await mkdtemp(join(tmpdir(), "a4-memory-only-contract-"));
  tempDirectories.push(directory);
  const databasePath = join(directory, "runner.sqlite");
  const writer = await RunnerSqliteEventOutbox.create(databasePath);
  await writer.initializeBootstrap({
    session_id: SESSION_ID,
    created_at: "2026-08-26T00:00:00.000Z",
    resume: {
      schema_version: 1,
      backend_session_id: "backend-a4",
      cwd: "/workspace/a4",
      codex_home: "/workspace/a4/.codex",
      rollout_root: null,
      code_sha: "9f846e5b",
      snapshot_path: "/release/9f846e5b/soul-server-ts",
    },
  });
  writer.close();

  const repository = new RestartableDeliveryRepository();
  const gate = new TaskDeliveryLedgerGate(true, repository as never);
  const task = runningTask();
  let stageAttempts = 0;
  const dispatcher = {
    hasActiveExecution: vi.fn().mockReturnValue(true),
    stageIntervention: vi.fn(async () => {
      stageAttempts += 1;
      throw new Error(`injected total durable staging failure ${stageAttempts}`);
    }),
    applyIntervention: vi.fn(),
    waitForSessionAck: vi.fn(),
  };
  task.runner = createTaskRunnerRuntime(
    new RunnerProcessEngineProxy("codex", "/workspace/a4", dispatcher as never),
    dispatcher as never,
    "runner",
  );
  const running = new RunningInterventionTransition({
    broadcaster: broadcaster(),
    logger: silentLogger,
    persistence: makeEventPersistenceTestDouble().persistence,
  });
  const route = new TaskInterventionRoute({
    getTask: () => task,
    loadEvictedTask: vi.fn().mockResolvedValue(null),
    rememberTask: vi.fn(),
    runningInterventionTransition: {
      deliver: vi.fn(async (...args: Parameters<typeof running.deliver>) =>
        projectFailure(await running.deliver(...args), task)),
    },
    autoResumeTransition: {
      resume: vi.fn(async () => ({ autoResumed: true as const })),
    },
    deliveryLedgerGate: gate,
  });
  const result = await route.addIntervention(request(), vi.fn());

  const recoveredRunner = await RunnerSqliteEventOutbox.open(databasePath);
  const runnerPendingAfterRestart = (await recoveredRunner.readPendingInterventions()).length;
  recoveredRunner.close();

  const restartedRepository = repository.restart();
  const restoreAdmission = await new TaskDeliveryLedgerGate(
    true,
    restartedRepository as never,
  ).admit(request());
  return {
    result,
    centralState: repository.current.state,
    restoreAdmission: restoreAdmission.kind === "admitted" ? "admitted" : "suppressed",
    restoreReason: restoreAdmission.kind === "suppressed" ? restoreAdmission.reason : null,
    runnerPendingAfterRestart,
    memoryQueueCount: task.interventionQueue.length,
    stageAttempts,
  };
}

function projectHonestFailure(
  result: RunningInterventionResult,
  task: Task,
): RunningInterventionResult {
  task.interventionQueue.length = 0;
  if ("queued" in result) {
    return {
      delivered: null,
      reason: "verdict_unknown",
      consumeWhen: null,
    };
  }
  return result;
}

function contractViolations(observation: Observation): string[] {
  const violations: string[] = [];
  if (!("delivered" in observation.result && observation.result.delivered === null)) {
    violations.push("false_queued_ack");
  }
  if (observation.memoryQueueCount !== 0) violations.push("volatile_copy_retained");
  if (observation.runnerPendingAfterRestart !== 0) {
    violations.push("unexpected_runner_restore_entry");
  }
  if (observation.centralState !== "pending") violations.push("central_retry_lost");
  if (observation.restoreAdmission !== "admitted") violations.push("restart_restore_blocked");
  const durableOwners = observation.runnerPendingAfterRestart
    + Number(observation.centralState === "pending");
  if (durableOwners !== 1) violations.push("durable_owner_not_exactly_one");
  return violations;
}

class RestartableDeliveryRepository {
  current: SessionDeliveryRow;

  constructor(row: SessionDeliveryRow = deliveryRow()) {
    this.current = structuredClone(row);
  }

  readonly get = vi.fn(async (deliveryId: string) =>
    deliveryId === DELIVERY_ID ? this.current : null);

  readonly register = vi.fn(async () => ({
    row: this.current,
    inserted: false,
    conflict: false,
  }));

  readonly claimForTarget = vi.fn(async (
    deliveryId: string,
    targetSessionId: string,
    leaseOwner: string,
  ) => {
    if (deliveryId !== DELIVERY_ID || this.current.state !== "pending") return null;
    this.current = {
      ...this.current,
      state: "claimed",
      target_session_id: targetSessionId,
      lease_owner: leaseOwner,
    };
    return this.current;
  });

  readonly beginDispatch = vi.fn(async (deliveryId: string) => {
    if (deliveryId !== DELIVERY_ID || this.current.state !== "claimed") return null;
    this.current = { ...this.current, state: "dispatching" };
    return this.current;
  });

  readonly markQueued = vi.fn(async (deliveryId: string) => {
    if (deliveryId !== DELIVERY_ID || this.current.state !== "dispatching") return null;
    this.current = { ...this.current, state: "queued" };
    return this.current;
  });

  readonly retryLeasedDelivery = vi.fn(async (deliveryId: string) => {
    if (deliveryId !== DELIVERY_ID || this.current.state !== "dispatching") return null;
    this.current = {
      ...this.current,
      state: "pending",
      lease_owner: null,
      attempt_count: this.current.attempt_count + 1,
    };
    return this.current;
  });

  readonly markDelivered = vi.fn();
  readonly markUncertain = vi.fn();
  readonly markConsumed = vi.fn();
  readonly markConsumedByRelation = vi.fn();
  readonly recordRelationConsumed = vi.fn();
  readonly markPendingSuperseded = vi.fn();
  readonly notifications = {
    stageWithQueuedDelivery: vi.fn(),
    get: vi.fn(),
    markPublished: vi.fn(),
    retry: vi.fn(),
  };

  restart(): RestartableDeliveryRepository {
    return new RestartableDeliveryRepository(this.current);
  }
}

function deliveryRow(): SessionDeliveryRow {
  return {
    delivery_id: DELIVERY_ID,
    target_session_id: SESSION_ID,
    relation_key: `user_message:${SESSION_ID}:${DELIVERY_ID}`,
    completion_id: `message:${DELIVERY_ID}`,
    intent: "human_live_steer",
    source: "user_message",
    producer_terminal_revision: null,
    state: "pending",
    aggregate_state: "pending",
    target_receipt_id: null,
    caller_turn_id: null,
    lease_owner: null,
    attempt_count: 0,
    created_at: new Date(),
    payload: {
      text: "survive total durable staging failure",
      user: "alice",
      attachment_paths: null,
      context: null,
      caller_info: null,
      followup_task_ids: null,
    },
    payload_hash: "a4-contract-payload",
  } as SessionDeliveryRow;
}

function request(): AddInterventionParams {
  return {
    agentSessionId: SESSION_ID,
    text: "survive total durable staging failure",
    user: "alice",
    source: "user_message",
    deliveryId: DELIVERY_ID,
    deliveryIntent: "human_live_steer",
    completionId: `message:${DELIVERY_ID}`,
    relationKey: `user_message:${SESSION_ID}:${DELIVERY_ID}`,
  };
}

function runningTask(): Task {
  return {
    agentSessionId: SESSION_ID,
    prompt: "active foreground turn",
    status: "running",
    profileId: "codex-roselin",
    createdAt: new Date("2026-08-26T00:00:00.000Z"),
    lastEventId: 10,
    lastReadEventId: 9,
    interventionQueue: [],
  };
}

function broadcaster(): SessionBroadcaster {
  return { emitEventEnvelope: vi.fn() } as unknown as SessionBroadcaster;
}
