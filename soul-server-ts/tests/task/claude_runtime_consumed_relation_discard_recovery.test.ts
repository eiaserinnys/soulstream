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
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
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
  readonly row = {
    delivery_id: DELIVERY_ID,
    target_session_id: SESSION_ID,
    relation_key: RELATION_KEY,
    completion_id: COMPLETION_ID,
    intent: "runtime_followup",
    source: "claude_runtime_task_followup",
    state: "queued",
    aggregate_state: "pending",
    target_receipt_id: null,
  } as SessionDeliveryRow;

  readonly get = vi.fn(async () => this.row);
  readonly recordRelationConsumed = vi.fn(async () => undefined);
  readonly markConsumed = vi.fn(async (
    _deliveryId: string,
    targetReceiptId: string,
  ) => {
    this.row.state = "consumed";
    this.row.aggregate_state = "consumed";
    this.row.target_receipt_id = targetReceiptId;
    return this.row;
  });
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
  };
}

describe("queued Claude runtime delivery consumption", () => {
  it("keeps an exact next-turn delivery without runner identity until that turn sees it", async () => {
    const repository = new DeliveryRepositoryDouble();
    const ledgerGate = new TaskDeliveryLedgerGate(true, repository as never);
    const persistence = makeEventPersistenceTestDouble();
    const discardIntervention = vi.fn(async () => undefined);
    const dispatcher = {
      recoverPendingInterventions: vi.fn(async () => []),
      discardIntervention,
      executeFrames: vi.fn((_params: EngineExecuteParams) => (async function* () {
        yield engineEventFrame({ type: "assistant_message", content: "follow-up seen" });
        yield engineEventFrame(
          { type: "result", success: true, output: "follow-up handled" },
          {
            claudeResultReceipt: {
              inputUuid: buildDeliveryInputUuid(DELIVERY_ID),
            },
          },
        );
        yield engineEventFrame({ type: "complete", result: "follow-up handled" });
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
    const task: Task = {
      agentSessionId: SESSION_ID,
      prompt: "foreground turn",
      status: "running",
      profileId: agent.id,
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
      lastEventId: 698,
      lastReadEventId: 698,
      interventionQueue: [message()],
    };
    const executor = new TaskExecutor(
      () => runner.engine,
      {
        updateSession: vi.fn(async () => undefined),
        setClaudeSessionId: vi.fn(async () => undefined),
      } as unknown as SessionDB,
      persistence.persistence,
      {
        emitEventEnvelope: vi.fn(async () => undefined),
        emitSessionUpdated: vi.fn(async () => undefined),
      } as unknown as SessionBroadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      ledgerGate,
    );

    expect(repository.row.state).toBe("queued");
    expect(runner.eventPersistence).toBe("runner");
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.interventionQueue[0]?.runnerInterventionId).toBeUndefined();
    expect(discardIntervention).not.toHaveBeenCalled();

    executor.startExecutionWithRunner(task, agent, runner);
    await task.executionPromise;

    expect(repository.row.state).toBe("consumed");
    expect(repository.markConsumed).toHaveBeenCalledOnce();
    expect(task.interventionQueue).toEqual([]);
    expect(discardIntervention).not.toHaveBeenCalled();
    expect(persistence.enqueueEvent.mock.calls.some(
      (call) => (call[1] as { error_code?: string }).error_code ===
        "claude_runtime_followup_enqueue_failed",
    )).toBe(false);
  });
});
