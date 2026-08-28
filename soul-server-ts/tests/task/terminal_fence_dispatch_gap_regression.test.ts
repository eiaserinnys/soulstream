import pino from "pino";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile, AgentRegistry } from "../../src/agent_registry.js";
import type { SessionMutationHost } from
  "../../src/control_plane/persistence_host_clients.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { createInProcessTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { buildCanonicalDeliveryPayload } from "../../src/task/delivery_payload.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";
import {
  CALLER_SESSION_ID,
  deliveryParams,
  MemoryDeliveryRepository,
  SESSION_ID,
} from "./terminal_fence_intervention_dedupe_harness.js";

const DELIVERY_ID = "dispatch-gap-retry-delivery";
const TEXT = "persisted before queued-state CAS failed";
const PRE_PUBLISH_DELIVERY_ID = "pre-publish-gap-retry-delivery";
const PRE_PUBLISH_TEXT = "persistence failed before intervention event append";
const PRE_REGISTERED_DELIVERY_ID = "upstream-pre-registered-fresh-delivery";
const PRE_REGISTERED_TEXT = "genuinely fresh upstream delivery";
const AGENT: AgentProfile = {
  id: "terminal-fence-dispatch-gap-agent",
  name: "Terminal fence dispatch gap",
  backend: "codex",
  workspace_dir: "/tmp/terminal-fence-dispatch-gap",
};
const logger = pino({ level: "silent" });

describe("terminal fence dispatch persistence gap", () => {
  it("recognizes the existing delivery after persistence succeeds and markQueued fails", async () => {
    const {
      broadcaster,
      db,
      params,
      persistence,
      repository,
      task,
      taskManager,
    } = await createRunningBoundary(DELIVERY_ID, TEXT);
    repository.markQueued.mockImplementationOnce(async () => null);
    await expect(taskManager.addIntervention(params, vi.fn())).rejects.toThrow(
      `Delivery ${DELIVERY_ID} lost queued-state CAS`,
    );
    expect(repository.markQueued).toHaveBeenCalledTimes(1);
    expect(interventionSentCount(persistence.enqueueEvent.mock.calls, TEXT)).toBe(1);
    expect(persistence.enqueueEvent.mock.calls[0]?.[1]).toMatchObject({
      _dedupe_key: `intervention_sent:${DELIVERY_ID}`,
    });
    expect(repository.row(DELIVERY_ID)).toMatchObject({
      state: "dispatching",
      aggregate_state: "pending",
      queued_at: null,
    });

    repository.forcePendingRetry(DELIVERY_ID);
    expect(repository.row(DELIVERY_ID)).toMatchObject({
      state: "pending",
      aggregate_state: "pending",
      queued_at: null,
    });
    await expect(taskManager.cancelTask(SESSION_ID)).resolves.toBe(true);
    const terminalRevision = task.terminalEventId;
    expect(terminalRevision).toBeDefined();

    const runtime = startRuntime(taskManager, task, db, persistence.persistence, broadcaster);
    try {
      await expect(taskManager.addIntervention(params, runtime.onResume)).resolves.toMatchObject({
        delivered: false,
        queued: true,
      });
      await setImmediate();
      await setImmediate();

      const row = repository.row(DELIVERY_ID);
      expect(repository.register).toHaveBeenCalledTimes(1);
      expect(repository.markQueued).toHaveBeenCalledTimes(2);
      expect({
        interventionSentEffects:
          interventionSentCount(persistence.enqueueEvent.mock.calls, TEXT),
        automaticStarts: runtime.automaticStart.mock.calls.length,
        executionAcquires:
          persistence.acquireExecutionOwnershipAndWaitForApplication.mock.calls.length,
        turnStarts: runtime.turnStarted.mock.calls.length,
        modelCalls: runtime.modelCall.mock.calls.length,
        taskStatus: task.status,
        terminalRevision: task.terminalEventId,
        ledgerState: row.state,
        aggregateState: row.aggregate_state,
      }).toEqual({
        interventionSentEffects: 1,
        automaticStarts: 0,
        executionAcquires: 0,
        turnStarts: 0,
        modelCalls: 0,
        taskStatus: "interrupted",
        terminalRevision,
        ledgerState: "queued",
        aggregateState: "pending",
      });
    } finally {
      runtime.release();
    }
  });

  it("retries semantic publication after persistence fails before the first append", async () => {
    const {
      broadcaster,
      db,
      params,
      persistence,
      repository,
      task,
      taskManager,
    } = await createRunningBoundary(PRE_PUBLISH_DELIVERY_ID, PRE_PUBLISH_TEXT);
    const persistenceAttempts = vi.spyOn(persistence.persistence, "enqueueEvent")
      .mockRejectedValueOnce(new Error("intervention event persistence unavailable"));

    await expect(taskManager.addIntervention(params, vi.fn())).rejects.toThrow(
      "intervention event persistence unavailable",
    );
    expect(repository.markQueued).not.toHaveBeenCalled();
    expect(interventionSentCount(
      persistence.enqueueEvent.mock.calls,
      PRE_PUBLISH_TEXT,
    )).toBe(0);
    expect(repository.row(PRE_PUBLISH_DELIVERY_ID)).toMatchObject({
      state: "dispatching",
      aggregate_state: "pending",
      queued_at: null,
    });

    repository.forcePendingRetry(PRE_PUBLISH_DELIVERY_ID);
    await expect(taskManager.cancelTask(SESSION_ID)).resolves.toBe(true);
    const terminalRevision = task.terminalEventId;
    expect(terminalRevision).toBeDefined();

    const runtime = startRuntime(taskManager, task, db, persistence.persistence, broadcaster);
    try {
      await expect(taskManager.addIntervention(params, runtime.onResume)).resolves.toMatchObject({
        delivered: false,
        queued: true,
      });
      await setImmediate();
      await setImmediate();

      const row = repository.row(PRE_PUBLISH_DELIVERY_ID);
      expect(persistenceAttempts).toHaveBeenCalledTimes(2);
      expect(repository.register).toHaveBeenCalledTimes(1);
      expect(repository.markQueued).toHaveBeenCalledTimes(1);
      expect(findInterventionEvent(
        persistence.enqueueEvent.mock.calls,
        PRE_PUBLISH_TEXT,
      )).toMatchObject({
        _dedupe_key: `intervention_sent:${PRE_PUBLISH_DELIVERY_ID}`,
      });
      expect({
        interventionSentEffects: interventionSentCount(
          persistence.enqueueEvent.mock.calls,
          PRE_PUBLISH_TEXT,
        ),
        automaticStarts: runtime.automaticStart.mock.calls.length,
        executionAcquires:
          persistence.acquireExecutionOwnershipAndWaitForApplication.mock.calls.length,
        turnStarts: runtime.turnStarted.mock.calls.length,
        modelCalls: runtime.modelCall.mock.calls.length,
        taskStatus: task.status,
        terminalRevision: task.terminalEventId,
        ledgerState: row.state,
        aggregateState: row.aggregate_state,
      }).toEqual({
        interventionSentEffects: 1,
        automaticStarts: 0,
        executionAcquires: 0,
        turnStarts: 0,
        modelCalls: 0,
        taskStatus: "interrupted",
        terminalRevision,
        ledgerState: "queued",
        aggregateState: "pending",
      });
    } finally {
      runtime.release();
    }
  });

  it("allows one execution for a genuinely fresh upstream pre-registration", async () => {
    const {
      broadcaster,
      db,
      params,
      persistence,
      repository,
      task,
      taskManager,
    } = await createRunningBoundary(PRE_REGISTERED_DELIVERY_ID, PRE_REGISTERED_TEXT);
    await preRegister(repository, params);
    await expect(taskManager.cancelTask(SESSION_ID)).resolves.toBe(true);

    const runtime = startRuntime(taskManager, task, db, persistence.persistence, broadcaster);
    try {
      await expect(taskManager.addIntervention(params, runtime.onResume)).resolves.toEqual({
        autoResumed: true,
      });
      await setImmediate();
      await setImmediate();

      expect(repository.register).toHaveBeenCalledTimes(1);
      expect({
        semanticEffects: semanticTextEventCount(
          persistence.enqueueEvent.mock.calls,
          PRE_REGISTERED_TEXT,
        ),
        automaticStarts: runtime.automaticStart.mock.calls.length,
        executionAcquires:
          persistence.acquireExecutionOwnershipAndWaitForApplication.mock.calls.length,
        turnStarts: runtime.turnStarted.mock.calls.length,
        modelCalls: runtime.modelCall.mock.calls.length,
      }).toEqual({
        semanticEffects: 1,
        automaticStarts: 1,
        executionAcquires: 1,
        turnStarts: 1,
        modelCalls: 1,
      });
    } finally {
      runtime.release();
    }
  });
});

async function createRunningBoundary(deliveryId: string, text: string) {
  const repository = new MemoryDeliveryRepository();
  const persistence = makeEventPersistenceTestDouble();
  const db = makeDb(repository);
  const broadcaster = makeBroadcaster();
  const taskManager = new TaskManager(
    "eiaserinnys",
    db,
    broadcaster,
    logger,
    persistence.persistence,
    undefined,
    makeAgentRegistry(),
    undefined,
    undefined,
    true,
    undefined,
    undefined,
    makeSessionMutations(),
  );
  const task = await taskManager.createTask({
    agentSessionId: SESSION_ID,
    prompt: "foreground turn",
    profileId: AGENT.id,
    agentProfileSnapshot: AGENT,
    callerSessionId: CALLER_SESSION_ID,
  });
  task.status = "running";
  task.lastEventId = 100;
  task.runner = createInProcessTaskRunnerRuntime(makeLiveEngine());
  vi.spyOn(task.runner.dispatcher, "hasActiveExecution").mockReturnValue(true);
  task.executionPromise = Promise.resolve();
  return {
    broadcaster,
    db,
    params: deliveryParams(deliveryId, text),
    persistence,
    repository,
    task,
    taskManager,
  };
}

async function preRegister(
  repository: MemoryDeliveryRepository,
  params: ReturnType<typeof deliveryParams>,
): Promise<void> {
  if (!params.deliveryId || !params.completionId || !params.relationKey) {
    throw new Error("test delivery identity is incomplete");
  }
  const source = params.source ?? "user_message";
  const canonical = buildCanonicalDeliveryPayload({
    text: params.text,
    user: params.user,
    source,
    completionId: params.completionId,
    relationKey: params.relationKey,
    callerInfo: params.callerInfo,
  });
  await repository.register({
    deliveryId: params.deliveryId,
    targetSessionId: params.agentSessionId,
    relationKey: params.relationKey,
    completionId: params.completionId,
    intent: "human_live_steer",
    source,
    payloadHash: canonical.payloadHash,
    payload: canonical.payload,
  });
}

function startRuntime(
  taskManager: TaskManager,
  task: Task,
  db: SessionDB,
  persistence: ReturnType<typeof makeEventPersistenceTestDouble>["persistence"],
  broadcaster: SessionBroadcaster,
) {
  const turnStarted = vi.spyOn(
    taskManager.getDeliveryConsumptionRecorder()!,
    "recordTurnStarted",
  );
  const modelCall = vi.fn();
  const automaticStart = vi.fn();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor = new TaskExecutor(
    () => makeModelEngine(modelCall, barrier),
    db,
    persistence,
    broadcaster,
    logger,
    undefined,
    undefined,
    undefined,
    undefined,
    taskManager.getDeliveryConsumptionRecorder(),
  );
  const onResume = vi.fn((resumed: Task, activation) => {
    automaticStart();
    return executor.startExecution(resumed, AGENT, activation);
  });
  return { automaticStart, modelCall, onResume, release, turnStarted };
}

function makeDb(repository: MemoryDeliveryRepository): SessionDB {
  return {
    getFolderById: vi.fn(async () => null),
    getBoardItems: vi.fn(async () => []),
    getSession: vi.fn(async () => null),
    sessionDeliveries: vi.fn(() => repository),
  } as unknown as SessionDB;
}

function makeBroadcaster(): SessionBroadcaster {
  return {
    emitSessionCreated: vi.fn(async () => undefined),
    emitSessionDeleted: vi.fn(async () => undefined),
    emitCatalogUpdated: vi.fn(async () => undefined),
    emitEventEnvelope: vi.fn(async () => undefined),
    emitSessionUpdated: vi.fn(async () => undefined),
  } as unknown as SessionBroadcaster;
}

function makeSessionMutations(): SessionMutationHost {
  return {
    registerSession: vi.fn(async () => undefined),
    transitionSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    acknowledgeReview: vi.fn(async () => "not_required" as const),
  };
}

function makeAgentRegistry(): AgentRegistry {
  return { get: vi.fn(() => AGENT) } as unknown as AgentRegistry;
}

function makeLiveEngine(): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: AGENT.workspace_dir,
    async *execute(): AsyncIterable<SSEEventPayload> {},
    async intervene() {
      return {
        status: "not_delivered",
        mechanism: "interrupt_then_next_turn",
        reason: "next_turn_required",
      };
    },
    async interrupt() { return true; },
    async close() {},
  };
}

function makeModelEngine(modelCall: () => void, barrier: Promise<void>): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: AGENT.workspace_dir,
    async *execute(): AsyncIterable<SSEEventPayload> {
      modelCall();
      yield {
        type: "assistant_message",
        content: "model turn opened by dispatch gap retry",
        timestamp: 1,
      } as SSEEventPayload;
      await barrier;
    },
    async intervene() {
      return {
        status: "not_delivered",
        mechanism: "interrupt_then_next_turn",
        reason: "next_turn_required",
      };
    },
    async interrupt() { return true; },
    async close() {},
  };
}

function interventionSentCount(calls: unknown[][], text: string): number {
  return calls.filter((call) => {
    const event = call[1] as Record<string, unknown> | undefined;
    return event?.type === "intervention_sent" && event.text === text;
  }).length;
}

function findInterventionEvent(
  calls: unknown[][],
  text: string,
): Record<string, unknown> | undefined {
  return calls
    .map((call) => call[1] as Record<string, unknown> | undefined)
    .find((event) => event?.type === "intervention_sent" && event.text === text);
}

function semanticTextEventCount(calls: unknown[][], text: string): number {
  return calls.filter((call) => {
    const event = call[1] as Record<string, unknown> | undefined;
    return (event?.type === "intervention_sent" || event?.type === "user_message")
      && event.text === text;
  }).length;
}
