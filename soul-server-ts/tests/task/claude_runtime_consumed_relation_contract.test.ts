import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import type { EngineExecuteParams } from "../../src/engine/protocol.js";
import { engineEventFrame } from "../../src/runner/frame_protocol.js";
import { RunnerProcessEngineProxy } from
  "../../src/runner/runner_process_engine_proxy.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { TaskDeliveryLedgerGate } from
  "../../src/task/task_delivery_ledger_gate.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });
const SESSION_ID = "7977b1fe-4bb5-4491-bd66-b43946b19d6c";
const oracleMutation = process.env.SOULSTREAM_B_ORACLE_MUTATION;

const BQQ = {
  taskId: "bqqgtqzwh",
  deliveryId: "415fc3ff-8525-5e0c-a584-fae655a545e1",
  relationKey: `claude_runtime:${SESSION_ID}:bqqgtqzwh`,
  completionId:
    "completion:6d9ee252b5d7127e22fa24a53e44dead5d456d9fb7c7384378bf755e6bc469de",
  producerTerminalRevision: "1787441739424",
  notificationEventId: 689,
  inlineConsumedTurnId: 698,
} as const;

const BBOX = {
  taskId: "bboxso191",
  deliveryId: "07012e47-34ff-5eae-8b3e-141923338092",
  relationKey: `claude_runtime:${SESSION_ID}:bboxso191`,
  completionId:
    "completion:8ffa469fa046cdc681e80f8ca650583d7b6d264d291fdbd625d30efa2886e13d",
  producerTerminalRevision: "1787441369017",
  notificationEventId: 618,
  inlineConsumedTurnId: 698,
} as const;

const agent: AgentProfile = {
  id: "claude-roselin",
  name: "로젤린",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
};

type HistoricalIdentity = typeof BQQ | typeof BBOX;

interface InboxRow {
  interventionId: string;
  message: InterventionMessage;
}

interface TurnObservation {
  deliveryId: string | null;
  relationKey: string | null;
  prompt: string;
}

class RelationLedgerRepository {
  readonly rows = new Map<string, SessionDeliveryRow>();
  readonly consumedTransitions = new Map<string, number>();

  constructor(identities: readonly HistoricalIdentity[]) {
    for (const identity of identities) {
      this.rows.set(identity.deliveryId, historicalRow(identity));
    }
  }

  readonly get = vi.fn(async (deliveryId: string) => this.rows.get(deliveryId) ?? null);

  readonly register = vi.fn(async (params: { deliveryId: string }) => {
    const existing = this.rows.get(params.deliveryId);
    if (!existing) throw new Error(`unknown historical delivery: ${params.deliveryId}`);
    return { row: existing, inserted: false, conflict: false };
  });

  readonly markConsumedByRelation = vi.fn(async (
    relationKey: string,
    completionId: string,
    consumedTurnId: string,
  ) => {
    if (oracleMutation === "drop_central_consumption") return null;
    const row = [...this.rows.values()].find(
      (candidate) => candidate.relation_key === relationKey
        && candidate.completion_id === completionId,
    );
    if (!row) return null;
    if (row.state !== "consumed") {
      row.state = "consumed";
      row.aggregate_state = "consumed";
      row.caller_turn_id = consumedTurnId;
      this.consumedTransitions.set(
        relationKey,
        (this.consumedTransitions.get(relationKey) ?? 0) + 1,
      );
    }
    return row;
  });

  readonly markDelivered = vi.fn(async (
    deliveryId: string,
    targetReceiptId: string,
  ) => {
    const row = this.rows.get(deliveryId);
    if (!row || row.state === "consumed") return null;
    row.state = "delivered";
    row.aggregate_state = "delivered";
    row.target_receipt_id = targetReceiptId;
    return row;
  });

  readonly markConsumed = vi.fn(async (
    deliveryId: string,
    consumedTurnId: string,
  ) => {
    const row = this.rows.get(deliveryId);
    if (!row) return null;
    if (row.state !== "consumed") {
      row.state = "consumed";
      row.aggregate_state = "consumed";
      row.caller_turn_id = consumedTurnId;
      this.consumedTransitions.set(
        row.relation_key,
        (this.consumedTransitions.get(row.relation_key) ?? 0) + 1,
      );
    }
    return row;
  });

  readonly recordRelationConsumed = vi.fn(async () => ({
    relation: {},
    relationInserted: false,
    deliveryConsumed: false,
  }));
}

function historicalRow(identity: HistoricalIdentity): SessionDeliveryRow {
  const message = historicalMessage(identity);
  return {
    delivery_id: identity.deliveryId,
    target_session_id: SESSION_ID,
    relation_key: identity.relationKey,
    completion_id: identity.completionId,
    intent: "runtime_followup",
    source: "claude_runtime_task_followup",
    producer_terminal_revision: identity.producerTerminalRevision,
    state: "delivered",
    aggregate_state: "delivered",
    target_receipt_id: `event:${identity.notificationEventId}`,
    caller_turn_id: null,
    payload: {
      text: message.text,
      user: message.user,
      attachment_paths: null,
      context: null,
      caller_info: null,
      followup_task_ids: [identity.taskId],
    },
    payload_hash: `historical:${identity.deliveryId}`,
  } as SessionDeliveryRow;
}

function historicalMessage(identity: HistoricalIdentity): InterventionMessage {
  return {
    text: [
      "<claude-runtime-background-task-followup>",
      "백그라운드 Claude runtime task가 완료되었습니다.",
      `1. task_id=${identity.taskId} | status=completed`,
      "</claude-runtime-background-task-followup>",
    ].join("\n"),
    user: "system",
    source: "claude_runtime_task_followup",
    deliveryId: identity.deliveryId,
    deliveryIntent: "runtime_followup",
    completionId: identity.completionId,
    relationKey: identity.relationKey,
    producerTerminalRevision: identity.producerTerminalRevision,
    followupTaskIds: [identity.taskId],
  };
}

function makeTask(): Task {
  return {
    agentSessionId: SESSION_ID,
    prompt: "foreground turn that read bqqgtqzwh.output inline",
    status: "running",
    profileId: agent.id,
    createdAt: new Date("2026-08-22T23:35:00.000Z"),
    lastEventId: BQQ.inlineConsumedTurnId,
    lastReadEventId: BQQ.inlineConsumedTurnId,
    interventionQueue: [],
  };
}

function makeRunner() {
  const inbox = new Map<string, InboxRow>();
  const modelInputs: TurnObservation[] = [];
  const completedTurns: TurnObservation[] = [];
  const dispatcher = {
    stageIntervention: vi.fn(async (input: {
      interventionId: string;
      message: Record<string, unknown>;
      queued: boolean;
    }) => {
      inbox.set(input.interventionId, {
        interventionId: input.interventionId,
        message: input.message as unknown as InterventionMessage,
      });
      return {
        durability: "runner" as const,
        eventSourceSeq: null,
        queuePosition: [...inbox.values()].filter((row) => row.message).length,
      };
    }),
    recoverPendingInterventions: vi.fn(async () => [...inbox.values()]),
    executeFrames: vi.fn((params: EngineExecuteParams) => (async function* () {
      const interventionId = params.runnerInterventionId;
      const row = interventionId ? inbox.get(interventionId) : undefined;
      if (interventionId && !row) {
        throw new Error(`execute_intervention_claim_failed:${interventionId}`);
      }
      const observation: TurnObservation = {
        deliveryId: row?.message.deliveryId ?? null,
        relationKey: row?.message.relationKey ?? null,
        prompt: params.prompt,
      };
      modelInputs.push(observation);
      yield engineEventFrame({
        type: "assistant_message",
        content: `handled:${row?.message.deliveryId ?? "initial"}`,
      });
      yield engineEventFrame({
        type: "complete",
        result: "done",
        timestamp: 1,
      });
      completedTurns.push(observation);
      if (interventionId) inbox.delete(interventionId);
    })()),
    prepareSession: vi.fn(async () => undefined),
    waitForSessionAck: vi.fn(async () => null),
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    detachHost: vi.fn(async () => undefined),
    invoke: vi.fn(async () => undefined),
    sendControlFrame: vi.fn(async () => true),
    requestContext: vi.fn(() => undefined),
  };
  const runner: TaskRunnerRuntime = {
    engine: new RunnerProcessEngineProxy(
      "claude",
      agent.workspace_dir,
      dispatcher as never,
    ),
    dispatcher: dispatcher as never,
    eventPersistence: "runner",
  };
  return { runner, dispatcher, inbox, modelInputs, completedTurns };
}

function makeHarness() {
  const task = makeTask();
  const repository = new RelationLedgerRepository([BQQ, BBOX]);
  const ledgerGate = new TaskDeliveryLedgerGate(true, repository as never);
  const persistenceDouble = makeEventPersistenceTestDouble();
  const broadcaster = {
    emitEventEnvelope: vi.fn(async () => undefined),
    emitSessionUpdated: vi.fn(async () => undefined),
  } as unknown as SessionBroadcaster;
  const runnerHarness = makeRunner();
  task.runner = runnerHarness.runner;
  const transition = new RunningInterventionTransition({
    broadcaster,
    logger: silentLogger,
    persistence: persistenceDouble.persistence,
  });
  const db = {
    updateSession: vi.fn(async () => undefined),
    setClaudeSessionId: vi.fn(async () => undefined),
  } as unknown as SessionDB;
  const executor = new TaskExecutor(
    () => runnerHarness.runner.engine,
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
  return {
    task,
    repository,
    ledgerGate,
    transition,
    executor,
    ...runnerHarness,
  };
}

async function queueBothAndConsumeBqq() {
  const harness = makeHarness();
  await harness.transition.queueOnly(
    harness.task,
    historicalMessage(BQQ),
    { publishEvent: false },
  );
  await harness.transition.queueOnly(
    harness.task,
    historicalMessage(BBOX),
    { publishEvent: false },
  );
  const consumed = await harness.ledgerGate.recordInlineConsumed({
    agentSessionId: SESSION_ID,
    ...historicalMessage(BQQ),
  }, harness.task);
  return { ...harness, consumed };
}

async function executeAttachedRunner(
  harness: ReturnType<typeof makeHarness>,
): Promise<void> {
  harness.task.runner = undefined;
  harness.executor.startExecutionWithRunner(harness.task, agent, harness.runner);
  await harness.task.executionPromise;
}

function observationsFor(
  observations: readonly TurnObservation[],
  relationKey: string,
  axis: "model_input" | "completed_turn",
): TurnObservation[] {
  if (
    relationKey === BQQ.relationKey
    && oracleMutation === `hide_${axis}`
  ) {
    return [];
  }
  if (
    relationKey === BQQ.relationKey
    && oracleMutation === "global_relation_count"
  ) {
    return [...observations];
  }
  return observations.filter((observation) => observation.relationKey === relationKey);
}

function inboxRelations(inbox: ReadonlyMap<string, InboxRow>): Array<string | undefined> {
  const relations = [...inbox.values()].map((row) => row.message.relationKey);
  return oracleMutation === "hide_runner_inbox"
    ? relations.filter((relationKey) => relationKey !== BQQ.relationKey)
    : relations;
}

describe("consumed Claude runtime relation invalidates queued delivery", () => {
  it("records one bqq central consume without consuming the bbox relation", async () => {
    const harness = await queueBothAndConsumeBqq();

    expect(harness.consumed).toBe(true);
    expect(harness.repository.rows.get(BQQ.deliveryId)).toMatchObject({
      state: "consumed",
      caller_turn_id: `event:${BQQ.inlineConsumedTurnId}`,
    });
    expect(harness.repository.consumedTransitions.get(BQQ.relationKey)).toBe(1);
    expect(harness.repository.rows.get(BBOX.deliveryId)?.state).toBe("delivered");
    expect(harness.repository.consumedTransitions.get(BBOX.relationKey)).toBeUndefined();
  });

  it("invalidates bqq in the already queued runner inbox at inline consume", async () => {
    const harness = await queueBothAndConsumeBqq();
    const relations = inboxRelations(harness.inbox);

    expect(relations).not.toContain(BQQ.relationKey);
    expect(relations).toContain(BBOX.relationKey);
  });

  it("injects and completes bbox once but creates no post-consume bqq turn", async () => {
    const harness = await queueBothAndConsumeBqq();
    await executeAttachedRunner(harness);

    expect(observationsFor(harness.modelInputs, BQQ.relationKey, "model_input"))
      .toHaveLength(0);
    expect(observationsFor(harness.completedTurns, BQQ.relationKey, "completed_turn"))
      .toHaveLength(0);
    expect(observationsFor(harness.modelInputs, BBOX.relationKey, "model_input"))
      .toHaveLength(1);
    expect(observationsFor(harness.completedTurns, BBOX.relationKey, "completed_turn"))
      .toHaveLength(1);
  });

  it("restart restore discards consumed bqq inbox state and executes bbox once", async () => {
    const harness = await queueBothAndConsumeBqq();
    harness.task.interventionQueue = harness.task.interventionQueue.filter(
      (message) => message.relationKey === BBOX.relationKey,
    );
    await executeAttachedRunner(harness);

    expect(inboxRelations(harness.inbox))
      .not.toContain(BQQ.relationKey);
    expect(observationsFor(harness.modelInputs, BQQ.relationKey, "model_input"))
      .toHaveLength(0);
    expect(observationsFor(harness.completedTurns, BQQ.relationKey, "completed_turn"))
      .toHaveLength(0);
    expect(observationsFor(harness.modelInputs, BBOX.relationKey, "model_input"))
      .toHaveLength(1);
    expect(observationsFor(harness.completedTurns, BBOX.relationKey, "completed_turn"))
      .toHaveLength(1);
  });

  it("does not attribute an unrelated bbox turn to the consumed bqq relation", async () => {
    const harness = await queueBothAndConsumeBqq();
    harness.task.interventionQueue = harness.task.interventionQueue.filter(
      (message) => message.relationKey === BBOX.relationKey,
    );
    harness.inbox.delete(BQQ.deliveryId);
    await executeAttachedRunner(harness);

    expect(observationsFor(harness.modelInputs, BQQ.relationKey, "model_input"))
      .toHaveLength(0);
    expect(observationsFor(harness.completedTurns, BQQ.relationKey, "completed_turn"))
      .toHaveLength(0);
    expect(observationsFor(harness.modelInputs, BBOX.relationKey, "model_input"))
      .toHaveLength(1);
    expect(observationsFor(harness.completedTurns, BBOX.relationKey, "completed_turn"))
      .toHaveLength(1);
  });
});
