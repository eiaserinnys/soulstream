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
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });
const SESSION_ID = "7977b1fe-4bb5-4491-bd66-b43946b19d6c";
const DELIVERY_ID = "415fc3ff-8525-5e0c-a584-fae655a545e1";
const RELATION_KEY = `claude_runtime:${SESSION_ID}:bqqgtqzwh`;
const COMPLETION_ID =
  "completion:6d9ee252b5d7127e22fa24a53e44dead5d456d9fb7c7384378bf755e6bc469de";

const agent: AgentProfile = {
  id: "claude-roselin",
  name: "로젤린",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
};

class DeliveryRepositoryDouble {
  readonly row = makeDeliveryRow();

  readonly get = vi.fn(async (deliveryId: string) =>
    deliveryId === DELIVERY_ID ? this.row : null);

  readonly register = vi.fn(async () => ({
    row: this.row,
    inserted: false,
    conflict: false,
  }));

  readonly markConsumedByRelation = vi.fn(async (
    relationKey: string,
    completionId: string,
    callerTurnId: string,
  ) => {
    if (relationKey !== RELATION_KEY || completionId !== COMPLETION_ID) return null;
    this.row.state = "consumed";
    this.row.aggregate_state = "consumed";
    this.row.caller_turn_id = callerTurnId;
    return this.row;
  });
}

function makeDeliveryRow(): SessionDeliveryRow {
  return {
    delivery_id: DELIVERY_ID,
    target_session_id: SESSION_ID,
    relation_key: RELATION_KEY,
    completion_id: COMPLETION_ID,
    intent: "runtime_followup",
    source: "claude_runtime_task_followup",
    producer_terminal_revision: "1787441739424",
    state: "delivered",
    aggregate_state: "delivered",
    target_receipt_id: "event:689",
    caller_turn_id: null,
    payload: {
      text: message().text,
      user: "system",
      attachment_paths: null,
      context: null,
      caller_info: null,
      followup_task_ids: ["bqqgtqzwh"],
    },
    payload_hash: `historical:${DELIVERY_ID}`,
  } as SessionDeliveryRow;
}

function message(): InterventionMessage {
  return {
    text: "background bqqgtqzwh completed",
    user: "system",
    source: "claude_runtime_task_followup",
    deliveryId: DELIVERY_ID,
    deliveryIntent: "runtime_followup",
    completionId: COMPLETION_ID,
    relationKey: RELATION_KEY,
    producerTerminalRevision: "1787441739424",
    followupTaskIds: ["bqqgtqzwh"],
    runnerInterventionId: DELIVERY_ID,
  };
}

function makeTask(queued = true): Task {
  return {
    agentSessionId: SESSION_ID,
    prompt: "foreground turn already observed bqqgtqzwh inline",
    status: "running",
    profileId: agent.id,
    createdAt: new Date("2026-08-22T23:35:00.000Z"),
    lastEventId: 698,
    lastReadEventId: 698,
    interventionQueue: queued ? [message()] : [],
  };
}

function makeRunner(input: {
  inbox: Map<string, InterventionMessage>;
  failDiscardOnce?: boolean;
  includeDiscard?: boolean;
}) {
  let discardFailuresRemaining = input.failDiscardOnce ? 1 : 0;
  const modelInputRelations: Array<string | undefined> = [];
  const discardIntervention = vi.fn(async (interventionId: string) => {
    if (discardFailuresRemaining > 0) {
      discardFailuresRemaining -= 1;
      throw new Error("injected durable discard failure");
    }
    input.inbox.delete(interventionId);
  });
  const dispatcher = {
    ...(input.includeDiscard === false ? {} : { discardIntervention }),
    recoverPendingInterventions: vi.fn(async () => [...input.inbox.entries()].map(
      ([interventionId, queuedMessage]) => ({
        interventionId,
        message: queuedMessage as unknown as Record<string, unknown>,
      }),
    )),
    executeFrames: vi.fn((params: EngineExecuteParams) => (async function* () {
      const queuedMessage = params.runnerInterventionId
        ? input.inbox.get(params.runnerInterventionId)
        : undefined;
      modelInputRelations.push(queuedMessage?.relationKey);
      yield engineEventFrame({ type: "assistant_message", content: "done" });
      yield engineEventFrame({ type: "complete", result: "done", timestamp: 1 });
      if (params.runnerInterventionId) input.inbox.delete(params.runnerInterventionId);
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
  return { runner, dispatcher, discardIntervention, modelInputRelations };
}

function makeExecutor(
  runner: TaskRunnerRuntime,
  ledgerGate: TaskDeliveryLedgerGate,
): TaskExecutor {
  const persistenceDouble = makeEventPersistenceTestDouble();
  const broadcaster = {
    emitEventEnvelope: vi.fn(async () => undefined),
    emitSessionUpdated: vi.fn(async () => undefined),
  } as unknown as SessionBroadcaster;
  const db = {
    updateSession: vi.fn(async () => undefined),
    setClaudeSessionId: vi.fn(async () => undefined),
  } as unknown as SessionDB;
  return new TaskExecutor(
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
}

describe("consumed Claude runtime durable inbox recovery", () => {
  it("converges on restart after the first durable discard attempt fails", async () => {
    const repository = new DeliveryRepositoryDouble();
    const ledgerGate = new TaskDeliveryLedgerGate(true, repository as never);
    const inbox = new Map([[DELIVERY_ID, message()]]);
    const runnerHarness = makeRunner({ inbox, failDiscardOnce: true });
    const inlineTask = makeTask();
    inlineTask.runner = runnerHarness.runner;

    let inlineFailure: unknown;
    try {
      await ledgerGate.recordInlineConsumed(message(), inlineTask);
    } catch (error) {
      inlineFailure = error;
    }

    const restartedTask = makeTask(false);
    const executor = makeExecutor(runnerHarness.runner, ledgerGate);
    executor.startExecutionWithRunner(restartedTask, agent, runnerHarness.runner);
    await restartedTask.executionPromise;

    expect(inlineFailure).toEqual(new Error("injected durable discard failure"));
    expect(repository.row.state).toBe("consumed");
    expect(runnerHarness.discardIntervention).toHaveBeenCalledTimes(2);
    expect(inbox.has(DELIVERY_ID)).toBe(false);
    expect(runnerHarness.modelInputRelations).not.toContain(RELATION_KEY);
  });

  it("fails hard when the runner cannot discard a consumed intervention", async () => {
    const repository = new DeliveryRepositoryDouble();
    const ledgerGate = new TaskDeliveryLedgerGate(true, repository as never);
    const inbox = new Map([[DELIVERY_ID, message()]]);
    const runnerHarness = makeRunner({ inbox, includeDiscard: false });
    const task = makeTask();
    task.runner = runnerHarness.runner;

    await expect(ledgerGate.recordInlineConsumed(message(), task)).rejects.toThrow(
      "runner intervention discard operation is unavailable",
    );
    expect(repository.row.state).toBe("consumed");
    expect(inbox.has(DELIVERY_ID)).toBe(true);
  });
});
