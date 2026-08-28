import { vi } from "vitest";

import {
  createApp,
  loadContractFixtures,
  registerSessionActionCommandRoutes,
  type NodeRegistrationPayload,
} from "../src/index.js";
import { createHarnessCore } from "./session-action-command-test-helpers.js";
import {
  COMPLETED_NODE_ID as NODE_ID,
  COMPLETED_SESSION_ID as SESSION_ID,
  completedSessionRow as sessionRow,
  InMemoryDeliveryLedger,
  observeCompletedDelivery as observeDelivery,
  type CompletedResumeScenario,
} from "./completed-resume-ingress-fixture.js";
import type { CompletedResumeObservation } from
  "./completed-resume-ingress-oracle.js";

type RuntimeConstructor = new (...args: any[]) => any;

interface RuntimeTask {
  agentSessionId: string;
  status: string;
  executionPromise?: Promise<void>;
  executionActivation?: {
    promise?: Promise<void>;
    resolve(): void;
  };
}

interface SoulRuntimeModules {
  AutoResumeTransition: RuntimeConstructor;
  CompletionDeliveryCoordinator: RuntimeConstructor;
  CompletionDeliveryRecoveryWorker: RuntimeConstructor;
  TaskDeliveryLedgerGate: RuntimeConstructor;
  hydrateEvictedTaskFromSessionRow(
    row: Record<string, unknown>,
    logger: unknown,
  ): RuntimeTask | null;
  TaskInterventionRoute: RuntimeConstructor;
  RunningInterventionTransition: RuntimeConstructor;
  QueuedDeliveryTranscriptRecovery: RuntimeConstructor;
  ClaudeRuntimeStartupRecovery: RuntimeConstructor;
  CommandDispatcher: RuntimeConstructor;
  makeEventPersistenceTestDouble(): any;
}

async function loadSoulRuntimeModules(): Promise<SoulRuntimeModules> {
  const [
    autoResume,
    deliveryCoordinator,
    recoveryWorker,
    ledgerGate,
    evictedHydration,
    interventionRoute,
    runningIntervention,
    transcriptRecovery,
    startupRecovery,
    dispatcher,
    persistenceDouble,
  ] = await Promise.all([
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/task_auto_resume_transition.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/completion_delivery_coordinator.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/completion_delivery_recovery_worker.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/task_delivery_ledger_gate.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/task_evicted_hydration.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/task_intervention_route.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/task_running_intervention_transition.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/task/queued_delivery_transcript_recovery.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/runtime/claude_runtime_startup_recovery.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/src/upstream/dispatcher.js",
    ),
    vi.importActual<Record<string, unknown>>(
      "../../soul-server-ts/tests/task/event_persistence_test_double.js",
    ),
  ]);
  return {
    AutoResumeTransition: autoResume.AutoResumeTransition as RuntimeConstructor,
    CompletionDeliveryCoordinator:
      deliveryCoordinator.CompletionDeliveryCoordinator as RuntimeConstructor,
    CompletionDeliveryRecoveryWorker:
      recoveryWorker.CompletionDeliveryRecoveryWorker as RuntimeConstructor,
    TaskDeliveryLedgerGate: ledgerGate.TaskDeliveryLedgerGate as RuntimeConstructor,
    hydrateEvictedTaskFromSessionRow:
      evictedHydration.hydrateEvictedTaskFromSessionRow as SoulRuntimeModules[
        "hydrateEvictedTaskFromSessionRow"
      ],
    TaskInterventionRoute:
      interventionRoute.TaskInterventionRoute as RuntimeConstructor,
    RunningInterventionTransition:
      runningIntervention.RunningInterventionTransition as RuntimeConstructor,
    QueuedDeliveryTranscriptRecovery:
      transcriptRecovery.QueuedDeliveryTranscriptRecovery as RuntimeConstructor,
    ClaudeRuntimeStartupRecovery:
      startupRecovery.ClaudeRuntimeStartupRecovery as RuntimeConstructor,
    CommandDispatcher: dispatcher.CommandDispatcher as RuntimeConstructor,
    makeEventPersistenceTestDouble:
      persistenceDouble.makeEventPersistenceTestDouble as () => any,
  };
}

const silentLogger = {
  child: () => silentLogger,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

export const COMPLETED_RESUME_TIMING_MATRIX: readonly CompletedResumeScenario[] = [
  {
    label: "completed-immediately",
    memoryResident: true,
    executionDrainBarrier: true,
    lastEventId: 307,
    terminalEventId: 307,
    historicalGeneration: 2,
  },
  {
    label: "before-turn-summary",
    memoryResident: true,
    executionDrainBarrier: false,
    lastEventId: 307,
    terminalEventId: 307,
    historicalGeneration: 2,
  },
  {
    label: "after-turn-summary",
    memoryResident: true,
    executionDrainBarrier: false,
    lastEventId: 308,
    terminalEventId: 307,
    historicalGeneration: 2,
  },
  {
    label: "after-service-restart",
    memoryResident: false,
    executionDrainBarrier: false,
    lastEventId: 308,
    terminalEventId: 307,
    historicalGeneration: 2,
  },
  {
    label: "repeated-click-after-restart",
    clicks: 2,
    deliveryIds: [
      "f8a08628-c577-4a9a-89c7-a2a585f958b9",
      "e7d85cda-d77c-4056-8e00-0704083a0290",
    ],
    memoryResident: false,
    executionDrainBarrier: false,
    lastEventId: 308,
    terminalEventId: 307,
    historicalGeneration: 2,
  },
];

export async function observeCompletedResumeIngress(
  scenario: CompletedResumeScenario,
): Promise<CompletedResumeObservation> {
  const {
    AutoResumeTransition,
    CompletionDeliveryCoordinator,
    CompletionDeliveryRecoveryWorker,
    TaskDeliveryLedgerGate,
    hydrateEvictedTaskFromSessionRow,
    TaskInterventionRoute,
    RunningInterventionTransition,
    QueuedDeliveryTranscriptRecovery,
    ClaudeRuntimeStartupRecovery,
    CommandDispatcher,
    makeEventPersistenceTestDouble,
  } = await loadSoulRuntimeModules();
  const ledger = new InMemoryDeliveryLedger();
  const tasks = new Map<string, RuntimeTask>();
  const persistence = makeEventPersistenceTestDouble();
  let sessionLoads = 0;
  let autoResumes = 0;
  let executionStarts = 0;
  let nodeCommands = 0;
  let periodicRecoveryScans = 0;
  let startupRecoveryScans = 0;
  const hydrationWarnings: string[] = [];
  const logger = {
    ...silentLogger,
    warn: vi.fn((_fields: unknown, message: string) => {
      hydrationWarnings.push(message);
    }),
  };
  const autoResume = new AutoResumeTransition({
    logger,
    persistence: persistence.persistence,
    agentRegistry: {
      get: vi.fn(() => ({ id: "seosoyoung", backend: "claude" })),
    } as never,
  });
  const route = new TaskInterventionRoute({
    getTask: (sessionId: string) => tasks.get(sessionId),
    loadEvictedTask: async (sessionId: string) => {
      sessionLoads += 1;
      if (sessionId !== SESSION_ID) return null;
      return hydrateEvictedTaskFromSessionRow(sessionRow(scenario), logger);
    },
    rememberTask: (task: RuntimeTask) => tasks.set(task.agentSessionId, task),
    runningInterventionTransition: new RunningInterventionTransition({
      broadcaster: {} as never,
      logger,
      persistence: persistence.persistence,
      liveRetryDelayMs: 0,
      sleep: async () => undefined,
    }),
    autoResumeTransition: {
      resume: async (...args: any[]) => {
        autoResumes += 1;
        return await autoResume.resume(...args);
      },
    },
    deliveryLedgerGate: new TaskDeliveryLedgerGate(true, ledger as never),
  });
  if (scenario.memoryResident) {
    const resident = hydrateEvictedTaskFromSessionRow(
      sessionRow({ ...scenario, historicalGeneration: null }),
      logger,
    );
    if (resident === null) throw new Error("resident terminal fixture did not hydrate");
    if (scenario.executionDrainBarrier) {
      resident.executionPromise = new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    tasks.set(SESSION_ID, resident);
  }

  const { registry, transports, router, bridge } = createHarnessCore({
    findSessionOwnerNodeId: async (sessionId) =>
      sessionId === SESSION_ID ? NODE_ID : null,
  });
  const registration = loadContractFixtures().fakeNodeReconnect.registration as
    NodeRegistrationPayload;
  const registered = registry.registerNode({ ...registration, node_id: NODE_ID });
  const connectionId = registered.node.connectionId;
  const agentRegistry = {
    get: vi.fn(() => ({ id: "seosoyoung", backend: "claude" })),
    list: vi.fn(() => []),
  };
  const taskManager = {
    addIntervention: route.addIntervention.bind(route),
    getTask: (sessionId: string) => tasks.get(sessionId),
    listTasks: () => [...tasks.values()],
  };
  const taskExecutor = {
    startExecution: vi.fn((task: RuntimeTask, _agent: unknown, activation?: {
      resolve(): void;
    }) => {
      executionStarts += 1;
      task.status = "running";
      activation?.resolve();
    }),
  };
  const dispatcher = new CommandDispatcher(
    async (frame: unknown) => {
      registry.receiveNodeMessage(
        { nodeId: NODE_ID, connectionId },
        frame as Record<string, unknown>,
      );
    },
    logger,
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
  transports.attach({
    nodeId: NODE_ID,
    connectionId,
    transport: {
      send: async (data) => {
        nodeCommands += 1;
        await dispatcher.dispatch(JSON.parse(data));
      },
    },
  });

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
    deliveryRepositoryProvider: async () => ({ register: ledger.register.bind(ledger) }),
  } as never);

  const clicks = scenario.clicks ?? 1;
  const httpStatuses: number[] = [];
  const httpOutcomes: string[] = [];
  for (let index = 0; index < clicks; index += 1) {
    const deliveryId = scenario.deliveryIds?.[index]
      ?? `435e0000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/intervene`,
      payload: {
        text: `resume click ${index + 1}`,
        user: "dashboard",
        delivery_id: deliveryId,
        delivery_intent: "human_live_steer",
        source: "user_message",
      },
    });
    httpStatuses.push(response.statusCode);
    httpOutcomes.push(String(response.json().outcome ?? "missing"));
  }
  if (!scenario.memoryResident) {
    const periodicCoordinator = new CompletionDeliveryCoordinator({
      repository: ledger as never,
      dispatch: async () => undefined,
      logger,
    }, "completed-resume-periodic");
    const periodicWorker = new CompletionDeliveryRecoveryWorker({
      recoverPending: async () => {
        periodicRecoveryScans += 1;
        await periodicCoordinator.recoverPending();
      },
      recoverNotifications: async () => undefined,
      logger,
    });
    await periodicWorker.runOnce();

    const queuedRecovery = new QueuedDeliveryTranscriptRecovery({
      deliveryRepository: ledger as never,
      recoveryRepository: ledger as never,
      transcriptReceipt: {
        inspect: async () => ({
          kind: "absent" as const,
          inputUuid: "completed-resume-input",
        }),
      },
      logger,
    }, "completed-resume-startup");
    const startupRecovery = new ClaudeRuntimeStartupRecovery({
      recoverQueuedDeliveries: async () => {
        startupRecoveryScans += 1;
        return await queuedRecovery.recoverAfterNodeRestart(NODE_ID);
      },
      recoverBackgroundTasks: async () => 0,
      logger,
      nodeId: NODE_ID,
    });
    await startupRecovery.start();
    await startupRecovery.stop();
  }
  await app.close();

  const semanticInputs = persistence.enqueueEvent.mock.calls.filter((call: unknown[]) => {
    const event = call[1] as Record<string, unknown>;
    return event.type === "user_message" || event.type === "intervention_sent";
  }).length;
  return {
    label: scenario.label,
    clicks,
    expectedSessionLoads: scenario.memoryResident ? 0 : 1,
    executionDrainBarrierUsed: scenario.executionDrainBarrier,
    httpStatuses,
    httpOutcomes,
    orchAdmissions: ledger.registerCalls,
    nodeCommands,
    sessionLoads,
    deliveryGets: ledger.getCalls,
    deliveryClaims: ledger.claimCalls,
    deliveryBegins: ledger.beginCalls,
    autoResumes,
    executionStarts,
    semanticInputs,
    periodicRecoveryScans,
    startupRecoveryScans,
    deliveries: ledger.rows().map(observeDelivery),
    hydrationWarnings,
  };
}
