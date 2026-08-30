import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";

import { SessionDeliveryRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import { SessionMutationRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_mutation_repository.js";
import { createLiveDbSqlResolver, type LivePostgresSql } from
  "../../../orch-server-ts/src/runtime/live_db_sql.js";
import { createLiveSessionHistoryProvider } from
  "../../../orch-server-ts/src/runtime/live_session_history_provider.js";
import { registerSessionHistoryRoutes } from
  "../../../orch-server-ts/src/session/session_history_routes.js";
import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import { SessionDB } from "../../src/db/session_db.js";
import type { EngineExecuteParams, EnginePort, SSEEventPayload } from
  "../../src/engine/protocol.js";
import { TaskCompletionNotifier } from "../../src/task/completion_notifier.js";
import {
  buildDeliveryInputUuid,
  buildDeterministicDeliveryIdentity,
} from "../../src/task/delivery_identity.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { TaskDeliveryLedgerGate } from "../../src/task/task_delivery_ledger_gate.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { ExecutionActivation, Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import { SessionNotificationPublisher } from
  "../../src/task/task_session_notification.js";
import { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { configureTestSessionDataHost } from "../helpers/session_data_test_host.js";
import type { FullSchemaPostgresHarness } from "./full_schema_postgres_harness.js";
import { BSecondWriterProductHarness } from
  "./v1_owner_backfill_second_writer_strict_red_harness.js";

const logger = pino({ level: "silent" });
const NODE_ID = "node-b-red";
const PARENT_ID = "p0cn-s5-parent";
const CHILD_ID = "p0cn-s5-child";
const ASSISTANT_REPLY = "S5 parent consumed the correlated child completion";

const parentAgent = {
  id: "p0cn-s5-parent-agent",
  name: "P0-CN S5 parent",
  backend: "codex",
  workspace_dir: "/tmp/p0cn-s5-parent",
} satisfies AgentProfile;

const childAgent = {
  id: "p0cn-s5-child-agent",
  name: "P0-CN S5 child",
  backend: "codex",
  workspace_dir: "/tmp/p0cn-s5-child",
} satisfies AgentProfile;

export interface S5ActivationObservation {
  correlationId: string;
  expectedInputUuid: string;
  relationKey: string;
  parentTerminalEventId: number;
  startBoundary: {
    deliveryId: string | null;
    taskStatus: string;
    activationAttached: boolean;
  } | null;
  ownership: OwnershipRow | null;
  input: EngineExecuteParams | null;
}

export interface S5FinalObservation {
  delivery: Record<string, unknown>;
  notificationReceipt: Record<string, unknown>;
  relationConsumption: Record<string, unknown>;
  notificationEvent: EventRow;
  assistantEvent: EventRow;
  acquireEventId: number;
  finalSession: OwnershipRow;
  catchupStatusCode: number;
  catchupFrames: SseFrame[];
}

interface OwnershipRow {
  status: string;
  execution_generation: number;
  execution_manifest_id: string | null;
  execution_runtime_env_identity: string | null;
  execution_registration_id: string | null;
  execution_pid: number | null;
  execution_start_identity: string | null;
  execution_command_id: string | null;
  termination_event_id: number | null;
}

interface EventRow {
  id: number;
  payload: Record<string, unknown>;
}

export interface SseFrame {
  event: string;
  id?: string;
  data: Record<string, unknown>;
}

class BlockingParentEngine implements EnginePort {
  readonly backendId = "codex" as const;
  readonly workspaceDir = parentAgent.workspace_dir;
  readonly inputs: EngineExecuteParams[] = [];
  private enteredResolve!: () => void;
  private releaseResolve!: () => void;
  readonly entered = new Promise<void>((resolve) => { this.enteredResolve = resolve; });
  private readonly released = new Promise<void>((resolve) => {
    this.releaseResolve = resolve;
  });

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    this.inputs.push(params);
    this.enteredResolve();
    await this.released;
    yield {
      type: "assistant_message",
      content: ASSISTANT_REPLY,
      timestamp: Date.now() / 1000,
    };
  }

  release(): void {
    this.releaseResolve();
  }

  async intervene() {
    return {
      status: "not_delivered" as const,
      mechanism: "unsupported" as const,
      reason: "not_supported" as const,
    };
  }

  async interrupt(): Promise<boolean> { return true; }
  async close(): Promise<void> {}
}

export class CompletedParentS5FullSliceHarness {
  private execution: Promise<void> | undefined;
  private startBoundary: S5ActivationObservation["startBoundary"] = null;
  private notifier!: TaskCompletionNotifier;

  private constructor(
    private readonly postgres: FullSchemaPostgresHarness,
    private readonly eventHarness: BSecondWriterProductHarness,
    private readonly historyApp: FastifyInstance,
    private readonly deliveries: SessionDeliveryRepository,
    private readonly engine: BlockingParentEngine,
    private readonly child: Task,
    readonly correlationId: string,
    readonly relationKey: string,
    readonly expectedInputUuid: string,
    readonly parentTerminalEventId: number,
  ) {}

  static async create(
    postgres: FullSchemaPostgresHarness,
  ): Promise<CompletedParentS5FullSliceHarness> {
    await resetTables(postgres);
    const eventHarness = await BSecondWriterProductHarness.create(postgres);
    const db = new SessionDB();
    const deliveries = new SessionDeliveryRepository(postgres.sql);
    db.configureSessionDeliveryHost(deliveries as never);
    configureTestSessionDataHost(db, postgres.sql);
    await registerSession(postgres, PARENT_ID, parentAgent.id);
    await registerSession(postgres, CHILD_ID, childAgent.id, PARENT_ID);

    const parent = terminalTask(PARENT_ID, parentAgent);
    const child = terminalTask(CHILD_ID, childAgent, PARENT_ID);
    const lifecycle = new TaskLifecycleTransition({
      logger,
      persistence: eventHarness.persistence,
    });
    await lifecycle.persistExecutorFinalState(parent);
    await lifecycle.persistExecutorFinalState(child);
    if (parent.terminalEventId === undefined || child.terminalEventId === undefined) {
      throw new Error("S5 terminal revisions were not persisted");
    }

    const relationKey = `child_session:${CHILD_ID}:${child.terminalEventId}`;
    const identity = buildDeterministicDeliveryIdentity({
      targetSessionId: PARENT_ID,
      relationKey,
      intent: "completion_notification",
    });
    const registry = new AgentRegistry([parentAgent, childAgent]);
    const broadcaster = new SessionBroadcaster(async () => undefined, registry, NODE_ID);
    const gate = new TaskDeliveryLedgerGate(true, deliveries as never);
    const engine = new BlockingParentEngine();
    const executor = new TaskExecutor(
      () => engine,
      db,
      eventHarness.persistence,
      broadcaster,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      gate,
    );
    const route = new TaskInterventionRoute({
      getTask: (sessionId) => sessionId === PARENT_ID ? parent : undefined,
      loadEvictedTask: async () => null,
      rememberTask: () => undefined,
      runningInterventionTransition: new RunningInterventionTransition({
        broadcaster,
        logger,
        persistence: eventHarness.persistence,
      }),
      autoResumeTransition: new AutoResumeTransition({
        logger,
        persistence: eventHarness.persistence,
        agentRegistry: registry,
      }),
      deliveryLedgerGate: gate,
      sessionNotificationPublisher: new SessionNotificationPublisher({
        broadcaster,
        logger,
        persistence: eventHarness.persistence,
      }),
    });
    const historyApp = Fastify();
    registerSessionHistoryRoutes(historyApp, {
      provider: createLiveSessionHistoryProvider({
        sqlResolver: createLiveDbSqlResolver({
          sql: postgres.createPeer() as unknown as LivePostgresSql,
        }),
      }),
      closeAfterHistorySync: true,
    });
    const harness = new CompletedParentS5FullSliceHarness(
      postgres,
      eventHarness,
      historyApp,
      deliveries,
      engine,
      child,
      identity.deliveryId,
      relationKey,
      buildDeliveryInputUuid(identity.deliveryId),
      parent.terminalEventId,
    );
    harness.notifier = new TaskCompletionNotifier(
      NODE_ID,
      { addIntervention: route.addIntervention.bind(route) } as unknown as TaskManager,
      registry,
      (resumedTask: Task, activation?: ExecutionActivation) => {
        harness.startBoundary = {
          deliveryId: identity.deliveryId,
          taskStatus: resumedTask.status,
          activationAttached: activation !== undefined
            && resumedTask.executionActivation === activation,
        };
        harness.execution = executor.startExecution(resumedTask, parentAgent, activation);
      },
      logger,
      undefined,
      undefined,
      db,
      true,
      deliveries as never,
    );
    return harness;
  }

  async notifyToActivation(): Promise<S5ActivationObservation> {
    await this.notifier.notify(this.child);
    let ownership: OwnershipRow | null = null;
    if (this.startBoundary && this.execution) {
      await Promise.race([this.engine.entered, this.execution]);
      ownership = await this.readSession();
    }
    return {
      correlationId: this.correlationId,
      expectedInputUuid: this.expectedInputUuid,
      relationKey: this.relationKey,
      parentTerminalEventId: this.parentTerminalEventId,
      startBoundary: this.startBoundary,
      ownership,
      input: this.engine.inputs[0] ?? null,
    };
  }

  async finish(): Promise<S5FinalObservation> {
    if (!this.execution) throw new Error("S5 parent execution was not started");
    this.engine.release();
    await this.execution;
    const delivery = await this.deliveries.get(this.correlationId);
    const consumption = await this.deliveries.getRelationConsumption(this.relationKey);
    if (!delivery || !consumption) throw new Error("S5 delivery settlement is missing");
    const notificationReceipt = await one<Record<string, unknown>>(this.postgres, this.postgres.sql`
      SELECT state, target_receipt_id
      FROM session_delivery_notification_outbox
      WHERE delivery_id = ${this.correlationId}
    `, "notification receipt");
    const notificationEvent = await one<EventRow>(this.postgres, this.postgres.sql`
      SELECT id, payload FROM events
      WHERE session_id = ${PARENT_ID} AND event_type = 'session_notification'
        AND payload->>'delivery_id' = ${this.correlationId}
    `, "session notification event");
    const assistantEvent = await one<EventRow>(this.postgres, this.postgres.sql`
      SELECT id, payload FROM events
      WHERE session_id = ${PARENT_ID} AND event_type = 'assistant_message'
        AND payload->>'content' = ${ASSISTANT_REPLY}
    `, "assistant reply event");
    const acquire = await one<{ id: number }>(this.postgres, this.postgres.sql`
      SELECT id FROM events
      WHERE session_id = ${PARENT_ID} AND event_type = 'metadata'
        AND payload->>'metadata_type' = 'execution_ownership_transition'
        AND payload->'value'->>'phase' = 'execution_acquire'
    `, "ownership acquire event");
    const response = await this.historyApp.inject({
      method: "GET",
      url: `/api/sessions/${PARENT_ID}/events`,
      headers: { "last-event-id": String(this.parentTerminalEventId) },
    });
    return {
      delivery: delivery as unknown as Record<string, unknown>,
      notificationReceipt,
      relationConsumption: consumption as unknown as Record<string, unknown>,
      notificationEvent,
      assistantEvent,
      acquireEventId: Number(acquire.id),
      finalSession: await this.readSession(),
      catchupStatusCode: response.statusCode,
      catchupFrames: parseSseFrames(response.body),
    };
  }

  async cleanup(): Promise<void> {
    this.engine.release();
    await this.execution?.catch(() => undefined);
    await this.historyApp.close();
    await this.eventHarness.cleanup();
  }

  private async readSession(): Promise<OwnershipRow> {
    return await one<OwnershipRow>(this.postgres, this.postgres.sql`
      SELECT status, execution_generation::int, execution_manifest_id,
             execution_runtime_env_identity, execution_registration_id,
             execution_pid, execution_start_identity, execution_command_id,
             termination_event_id
      FROM sessions WHERE session_id = ${PARENT_ID}
    `, "parent session");
  }
}

async function registerSession(
  postgres: FullSchemaPostgresHarness,
  sessionId: string,
  agentId: string,
  callerSessionId: string | null = null,
): Promise<void> {
  const now = new Date();
  await new SessionMutationRepository(postgres.sql as never).registerSession({
    idempotencyKey: `register:${sessionId}`,
    sessionId,
    nodeId: NODE_ID,
    agentId,
    claudeSessionId: null,
    sessionType: "codex",
    prompt: "S5 terminal fixture",
    clientId: null,
    status: "running",
    createdAt: now,
    updatedAt: now,
    callerSessionId,
    predecessorSessionId: null,
    notifyCompletion: callerSessionId !== null,
    reviewRequired: false,
    reviewState: "not_required",
  });
}

function terminalTask(
  sessionId: string,
  agent: AgentProfile,
  callerSessionId?: string,
): Task {
  return {
    agentSessionId: sessionId,
    prompt: "S5 terminal fixture",
    status: "completed",
    profileId: agent.id,
    agentProfileSnapshot: agent,
    callerSessionId,
    notifyCompletion: callerSessionId !== undefined,
    createdAt: new Date(),
    completedAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    lastAssistantText: "S5 child completed result",
  };
}

async function resetTables(postgres: FullSchemaPostgresHarness): Promise<void> {
  await postgres.sql`DELETE FROM session_delivery_notification_outbox`;
  await postgres.sql`DELETE FROM session_delivery_relation_consumptions`;
  await postgres.sql`DELETE FROM session_deliveries`;
  await postgres.sql`DELETE FROM session_execution_ownerships`;
  await postgres.sql`DELETE FROM sessions`;
}

async function one<T>(
  _postgres: FullSchemaPostgresHarness,
  query: Promise<unknown>,
  label: string,
): Promise<T> {
  const rows = await query as T[];
  const row = rows[0];
  if (!row) throw new Error(`S5 ${label} missing`);
  return row;
}

function parseSseFrames(body: string): SseFrame[] {
  return body.split("\n\n").flatMap((raw) => {
    if (raw.length === 0) return [];
    const fields = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      fields.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
    }
    const event = fields.get("event");
    const data = fields.get("data");
    if (!event || data === undefined) return [];
    const id = fields.get("id");
    return [{
      event,
      ...(id === undefined ? {} : { id }),
      data: JSON.parse(data) as Record<string, unknown>,
    }];
  });
}
