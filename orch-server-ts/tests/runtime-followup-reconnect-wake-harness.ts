import { vi } from "vitest";

import { loadContractFixtures, type NodeRegistrationPayload } from "../src/index.js";
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
  ALL_RUNTIME_FOLLOWUP_DELIVERY_IDS,
  RECONNECT_PENDING_DELIVERY_IDS,
  RUNTIME_FOLLOWUP_NODE_ID as NODE_ID,
  RUNTIME_FOLLOWUP_SESSION_ID as SESSION_ID,
  runtimeFollowupCommand,
  runtimeFollowupRow,
  runtimeFollowupSessionSnapshot,
  type RuntimeFollowupFixtureRow,
} from "./runtime-followup-reconnect-wake-fixture.js";
import type {
  DeliveryPhaseCounts,
  RuntimeFollowupWakeObservation,
} from "./runtime-followup-reconnect-wake-oracle.js";

type RecoveryMode = "product" | "counterfactual_runtime_claim";
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

async function loadTaskDeliveryLedgerGate(): Promise<RuntimeConstructor> {
  const module = await vi.importActual<Record<string, unknown>>(
    "../../soul-server-ts/src/task/task_delivery_ledger_gate.js",
  );
  return module.TaskDeliveryLedgerGate as RuntimeConstructor;
}

class FakeClock {
  private value = Date.parse("2026-08-28T10:05:00.000Z");

  nowMs = (): number => this.value;

  advance(ms: number): void {
    this.value += ms;
  }
}

class DeterministicBarrier {
  private releaseBarrier!: () => void;
  private arriveBarrier!: () => void;
  readonly arrived = new Promise<void>((resolve) => {
    this.arriveBarrier = resolve;
  });
  private readonly released = new Promise<void>((resolve) => {
    this.releaseBarrier = resolve;
  });

  async arriveAndWait(): Promise<void> {
    this.arriveBarrier();
    await this.released;
  }

  release(): void {
    this.releaseBarrier();
  }
}

class RuntimeFollowupLedger {
  private readonly rows = new Map<string, RuntimeFollowupFixtureRow>();
  readonly counts: Record<string, DeliveryPhaseCounts> = {};
  readonly consumeOrder: string[] = [];

  constructor() {
    RECONNECT_PENDING_DELIVERY_IDS.forEach((deliveryId, index) => {
      this.seed(runtimeFollowupRow(deliveryId, 5170 + index));
    });
  }

  seed(row: RuntimeFollowupFixtureRow): void {
    this.rows.set(row.delivery_id, structuredClone(row));
    this.counts[row.delivery_id] = {
      claim: 0,
      dispatch: 0,
      receipt: 0,
      consume: 0,
      stale: 0,
    };
  }

  seedActiveTurn(): RuntimeFollowupFixtureRow[] {
    return ACTIVE_TURN_DELIVERY_IDS.map((deliveryId, index) => {
      const row = runtimeFollowupRow(deliveryId, 5173 + index);
      row.state = "queued";
      row.claimed_at = row.created_at;
      row.queued_at = row.created_at;
      this.seed(row);
      this.counts[deliveryId]!.claim = 1;
      this.counts[deliveryId]!.dispatch = 1;
      return structuredClone(row);
    });
  }

  claimRuntimeRows(leaseOwner: string): SessionDeliveryRow[] {
    const claimed = [...this.rows.values()]
      .filter((row) => row.intent === "runtime_followup" && row.state === "pending")
      .sort((left, right) => left.enqueue_sequence - right.enqueue_sequence);
    for (const row of claimed) {
      row.state = "claimed";
      row.claimed_at = new Date("2026-08-28T10:05:01.000Z");
      row.lease_owner = leaseOwner;
      this.counts[row.delivery_id]!.claim += 1;
    }
    return claimed.map((row) => structuredClone(row) as SessionDeliveryRow);
  }

  releaseToPending(deliveryId: string): void {
    const row = this.require(deliveryId);
    row.state = "pending";
    row.claimed_at = null;
    row.lease_owner = null;
  }

  noteDispatch(deliveryId: string): void {
    const row = this.require(deliveryId);
    row.state = "queued";
    row.queued_at = new Date("2026-08-28T10:05:02.000Z");
    this.counts[deliveryId]!.dispatch += 1;
  }

  noteReceipt(deliveryId: string): void {
    this.counts[deliveryId]!.receipt += 1;
  }

  async get(deliveryId: string): Promise<SessionDeliveryRow | null> {
    const row = this.rows.get(deliveryId);
    return row ? structuredClone(row) as SessionDeliveryRow : null;
  }

  async markConsumed(
    deliveryId: string,
    receiptId: string,
  ): Promise<SessionDeliveryRow | null> {
    const row = this.rows.get(deliveryId);
    if (!row) return null;
    row.state = "consumed";
    row.aggregate_state = "consumed";
    row.target_receipt_id = receiptId;
    row.target_receipt_at = new Date("2026-08-28T10:05:03.000Z");
    row.consumed_at = row.target_receipt_at;
    row.consumed_reason = "foreground turn result";
    this.counts[deliveryId]!.consume += 1;
    this.consumeOrder.push(deliveryId);
    return structuredClone(row) as SessionDeliveryRow;
  }

  pendingIds(): string[] {
    return [...this.rows.values()]
      .filter((row) => row.state === "pending")
      .sort((left, right) => left.enqueue_sequence - right.enqueue_sequence)
      .map((row) => row.delivery_id);
  }

  private require(deliveryId: string): RuntimeFollowupFixtureRow {
    const row = this.rows.get(deliveryId);
    if (!row) throw new Error(`Missing runtime follow-up fixture ${deliveryId}`);
    return row;
  }
}

export async function observeRuntimeFollowupReconnect(input: {
  recoveryMode?: RecoveryMode;
  transportAvailable?: boolean;
  socketCloseRace?: boolean;
} = {}): Promise<RuntimeFollowupWakeObservation> {
  const recoveryMode = input.recoveryMode ?? "product";
  const transportAvailable = input.transportAvailable ?? true;
  const socketCloseRace = input.socketCloseRace ?? true;
  const TaskDeliveryLedgerGate = await loadTaskDeliveryLedgerGate();
  const ledger = new RuntimeFollowupLedger();
  const clock = new FakeClock();
  const trace: string[] = ["disconnect:pending:5170-5172"];
  const task = makeTask();
  const gate = new TaskDeliveryLedgerGate(true, ledger as never);
  let followupQueueErrors = 0;
  let discardInterventionErrors = 0;
  let runnerSocketSendErrors = 0;
  let foregroundTurns = 0;
  let assistantTurns = 0;
  let generations = 1;
  let earlyNewTurns = 0;
  let earlyCompletedTransitions = 0;

  const { registry, transports, router, bridge } = createHarnessCore({
    findSessionOwnerNodeId: async (sessionId) =>
      sessionId === SESSION_ID ? NODE_ID : null,
  });
  const registration = loadContractFixtures().fakeNodeReconnect.registration as
    NodeRegistrationPayload;
  const registered = registry.registerNode({ ...registration, node_id: NODE_ID });
  const connectionId = registered.node.connectionId;
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
          ledger.noteDispatch(deliveryId);
          task.interventionQueue.push(messageFor(row));
          registry.receiveNodeMessage({ nodeId: NODE_ID, connectionId }, {
            type: "intervene_ack",
            status: "ok",
            requestId: command.requestId,
          });
        },
      },
    });
  }

  const sql = makeRecoverySql(ledger, recoveryMode);
  const recovery = new SessionDeliveryRecoveryRepository(sql);
  const seedBarrier = new DeterministicBarrier();
  let nodeReadyWork: Promise<void> | undefined;
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
    onNodeReady: (_nodeId, readyConnectionId) => {
      nodeReadyWork = (async () => {
        trace.push("reconnect:cache-seed-complete");
        await seedBarrier.arriveAndWait();
        const leaseOwner = `node-ready:${NODE_ID}:${readyConnectionId}`;
        const claimed = await recovery.claimPendingHumanLiveSteerForNode(
          NODE_ID,
          leaseOwner,
        );
        trace.push(`reconnect:claimed:${claimed.length}`);
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
      })();
      return nodeReadyWork;
    },
  });
  sessionCacheSeed(registered.events);
  await seedBarrier.arrived;
  earlyNewTurns = generations - 1;
  earlyCompletedTransitions = task.status === "completed" ? 1 : 0;
  seedBarrier.release();
  await nodeReadyWork;
  clock.advance(1_000);

  for (const row of ledger.seedActiveTurn()) {
    task.interventionQueue.push(messageFor(row as SessionDeliveryRow));
  }
  trace.push("active-turn:queued:5173-5174");
  const turnMessages = [...task.interventionQueue];
  task.interventionQueue = [];
  foregroundTurns += 1;
  for (const message of turnMessages) {
    const deliveryId = requireDeliveryId(message);
    ledger.noteReceipt(deliveryId);
    await gate.recordTurnStarted(message, task);
  }
  assistantTurns += 1;
  for (const message of turnMessages) {
    await gate.recordConsumed(message, task, "event:9001");
  }
  task.status = "completed";
  trace.push("terminal:result-complete-runner-close");

  if (socketCloseRace) {
    task.runner = runnerWithDiscard(async () => {
      throw new Error(
        "discard_intervention_failed: connect ENOENT /fixture/runner.sock",
      );
    });
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
  }

  const duplicateDeliveries = duplicateCount(ledger.consumeOrder);
  return {
    counts: structuredClone(ledger.counts),
    pendingIds: ledger.pendingIds(),
    trace,
    parentStatus: task.status,
    foregroundTurns,
    generations,
    duplicateDeliveries,
    duplicateAssistantTurns: Math.max(0, assistantTurns - 1),
    followupQueueErrors,
    discardInterventionErrors,
    runnerSocketSendErrors,
    earlyNewTurns,
    earlyCompletedTransitions,
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
    const leaseOwner = String(values[2]);
    return ledger.claimRuntimeRows(leaseOwner);
  }) as unknown as SqlClient;
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

function duplicateCount(values: string[]): number {
  return values.length - new Set(values).size;
}

export function expectedRuntimeFollowupIds(): string[] {
  return [...ALL_RUNTIME_FOLLOWUP_DELIVERY_IDS];
}
