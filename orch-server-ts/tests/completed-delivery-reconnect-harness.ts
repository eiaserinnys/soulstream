import { vi } from "vitest";

import {
  createApp,
  loadContractFixtures,
  registerSessionActionCommandRoutes,
  type NodeRegistrationPayload,
} from "../src/index.js";
import { createSessionCacheSeedSink } from
  "../src/node/session_cache_seed_sink.js";
import { createHarnessCore } from "./session-action-command-test-helpers.js";
import {
  completedSessionRow,
  interventionBody,
  interventionCommand,
  LIVE_COMPLETED_NODE_ID as NODE_ID,
  LIVE_COMPLETED_SESSION_ID as SESSION_ID,
  makeDeliveryRow,
  type CompletedDeliveryReconnectScenario,
  type DeliveryLedgerRow,
} from "./completed-delivery-reconnect-fixture.js";
import type { CompletedDeliveryReconnectObservation } from
  "./completed-delivery-reconnect-oracle.js";

type RuntimeConstructor = new (...args: any[]) => any;
type ReconnectMode = "product" | "counterfactual_wake";
type SessionCacheSeedInputWithNodeReady =
  Parameters<typeof createSessionCacheSeedSink>[0] & {
    onNodeReady?: (
      nodeId: string,
      connectionId?: string,
    ) => Promise<void> | void;
  };

const createSessionCacheSeedSinkWithNodeReady = createSessionCacheSeedSink as (
  input: SessionCacheSeedInputWithNodeReady,
) => ReturnType<typeof createSessionCacheSeedSink>;

interface RuntimeTask {
  agentSessionId: string;
  status: string;
  profileId?: string;
  lastEventId?: number;
  interventionQueue: Array<{
    deliveryId?: string;
    deliveryIntent?: string;
    text: string;
    user: string;
  }>;
  executionActivation?: { resolve(): void };
}

interface SoulRuntimeModules {
  AutoResumeTransition: RuntimeConstructor;
  TaskDeliveryLedgerGate: RuntimeConstructor;
  TaskInterventionRoute: RuntimeConstructor;
  RunningInterventionTransition: RuntimeConstructor;
  CommandDispatcher: RuntimeConstructor;
  hydrateEvictedTaskFromSessionRow(
    row: Record<string, unknown>,
    logger: unknown,
  ): RuntimeTask | null;
  makeEventPersistenceTestDouble(): {
    persistence: unknown;
  };
}

async function loadSoulRuntimeModules(): Promise<SoulRuntimeModules> {
  const [
    autoResume,
    ledgerGate,
    interventionRoute,
    runningIntervention,
    dispatcher,
    evictedHydration,
    persistenceDouble,
  ] = await Promise.all([
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/task_auto_resume_transition.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/task_delivery_ledger_gate.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/task_intervention_route.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/task_running_intervention_transition.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/upstream/dispatcher.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/task_evicted_hydration.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/tests/task/event_persistence_test_double.js",
    ),
  ]);
  return {
    AutoResumeTransition: autoResume.AutoResumeTransition as RuntimeConstructor,
    TaskDeliveryLedgerGate: ledgerGate.TaskDeliveryLedgerGate as RuntimeConstructor,
    TaskInterventionRoute: interventionRoute.TaskInterventionRoute as RuntimeConstructor,
    RunningInterventionTransition:
      runningIntervention.RunningInterventionTransition as RuntimeConstructor,
    CommandDispatcher: dispatcher.CommandDispatcher as RuntimeConstructor,
    hydrateEvictedTaskFromSessionRow:
      evictedHydration.hydrateEvictedTaskFromSessionRow as SoulRuntimeModules[
        "hydrateEvictedTaskFromSessionRow"
      ],
    makeEventPersistenceTestDouble:
      persistenceDouble.makeEventPersistenceTestDouble as () => {
        persistence: unknown;
      },
  };
}

const silentLogger = {
  child: () => silentLogger,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

class ReconnectDeliveryLedger {
  private readonly store = new Map<string, DeliveryLedgerRow>();
  readonly admittedIds: string[] = [];
  readonly claimEligibleIds = new Set<string>();
  readonly consumeIds: string[] = [];

  rows(): DeliveryLedgerRow[] {
    return [...this.store.values()].map((row) => structuredClone(row));
  }

  async register(params: Record<string, unknown>) {
    const deliveryId = String(params.deliveryId);
    const existing = this.store.get(deliveryId);
    if (existing) {
      return { row: structuredClone(existing), inserted: false, conflict: false };
    }
    const row = makeDeliveryRow(params);
    this.store.set(deliveryId, row);
    this.admittedIds.push(deliveryId);
    return { row: structuredClone(row), inserted: true, conflict: false };
  }

  async get(deliveryId: string) {
    const row = this.store.get(deliveryId);
    return row ? structuredClone(row) : null;
  }

  pendingEligibleFor(targetSessionId: string): string[] {
    const eligible = this.rows()
      .filter((row) =>
        row.target_session_id === targetSessionId
        && row.intent === "human_live_steer"
        && row.state === "pending"
      )
      .map((row) => row.delivery_id);
    for (const deliveryId of eligible) this.claimEligibleIds.add(deliveryId);
    return eligible;
  }

  async claimForTarget(
    deliveryId: string,
    targetSessionId: string,
    leaseOwner: string,
  ) {
    const row = this.store.get(deliveryId);
    if (!row || row.state !== "pending" || row.target_session_id !== targetSessionId) {
      return null;
    }
    this.claimEligibleIds.add(deliveryId);
    const claimed = structuredClone(row);
    claimed.state = "claimed";
    claimed.claimed_at = new Date();
    claimed.lease_owner = leaseOwner;
    claimed.lease_expires_at = new Date(Date.now() + 30_000);
    this.store.set(deliveryId, claimed);
    return structuredClone(claimed);
  }

  async beginDispatch(deliveryId: string, leaseOwner: string) {
    const row = this.store.get(deliveryId);
    if (!row || row.state !== "claimed" || row.lease_owner !== leaseOwner) return null;
    const dispatching = structuredClone(row);
    dispatching.state = "dispatching";
    dispatching.dispatching_at = new Date();
    this.store.set(deliveryId, dispatching);
    return structuredClone(dispatching);
  }

  async markQueued(deliveryId: string, leaseOwner: string) {
    const row = this.store.get(deliveryId);
    if (!row || row.state !== "dispatching" || row.lease_owner !== leaseOwner) return null;
    const queued = structuredClone(row);
    queued.state = "queued";
    queued.queued_at = new Date();
    queued.lease_owner = null;
    queued.lease_expires_at = null;
    this.store.set(deliveryId, queued);
    return structuredClone(queued);
  }

  async markConsumed(deliveryId: string, receiptId: string) {
    const row = this.store.get(deliveryId);
    if (!row || !["queued", "delivered", "consumed"].includes(row.state)) return null;
    this.consumeIds.push(deliveryId);
    const consumed = structuredClone(row);
    consumed.state = "consumed";
    consumed.aggregate_state = "consumed";
    consumed.target_receipt_id = receiptId;
    consumed.target_receipt_at ??= new Date();
    consumed.consumed_at ??= new Date();
    consumed.consumed_reason = "foreground turn result";
    this.store.set(deliveryId, consumed);
    return structuredClone(consumed);
  }

  async markDelivered() { return null; }
  async markUncertain() { return null; }
  async markConsumedByRelation() { return null; }
  async recordRelationConsumed() { return null; }
  async retryLeasedDelivery() { return null; }
  async markPendingSuperseded() { return null; }
  notifications = {
    stageWithQueuedDelivery: vi.fn(),
    get: vi.fn(),
    markPublished: vi.fn(),
    retry: vi.fn(),
  };
}

export async function observeCompletedDeliveryReconnect(
  scenario: CompletedDeliveryReconnectScenario,
  reconnectMode: ReconnectMode = "product",
): Promise<CompletedDeliveryReconnectObservation> {
  const {
    AutoResumeTransition,
    TaskDeliveryLedgerGate,
    TaskInterventionRoute,
    RunningInterventionTransition,
    CommandDispatcher,
    hydrateEvictedTaskFromSessionRow,
    makeEventPersistenceTestDouble,
  } = await loadSoulRuntimeModules();
  const ledger = new ReconnectDeliveryLedger();
  const tasks = new Map<string, RuntimeTask>();
  const persistence = makeEventPersistenceTestDouble();
  const receiptIds: string[] = [];
  const semanticInputIds: string[] = [];
  const modelInputIds: string[] = [];
  const reserveIds: string[] = [];
  const proveIds: string[] = [];
  const activateIds: string[] = [];
  const assistantProgressIds: string[] = [];
  const assistantResultIds: string[] = [];
  const reconnectWakeIds: string[] = [];
  const nodeDispatchIds: string[] = [];
  let reconnectSignals = 0;
  let newGenerations = 0;
  let foregroundTurns = 0;

  const agentRegistry = {
    get: vi.fn(() => ({
      id: "seosoyoung",
      name: "서소영",
      backend: "codex",
      workspace_dir: "/workspace/completed-reconnect-red",
    })),
    list: vi.fn(() => []),
  };
  const ledgerGate = new TaskDeliveryLedgerGate(true, ledger as never);
  const autoResume = new AutoResumeTransition({
    logger: silentLogger,
    persistence: persistence.persistence,
    agentRegistry: agentRegistry as never,
  });
  const running = new RunningInterventionTransition({
    broadcaster: { emitEventEnvelope: vi.fn() } as never,
    logger: silentLogger,
    persistence: persistence.persistence,
    liveRetryDelayMs: 0,
    sleep: async () => undefined,
  });
  const route = new TaskInterventionRoute({
    getTask: (sessionId: string) => tasks.get(sessionId),
    loadEvictedTask: async (sessionId: string) => {
      if (sessionId !== SESSION_ID) return null;
      return hydrateEvictedTaskFromSessionRow(
        completedSessionRow("completed"),
        silentLogger,
      );
    },
    rememberTask: (task: RuntimeTask) => tasks.set(task.agentSessionId, task),
    runningInterventionTransition: running,
    autoResumeTransition: autoResume,
    deliveryLedgerGate: ledgerGate,
  });
  if (scenario.targetStatus === "running") {
    tasks.set(SESSION_ID, {
      agentSessionId: SESSION_ID,
      status: "running",
      profileId: "seosoyoung",
      lastEventId: 308,
      interventionQueue: [],
    });
  }

  const { registry, transports, router, bridge } = createHarnessCore({
    findSessionOwnerNodeId: async (sessionId) =>
      sessionId === SESSION_ID ? NODE_ID : null,
  });
  const registration = loadContractFixtures().fakeNodeReconnect.registration as
    NodeRegistrationPayload;
  const taskManager = {
    addIntervention: route.addIntervention.bind(route),
    getTask: (sessionId: string) => tasks.get(sessionId),
    listTasks: () => [...tasks.values()],
  };
  const taskExecutor = {
    startExecution: vi.fn((task: RuntimeTask, _agent: unknown, activation?: {
      resolve(): void;
    }) => {
      newGenerations += 1;
      const deliveryId = requireDeliveryId(task.interventionQueue[0]);
      reserveIds.push(deliveryId);
      proveIds.push(deliveryId);
      activateIds.push(deliveryId);
      task.status = "running";
      task.executionActivation = undefined;
      activation?.resolve();
    }),
  };
  let connectionId: string | undefined;
  const dispatcher = new CommandDispatcher(
    async (frame: unknown) => {
      if (!connectionId) throw new Error("node response arrived without a connection");
      registry.receiveNodeMessage(
        { nodeId: NODE_ID, connectionId },
        frame as Record<string, unknown>,
      );
    },
    silentLogger,
    NODE_ID,
    agentRegistry as never,
    taskManager as never,
    taskExecutor as never,
    {
      save: vi.fn(),
      getPath: vi.fn(),
      delete: vi.fn(),
    } as never,
  );
  const wakePendingForReadyNode = async (
    nodeId: string,
    readyConnectionId?: string,
  ): Promise<void> => {
    if (nodeId !== NODE_ID) return;
    if (
      readyConnectionId !== undefined
      && registry.getConnectedNode(nodeId)?.connectionId !== readyConnectionId
    ) return;
    for (const deliveryId of ledger.pendingEligibleFor(SESSION_ID)) {
      reconnectWakeIds.push(deliveryId);
      const routed = await router.routeExistingSessionPendingCommand(
        interventionCommand(deliveryId) as never,
      );
      await bridge.sendPendingCommand(routed);
    }
  };
  let nodeReadyWork: Promise<void> | undefined;
  const sessionCacheSeed = createSessionCacheSeedSinkWithNodeReady({
    registry,
    repository: {
      listSessionSnapshots: async () => {
        const session = {
          ...completedSessionRow(scenario.targetStatus),
          agent_session_id: SESSION_ID,
          agentSessionId: SESSION_ID,
          nodeId: NODE_ID,
        };
        return {
          sessions: [session],
          sessionList: [session],
          total: 1,
          cursor: null,
          nextCursor: null,
          hasMore: false,
        };
      },
    },
    logError: (error, message) => silentLogger.error({ error }, message),
    onNodeReady: (nodeId, readyConnectionId) => {
      nodeReadyWork = wakePendingForReadyNode(nodeId, readyConnectionId);
      return nodeReadyWork;
    },
  });
  const connectNode = async (): Promise<void> => {
    nodeReadyWork = undefined;
    const registered = registry.registerNode({ ...registration, node_id: NODE_ID });
    connectionId = registered.node.connectionId;
    transports.attach({
      nodeId: NODE_ID,
      connectionId,
      transport: {
        send: async (data) => {
          const command = JSON.parse(data) as Record<string, unknown>;
          const deliveryId = readDeliveryId(command);
          if (deliveryId) nodeDispatchIds.push(deliveryId);
          await dispatcher.dispatch(command);
        },
      },
    });
    sessionCacheSeed(registered.events);
    await Promise.resolve();
    await nodeReadyWork;
  };
  if (scenario.initiallyConnected) await connectNode();

  const app = createApp({
    config: {
      environment: "test",
      databaseUrl: "postgresql://test/test",
      authBearerToken: "test-token",
    },
  });
  registerSessionActionCommandRoutes(app, {
    router,
    bridge,
    deliveryRepositoryProvider: async () => ({
      register: ledger.register.bind(ledger),
    }),
  } as never);

  const httpStatuses: number[] = [];
  const httpOutcomes: string[] = [];
  for (const deliveryId of scenario.deliveryIds) {
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/intervene`,
      payload: interventionBody(deliveryId),
    });
    const body = response.json() as Record<string, unknown>;
    httpStatuses.push(response.statusCode);
    httpOutcomes.push(String(body.outcome ?? body.status ?? "missing"));
  }

  if (scenario.reconnect) {
    await connectNode();
    reconnectSignals += 1;
    ledger.pendingEligibleFor(SESSION_ID);
    if (reconnectMode === "counterfactual_wake") {
      await wakePendingForReadyNode(NODE_ID, connectionId);
    }
  }

  const task = tasks.get(SESSION_ID);
  if (task && task.interventionQueue.length > 0) {
    foregroundTurns += 1;
    const turnMessages = [...task.interventionQueue];
    task.interventionQueue.length = 0;
    task.lastEventId = (task.lastEventId ?? 308) + 1;
    for (const message of turnMessages) {
      const deliveryId = requireDeliveryId(message);
      receiptIds.push(deliveryId);
      semanticInputIds.push(deliveryId);
      modelInputIds.push(deliveryId);
      await ledgerGate.recordTurnStarted(message as never, task as never);
    }
    for (const message of turnMessages) {
      const deliveryId = requireDeliveryId(message);
      assistantProgressIds.push(deliveryId);
      assistantResultIds.push(deliveryId);
      await ledgerGate.recordConsumed(
        message as never,
        task as never,
        `event:${task.lastEventId}`,
      );
    }
  }
  await app.close();

  const rows = ledger.rows();
  return {
    label: scenario.label,
    reconnect: scenario.reconnect,
    targetStatus: scenario.targetStatus,
    deliveryIds: [...scenario.deliveryIds],
    expectedNewGenerations: scenario.expectedNewGenerations,
    httpStatuses,
    httpOutcomes,
    admittedIds: ledger.admittedIds,
    claimEligibleIds: [...ledger.claimEligibleIds],
    reconnectSignals,
    reconnectWakeIds,
    nodeDispatchIds,
    receiptIds,
    consumeIds: ledger.consumeIds,
    deadLetterIds: rows
      .filter((row) => row.dead_lettered_at !== null || row.aggregate_state === "dead_letter")
      .map((row) => row.delivery_id),
    semanticInputIds,
    modelInputIds,
    reserveIds,
    proveIds,
    activateIds,
    newGenerations,
    foregroundTurns,
    assistantProgressIds,
    assistantResultIds,
  };
}

function readDeliveryId(command: Record<string, unknown>): string | undefined {
  const snake = command.delivery_id;
  if (typeof snake === "string") return snake;
  const camel = command.deliveryId;
  return typeof camel === "string" ? camel : undefined;
}

function requireDeliveryId(
  message: { deliveryId?: string } | undefined,
): string {
  if (!message?.deliveryId) throw new Error("delivery identity is unavailable");
  return message.deliveryId;
}
