import pino from "pino";
import { vi } from "vitest";

import type { AgentProfile, AgentRegistry } from "../../src/agent_registry.js";
import type { SessionMutationHost } from
  "../../src/control_plane/persistence_host_clients.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
} from "../../src/db/session_db_types.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { createInProcessTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { AddInterventionParams } from
  "../../src/task/task_intervention_route.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

export const SESSION_ID = "terminal-fence-product-session";
export const CALLER_SESSION_ID = "canonical-caller-session";
export const RETRY_DELIVERY_ID = "pre-stop-retry-delivery";
export const RETRY_TEXT = "accepted before user_stop and retried afterward";

const AGENT: AgentProfile = {
  id: "terminal-fence-agent",
  name: "Terminal fence product harness",
  backend: "codex",
  workspace_dir: "/tmp/terminal-fence-product-harness",
};

const logger = pino({ level: "silent" });

export interface RuntimeCounters {
  automaticStarts: number;
  executionAcquires: number;
  turnStarts: number;
  modelCalls: number;
}

export interface ProductHarness {
  taskManager: TaskManager;
  task: Task;
  repository: MemoryDeliveryRepository;
  interventionSentCount(): number;
  retryParams: AddInterventionParams;
  terminalRevision: number;
  startRuntime(): {
    counters(): RuntimeCounters;
    onResume: Parameters<TaskManager["addIntervention"]>[1];
    release(): void;
  };
}

export async function createStoppedProductHarness(): Promise<ProductHarness> {
  const repository = new MemoryDeliveryRepository();
  const persistenceDouble = makeEventPersistenceTestDouble();
  const db = makeDb(repository);
  const broadcaster = makeBroadcaster();
  const taskManager = new TaskManager(
    "eiaserinnys",
    db,
    broadcaster,
    logger,
    persistenceDouble.persistence,
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

  const retryParams = deliveryParams(RETRY_DELIVERY_ID, RETRY_TEXT);
  await taskManager.addIntervention(retryParams, vi.fn());
  const initialEffects = countInterventionSent(
    persistenceDouble.enqueueEvent.mock.calls,
    RETRY_TEXT,
  );
  if (initialEffects !== 1) {
    throw new Error(`product harness expected one initial intervention_sent, got ${initialEffects}`);
  }
  if (!await taskManager.cancelTask(SESSION_ID)) {
    throw new Error("product harness could not converge user_stop");
  }
  const terminalRevision = task.terminalEventId;
  if (terminalRevision === undefined || task.status !== "interrupted") {
    throw new Error("product harness did not reach canonical user_stop terminal");
  }
  repository.forcePendingRetry(RETRY_DELIVERY_ID);

  return {
    taskManager,
    task,
    repository,
    retryParams,
    terminalRevision,
    interventionSentCount: () => countInterventionSent(
      persistenceDouble.enqueueEvent.mock.calls,
      RETRY_TEXT,
    ),
    startRuntime: () => {
      const turnStarted = vi.spyOn(
        taskManager.getDeliveryConsumptionRecorder()!,
        "recordTurnStarted",
      );
      const modelCall = vi.fn();
      const automaticStart = vi.fn();
      let releaseTurn!: () => void;
      const turnBarrier = new Promise<void>((resolve) => {
        releaseTurn = resolve;
      });
      const engine = makeModelEngine(modelCall, turnBarrier);
      const executor = new TaskExecutor(
        () => engine,
        db,
        persistenceDouble.persistence,
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
      return {
        onResume,
        release: releaseTurn,
        counters: (): RuntimeCounters => ({
          automaticStarts: automaticStart.mock.calls.length,
          executionAcquires:
            persistenceDouble.acquireExecutionOwnershipAndWaitForApplication.mock.calls.length,
          turnStarts: turnStarted.mock.calls.length,
          modelCalls: modelCall.mock.calls.length,
        }),
      };
    },
  };
}

export function deliveryParams(deliveryId: string, text: string): AddInterventionParams {
  return {
    agentSessionId: SESSION_ID,
    text,
    user: "alice",
    source: "user_message",
    deliveryId,
    deliveryIntent: "human_live_steer",
    completionId: `message:${deliveryId}`,
    relationKey: `user_message:${SESSION_ID}:${deliveryId}`,
    callerInfo: {
      source: "agent",
      agent_session_id: CALLER_SESSION_ID,
    },
  };
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
        content: "model turn opened by retry",
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

function countInterventionSent(calls: unknown[][], text: string): number {
  return calls.filter((call) => {
    const event = call[1] as Record<string, unknown> | undefined;
    return event?.type === "intervention_sent" && event.text === text;
  }).length;
}

export class MemoryDeliveryRepository {
  private readonly rows = new Map<string, SessionDeliveryRow>();

  readonly notifications = {
    stageWithQueuedDelivery: vi.fn(),
    get: vi.fn(),
    markPublished: vi.fn(),
    retry: vi.fn(),
  };

  readonly get = vi.fn(async (deliveryId: string) => this.rows.get(deliveryId) ?? null);

  readonly register = vi.fn(async (params: RegisterSessionDeliveryParams) => {
    const existing = this.rows.get(params.deliveryId);
    if (existing) return { row: existing, inserted: false, conflict: false };
    const row = deliveryRow(params);
    this.rows.set(row.delivery_id, row);
    return { row, inserted: true, conflict: false };
  });

  readonly claimForTarget = vi.fn(async (
    deliveryId: string,
    targetSessionId: string,
    leaseOwner: string,
  ) => this.update(deliveryId, ["pending", "queued"], (row) => ({
    ...row,
    target_session_id: targetSessionId,
    state: "claimed",
    claimed_at: new Date(),
    lease_owner: leaseOwner,
    lease_expires_at: new Date(Date.now() + 15_000),
  })));

  readonly beginDispatch = vi.fn(async (deliveryId: string, leaseOwner?: string) =>
    this.update(deliveryId, ["claimed"], (row) =>
      leaseOwner && row.lease_owner !== leaseOwner ? null : {
        ...row,
        state: "dispatching",
        dispatching_at: new Date(),
      }));

  readonly markQueued = vi.fn(async (deliveryId: string, leaseOwner?: string) =>
    this.update(deliveryId, ["dispatching"], (row) =>
      leaseOwner && row.lease_owner !== leaseOwner ? null : {
        ...row,
        state: "queued",
        aggregate_state: "pending",
        queued_at: new Date(),
      }));

  readonly retryLeasedDelivery = vi.fn(async (deliveryId: string, leaseOwner: string) =>
    this.update(deliveryId, ["claimed", "dispatching", "queued"], (row) =>
      row.lease_owner !== leaseOwner ? null : pendingRetry(row)));

  readonly markConsumed = vi.fn(async (deliveryId: string, receiptId: string) =>
    this.update(deliveryId, ["pending", "claimed", "delivered", "queued"], (row) => ({
      ...row,
      state: "consumed",
      aggregate_state: "consumed",
      target_receipt_id: receiptId,
      consumed_at: new Date(),
    })));

  readonly markDelivered = vi.fn();
  readonly markUncertain = vi.fn();
  readonly markConsumedByRelation = vi.fn();
  readonly recordRelationConsumed = vi.fn();
  readonly markPendingSuperseded = vi.fn();

  forcePendingRetry(deliveryId: string): void {
    const row = this.rows.get(deliveryId);
    if (!row) throw new Error(`delivery not found: ${deliveryId}`);
    this.rows.set(deliveryId, pendingRetry(row));
  }

  row(deliveryId: string): SessionDeliveryRow {
    const row = this.rows.get(deliveryId);
    if (!row) throw new Error(`delivery not found: ${deliveryId}`);
    return row;
  }

  count(deliveryId: string): number {
    return Number(this.rows.has(deliveryId));
  }

  private update(
    deliveryId: string,
    allowed: SessionDeliveryRow["state"][],
    project: (row: SessionDeliveryRow) => SessionDeliveryRow | null,
  ): SessionDeliveryRow | null {
    const row = this.rows.get(deliveryId);
    if (!row || !allowed.includes(row.state)) return null;
    const next = project(row);
    if (!next) return null;
    next.updated_at = new Date();
    this.rows.set(deliveryId, next);
    return next;
  }
}

function pendingRetry(row: SessionDeliveryRow): SessionDeliveryRow {
  return {
    ...row,
    state: "pending",
    aggregate_state: "pending",
    lease_owner: null,
    lease_expires_at: null,
    attempt_count: row.attempt_count + 1,
    next_attempt_at: new Date(),
    last_error: "queued_transcript_input_absent",
  };
}

function deliveryRow(params: RegisterSessionDeliveryParams): SessionDeliveryRow {
  const createdAt = params.createdAt ?? new Date("2026-08-28T00:00:00.000Z");
  return {
    delivery_id: params.deliveryId,
    target_session_id: params.targetSessionId ?? null,
    source_session_id: params.sourceSessionId ?? null,
    relation_key: params.relationKey,
    completion_id: params.completionId ?? null,
    intent: params.intent,
    source: params.source,
    producer_kind: params.producerKind ?? null,
    producer_id: params.producerId ?? null,
    producer_terminal_revision: params.producerTerminalRevision ?? null,
    parent_delivery_id: params.parentDeliveryId ?? null,
    caller_turn_id: params.callerTurnId ?? null,
    payload_hash: params.payloadHash,
    payload: params.payload,
    state: "pending",
    aggregate_state: "pending",
    created_at: createdAt,
    updated_at: createdAt,
    claimed_at: null,
    dispatching_at: null,
    lease_owner: null,
    lease_expires_at: null,
    attempt_count: 0,
    next_attempt_at: createdAt,
    last_error: null,
    queued_at: null,
    delivered_at: null,
    consumed_at: null,
    superseded_at: null,
    superseded_terminal_revision: null,
    target_receipt_id: null,
    target_receipt_at: null,
    consumed_reason: null,
    dead_letter_reason: null,
    dead_lettered_at: null,
  };
}
