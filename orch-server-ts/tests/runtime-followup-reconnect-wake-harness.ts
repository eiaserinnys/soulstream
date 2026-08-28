import { vi } from "vitest";

import {
  createNodeSessionEventBroadcasterSink,
  InMemorySseReplayBroadcaster,
  loadContractFixtures,
  type NodeRegistrationPayload,
  type SessionStreamEvent,
} from "../src/index.js";
import { createSessionCacheSeedSink } from
  "../src/node/session_cache_seed_sink.js";
import { SessionDeliveryRecoveryRepository } from
  "../src/control_plane/repositories/session_delivery_recovery_repository.js";
import type {
  SessionDeliveryRow,
  SqlClient,
} from "../src/control_plane/control_plane_types.js";
import { createHarnessCore } from "./session-action-command-test-helpers.js";
import {
  ACTIVE_TURN_DELIVERY_IDS,
  RUNTIME_FOLLOWUP_NODE_ID as NODE_ID,
  RUNTIME_FOLLOWUP_SESSION_ID as SESSION_ID,
  runtimeFollowupCommand,
  runtimeFollowupSessionSnapshot,
  type RuntimeFollowupFixtureRow,
} from "./runtime-followup-reconnect-wake-fixture.js";
import {
  deriveLifecycle,
  type LifecycleEvidence,
  type LifecycleEvidenceKind,
  type ReconnectAttemptObservation,
  type RuntimeFollowupWakeObservation,
} from "./runtime-followup-reconnect-wake-oracle.js";
import {
  DeterministicBarrier,
  FakeClock,
  RuntimeFollowupLedger,
} from "./runtime-followup-reconnect-wake-test-doubles.js";

type RecoveryMode = "product" | "counterfactual";
type RuntimeConstructor = new (...args: any[]) => LedgerGate;

interface RuntimeInterventionMessage {
  text: string;
  user: string;
  source?: string;
  deliveryId?: string;
  deliveryIntent?: string;
  completionId?: string;
  relationKey?: string;
  producerTerminalRevision?: string;
  runnerInterventionId?: string;
}

interface RuntimeTask {
  agentSessionId: string;
  prompt: string;
  status: "running" | "completed";
  profileId: string;
  createdAt: Date;
  lastEventId: number;
  lastReadEventId: number;
  interventionQueue: RuntimeInterventionMessage[];
  runner?: {
    engine: unknown;
    dispatcher: unknown;
    eventPersistence: "runner";
  };
}

interface LedgerGate {
  recordTurnStarted(
    message: RuntimeInterventionMessage,
    task: RuntimeTask,
  ): Promise<void>;
  recordConsumed(
    message: RuntimeInterventionMessage,
    task: RuntimeTask,
    consumedTurnId: string,
  ): Promise<void>;
  discardIfConsumed(
    message: RuntimeInterventionMessage,
    task: RuntimeTask,
  ): Promise<boolean>;
}

interface RuntimeReconnectAttempt extends ReconnectAttemptObservation {
  ready: DeterministicBarrier;
}

async function loadTaskDeliveryLedgerGate(): Promise<RuntimeConstructor> {
  const module = await vi.importActual<Record<string, unknown>>(
    "../../soul-server-ts/src/task/task_delivery_ledger_gate.js",
  );
  return module.TaskDeliveryLedgerGate as RuntimeConstructor;
}

export async function observeRuntimeFollowupReconnect(input: {
  recoveryMode?: RecoveryMode;
  transportAvailable?: boolean;
} = {}): Promise<RuntimeFollowupWakeObservation> {
  const recoveryMode = input.recoveryMode ?? "product";
  const transportAvailable = input.transportAvailable ?? true;
  const TaskDeliveryLedgerGate = await loadTaskDeliveryLedgerGate();
  const ledger = new RuntimeFollowupLedger();
  const clock = new FakeClock();
  const trace: string[] = ["disconnect:pending:5170-5172"];
  const task = makeTask();
  const gate = new TaskDeliveryLedgerGate(true, ledger as never);
  const attempts: RuntimeReconnectAttempt[] = [];
  const attemptsByConnection = new Map<string, RuntimeReconnectAttempt>();
  const terminalRelease = new DeterministicBarrier();
  const socketClosed = new DeterministicBarrier();
  const secondCacheSeeded = new DeterministicBarrier();
  let followupQueueErrors = 0;
  let discardInterventionErrors = 0;
  let runnerSocketSendErrors = 0;

  const { registry, transports, router, bridge } = createHarnessCore({
    findSessionOwnerNodeId: async (sessionId) =>
      sessionId === SESSION_ID ? NODE_ID : null,
  });
  const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>({
    instanceId: "runtime-followup-reconnect-fixture",
  });
  const nodeEventSink = createNodeSessionEventBroadcasterSink(
    broadcaster,
    registry,
  );
  const sql = makeRecoverySql(ledger, recoveryMode);
  const recovery = new SessionDeliveryRecoveryRepository(sql);
  const registration = loadContractFixtures().fakeNodeReconnect.registration as
    NodeRegistrationPayload;

  const sessionCacheSeed = createSessionCacheSeedSink({
    registry,
    repository: {
      listSessionSnapshots: async () => ({
        sessions: [runtimeFollowupSessionSnapshot()],
        sessionList: [runtimeFollowupSessionSnapshot()],
        total: 1,
        cursor: null,
        nextCursor: null,
        hasMore: false,
      }),
    },
    logError: (error) => {
      throw error;
    },
    nowMs: clock.nowMs,
    onNodeReady: async (_nodeId, connectionId) => {
      const attempt = attemptsByConnection.get(connectionId);
      if (!attempt) throw new Error(`Missing reconnect attempt ${connectionId}`);
      trace.push(`reconnect:${attempt.phase}:cache-seed`);
      if (attempt.phase === "post_terminal_release") {
        secondCacheSeeded.release();
        await socketClosed.wait();
      }
      try {
        const leaseOwner = `node-ready:${NODE_ID}:${connectionId}`;
        const claimed = await recovery.claimPendingHumanLiveSteerForNode(
          NODE_ID,
          leaseOwner,
        );
        for (const row of claimed) {
          attempt.claimOrder.push(row.delivery_id);
          trace.push(`claim:${attempt.phase}:${row.delivery_id}`);
        }
        for (const row of claimed) {
          try {
            const routed = await router.routeExistingSessionPendingCommand(
              runtimeFollowupCommand(row as RuntimeFollowupFixtureRow) as never,
            );
            await bridge.sendPendingCommand(routed);
          } catch {
            ledger.releaseToPending(row.delivery_id);
          }
        }
      } finally {
        attempt.ready.release();
      }
    },
  });

  const reconnect = async (
    phase: ReconnectAttemptObservation["phase"],
  ): Promise<void> => {
    const registered = registry.registerNode({ ...registration, node_id: NODE_ID });
    const connectionId = registered.node.connectionId;
    const attempt: RuntimeReconnectAttempt = {
      phase,
      connectionId,
      pendingBefore: ledger.pendingReconnectIds(),
      claimOrder: [],
      dispatchOrder: [],
      ready: new DeterministicBarrier(),
    };
    attempts.push(attempt);
    attemptsByConnection.set(connectionId, attempt);
    trace.push(`reconnect:${phase}:registered`);
    nodeEventSink(registered.events);
    if (transportAvailable) {
      transports.attach({
        nodeId: NODE_ID,
        connectionId,
        transport: {
          send: async (data) => {
            const command = JSON.parse(data) as Record<string, unknown>;
            const deliveryId = String(command.delivery_id ?? command.deliveryId);
            const row = await ledger.get(deliveryId);
            if (!row) throw new Error(`Unknown routed delivery ${deliveryId}`);
            attempt.dispatchOrder.push(deliveryId);
            trace.push(`dispatch:${phase}:${deliveryId}`);
            ledger.noteDispatch(deliveryId);
            task.interventionQueue.push(messageFor(row));
            nodeEventSink(registry.receiveNodeMessage(
              { nodeId: NODE_ID, connectionId },
              {
                type: "intervene_ack",
                status: "ok",
                requestId: command.requestId,
              },
            ));
          },
        },
      });
    }
    sessionCacheSeed(registered.events);
    await attempt.ready.wait();
    clock.advance(100);
  };

  const emitSessionUpdate = (
    status: "running" | "completed",
    lifecycle?: { kind: LifecycleEvidenceKind; id: string },
  ): void => {
    const connectionId = registry.getConnectedNode(NODE_ID)?.connectionId;
    if (!connectionId) throw new Error("Session update has no connected node");
    const events = registry.receiveNodeMessage(
      { nodeId: NODE_ID, connectionId },
      {
        type: "session_updated",
        agentSessionId: SESSION_ID,
        status,
        updated_at: new Date(clock.nowMs()),
        ...(lifecycle === undefined
          ? {}
          : {
              lifecycle_kind: lifecycle.kind,
              lifecycle_id: lifecycle.id,
            }),
        ...(lifecycle?.kind === "assistant_turn"
          ? { last_assistant_text: "runtime follow-ups observed" }
          : {}),
        ...(status === "completed"
          ? { termination_reason: "completed_ok" }
          : {}),
      },
    );
    nodeEventSink(events);
    clock.advance(1);
  };

  await reconnect("pre_terminal");
  emitSessionUpdate("running", { kind: "generation", id: "generation-1" });
  emitSessionUpdate("running", { kind: "foreground_turn", id: "turn-1" });
  const preTerminalLifecycle = lifecycleFrom(broadcaster);
  for (const row of ledger.seedActiveTurn()) {
    task.interventionQueue.push(messageFor(row as SessionDeliveryRow));
  }
  trace.push("active-turn:queued:5173-5174");

  const terminalWork = (async () => {
    await terminalRelease.wait();
    trace.push("terminal:result-started");
    const turnMessages = [...task.interventionQueue];
    task.interventionQueue = [];
    for (const message of turnMessages) {
      const deliveryId = requireDeliveryId(message);
      ledger.noteReceipt(deliveryId);
      await gate.recordTurnStarted(message, task);
    }
    emitSessionUpdate("running", { kind: "assistant_turn", id: "assistant-1" });
    for (const message of turnMessages) {
      await gate.recordConsumed(message, task, "event:9001");
    }
    task.status = "completed";
    emitSessionUpdate("completed");
    trace.push("runner:socket-closed");
    socketClosed.release();
    await secondCacheSeeded.wait();
    task.runner = runnerWithDiscard(async () => {
      if (recoveryMode === "product") {
        throw new Error(
          "discard_intervention_failed: connect ENOENT /fixture/runner.sock",
        );
      }
    });
    trace.push("runner:discard-after-close");
    try {
      await gate.discardIfConsumed(messageFor(
        (await ledger.get(ACTIVE_TURN_DELIVERY_IDS[0]))!,
      ), task);
    } catch (error) {
      followupQueueErrors += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("discard_intervention_failed")) {
        discardInterventionErrors += 1;
      }
      if (message.includes("ENOENT") && message.includes("runner.sock")) {
        runnerSocketSendErrors += 1;
      }
    }
  })();
  const secondReconnectWork = (async () => {
    await terminalRelease.wait();
    await reconnect("post_terminal_release");
  })();
  trace.push("terminal:barrier-released");
  terminalRelease.release();
  await Promise.all([terminalWork, secondReconnectWork]);

  const lifecycle = lifecycleFrom(broadcaster);
  const sessionUpdates = broadcaster.bufferedEvents
    .map((event) => event.payload)
    .filter((payload) => payload.type === "session_updated");
  return {
    counts: structuredClone(ledger.counts),
    pendingIds: ledger.pendingIds(),
    trace,
    reconnectAttempts: attempts.map(({ ready: _ready, ...attempt }) => attempt),
    lifecycle,
    preTerminalLifecycle,
    parentStatus: String(sessionUpdates.at(-1)?.status ?? "missing"),
    followupQueueErrors,
    discardInterventionErrors,
    runnerSocketSendErrors,
  };
}

function makeRecoverySql(
  ledger: RuntimeFollowupLedger,
  mode: RecoveryMode,
): SqlClient {
  return (async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<SessionDeliveryRow[]> => {
    const statement = strings.join("?");
    if (!statement.includes("WITH due AS MATERIALIZED")) {
      throw new Error(`Unexpected recovery SQL in fixture: ${statement}`);
    }
    const productQueryIncludesRuntime = statement.includes("'runtime_followup'");
    if (mode === "product" && !productQueryIncludesRuntime) return [];
    return ledger.claimRuntimeRows(String(values[2]));
  }) as unknown as SqlClient;
}

function lifecycleFrom(
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
) {
  const evidence = broadcaster.bufferedEvents.flatMap(({ payload }) => {
    const kind = payload.lifecycle_kind;
    const id = payload.lifecycle_id;
    return isLifecycleKind(kind) && typeof id === "string"
      ? [{ kind, id } satisfies LifecycleEvidence]
      : [];
  });
  return deriveLifecycle(evidence);
}

function isLifecycleKind(value: unknown): value is LifecycleEvidenceKind {
  return value === "generation"
    || value === "foreground_turn"
    || value === "assistant_turn";
}

function messageFor(row: SessionDeliveryRow): RuntimeInterventionMessage {
  return {
    text: String(row.payload.text),
    user: String(row.payload.user),
    source: row.source,
    deliveryId: row.delivery_id,
    deliveryIntent: row.intent,
    completionId: row.completion_id ?? undefined,
    relationKey: row.relation_key,
    producerTerminalRevision: row.producer_terminal_revision ?? undefined,
    runnerInterventionId: row.delivery_id,
  };
}

function makeTask(): RuntimeTask {
  return {
    agentSessionId: SESSION_ID,
    prompt: "foreground turn with runtime background tasks",
    status: "running",
    profileId: "roselin",
    createdAt: new Date("2026-08-28T10:00:00.000Z"),
    lastEventId: 9000,
    lastReadEventId: 9000,
    interventionQueue: [],
  };
}

function runnerWithDiscard(discardIntervention: () => Promise<void>) {
  return {
    engine: {} as never,
    dispatcher: { discardIntervention: vi.fn(discardIntervention) } as never,
    eventPersistence: "runner" as const,
  };
}

function requireDeliveryId(message: RuntimeInterventionMessage): string {
  if (!message.deliveryId) throw new Error("runtime follow-up lost delivery id");
  return message.deliveryId;
}
