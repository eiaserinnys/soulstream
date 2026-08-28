import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../soul-server-ts/src/agent_registry.js";
import type { SessionDB } from "../../soul-server-ts/src/db/session_db.js";
import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
} from "../../soul-server-ts/src/db/session_db_types.js";
import type {
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
} from "../../soul-server-ts/src/engine/protocol.js";
import { QueuedDeliveryTranscriptRecovery } from
  "../../soul-server-ts/src/task/queued_delivery_transcript_recovery.js";
import { AutoResumeTransition } from
  "../../soul-server-ts/src/task/task_auto_resume_transition.js";
import { TaskDeliveryLedgerGate } from
  "../../soul-server-ts/src/task/task_delivery_ledger_gate.js";
import { buildCanonicalDeliveryPayload } from
  "../../soul-server-ts/src/task/delivery_payload.js";
import { buildDeliveryInputUuid } from
  "../../soul-server-ts/src/task/delivery_identity.js";
import { hydrateEvictedTaskFromSessionRow } from
  "../../soul-server-ts/src/task/task_evicted_hydration.js";
import { TaskExecutor } from "../../soul-server-ts/src/task/task_executor.js";
import { TaskInterventionRoute } from
  "../../soul-server-ts/src/task/task_intervention_route.js";
import type { Task } from "../../soul-server-ts/src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../soul-server-ts/src/task/task_running_intervention_transition.js";
import { CommandDispatcher } from
  "../../soul-server-ts/src/upstream/dispatcher.js";
import type { SessionBroadcaster } from
  "../../soul-server-ts/src/upstream/session_broadcaster.js";
import { makeEventPersistenceTestDouble } from
  "../../soul-server-ts/tests/task/event_persistence_test_double.js";
import {
  loadContractFixtures,
  type NodeRegistrationPayload,
} from "../src/index.js";
import { createSessionCacheSeedSink } from
  "../src/node/session_cache_seed_sink.js";
import { createHarnessCore } from "./session-action-command-test-helpers.js";
import {
  completedSessionRow,
  interventionBody,
  interventionCommand,
  LIVE_COMPLETED_DELIVERY_IDS,
  LIVE_COMPLETED_NODE_ID as NODE_ID,
  LIVE_COMPLETED_SESSION_ID as SESSION_ID,
  makeDeliveryRow,
} from "./completed-delivery-reconnect-fixture.js";

const DELIVERY_ID = LIVE_COMPLETED_DELIVERY_IDS[1];
const WORKER_ID = "restart-transcript:fake-node:new-connection";
const LEASE_OWNER = "node-ready:fake-node:new-connection";
const logger = {
  child: () => logger,
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
} as never;

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

describe("terminal queued delivery across node restart", () => {
  it("reconciles seq5046 absent input and consumes one resumed completed-session turn", async () => {
    const ledger = new RestartDeliveryLedger();
    const persistedEventTypes: string[] = [];
    const persistence = makeEventPersistenceTestDouble(async (_sessionId, event) => {
      persistedEventTypes.push(event.type);
    });
    const broadcaster = {
      emitEventEnvelope: vi.fn(async () => undefined),
      emitSessionUpdated: vi.fn(async () => undefined),
    } as unknown as SessionBroadcaster;
    const agent: AgentProfile = {
      id: "seosoyoung",
      name: "서소영",
      backend: "codex",
      workspace_dir: "/workspace/terminal-queued-restart",
    };
    const agentRegistry = {
      get: vi.fn(() => agent),
      list: vi.fn(() => [agent]),
    };
    const tasks = new Map<string, Task>();
    const modelInputs: EngineExecuteParams[] = [];
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: agent.workspace_dir,
      async *execute(params): AsyncIterable<SSEEventPayload> {
        modelInputs.push(params);
        yield {
          type: "assistant_message",
          content: "seq5046 recovered after restart",
          timestamp: 1,
        };
        yield {
          type: "complete",
          result: "seq5046 recovery completed",
        };
      },
      async interrupt() { return true; },
      async close() {},
    };
    const db = {
      getSession: vi.fn(async () => null),
      updateSession: vi.fn(async () => undefined),
      setClaudeSessionId: vi.fn(async () => undefined),
    } as unknown as SessionDB;
    const gate = new TaskDeliveryLedgerGate(true, ledger as never);
    const executor = new TaskExecutor(
      () => engine,
      db,
      persistence.persistence,
      broadcaster,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      gate,
    );
    const autoResume = new AutoResumeTransition({
      logger,
      persistence: persistence.persistence,
      agentRegistry: agentRegistry as never,
    });
    const running = new RunningInterventionTransition({
      broadcaster,
      logger,
      persistence: persistence.persistence,
      liveRetryDelayMs: 0,
      sleep: async () => undefined,
    });
    const queueOnly = vi.spyOn(running, "queueOnly");
    const autoResumeCall = vi.spyOn(autoResume, "resume");
    const route = new TaskInterventionRoute({
      getTask: (sessionId) => tasks.get(sessionId),
      loadEvictedTask: async (sessionId) => {
        if (sessionId !== SESSION_ID) return null;
        return hydrateEvictedTaskFromSessionRow(
          completedSessionRow("completed") as never,
          logger,
        );
      },
      rememberTask: (task) => tasks.set(task.agentSessionId, task),
      runningInterventionTransition: running,
      autoResumeTransition: autoResume,
      deliveryLedgerGate: gate,
    });
    const taskManager = {
      addIntervention: route.addIntervention.bind(route),
      getTask: (sessionId: string) => tasks.get(sessionId),
      listTasks: () => [...tasks.values()],
    };

    const { registry, transports, router, bridge } = createHarnessCore({
      findSessionOwnerNodeId: async (sessionId) =>
        sessionId === SESSION_ID ? NODE_ID : null,
    });
    let activeConnectionId: string | undefined;
    const dispatcher = new CommandDispatcher(
      async (frame) => {
        if (!activeConnectionId) throw new Error("new node connection is missing");
        registry.receiveNodeMessage(
          { nodeId: NODE_ID, connectionId: activeConnectionId },
          frame as Record<string, unknown>,
        );
      },
      logger,
      NODE_ID,
      agentRegistry as never,
      taskManager as never,
      executor,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    const transcriptInspect = vi.fn(async () => ({
      kind: "absent" as const,
      inputUuid: buildDeliveryInputUuid(DELIVERY_ID),
    }));
    const queuedRecovery = new QueuedDeliveryTranscriptRecovery({
      deliveryRepository: ledger as never,
      recoveryRepository: ledger as never,
      transcriptReceipt: { inspect: transcriptInspect },
      logger,
    }, WORKER_ID);
    let nodeReadyWork: Promise<void> | undefined;
    const sessionCacheSeed = createSessionCacheSeedSinkWithNodeReady({
      registry,
      repository: {
        listSessionSnapshots: async () => {
          const session = {
            ...completedSessionRow("completed"),
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
      logError: (error, message) => {
        throw new Error(`${message}: ${String(error)}`);
      },
      onNodeReady: (nodeId, connectionId) => {
        nodeReadyWork = (async () => {
          expect({ nodeId, connectionId }).toEqual({
            nodeId: NODE_ID,
            connectionId: activeConnectionId,
          });
          await queuedRecovery.recoverAfterNodeRestart(nodeId);
          const claimed = await ledger.claimPendingImmediateIntentsForNode(
            nodeId,
            LEASE_OWNER,
          );
          for (const row of claimed) {
            const routed = await router.routeExistingSessionPendingCommand({
              ...interventionCommand(row.delivery_id),
              delivery_lease_owner: LEASE_OWNER,
            } as never);
            await bridge.sendPendingCommand(routed);
          }
        })();
        return nodeReadyWork;
      },
    });

    const registration = loadContractFixtures().fakeNodeReconnect.registration as
      NodeRegistrationPayload;
    const oldNode = registry.registerNode({ ...registration, node_id: NODE_ID });
    const oldDispatches: string[] = [];
    transports.attach({
      nodeId: NODE_ID,
      connectionId: oldNode.node.connectionId,
      transport: {
        send: async (data) => {
          oldDispatches.push(data);
        },
      },
    });

    const newNode = registry.registerNode({ ...registration, node_id: NODE_ID });
    activeConnectionId = newNode.node.connectionId;
    const newDispatches: string[] = [];
    transports.attach({
      nodeId: NODE_ID,
      connectionId: activeConnectionId,
      transport: {
        send: async (data) => {
          newDispatches.push(data);
          await dispatcher.dispatch(JSON.parse(data));
        },
      },
    });
    sessionCacheSeed(newNode.events);
    await Promise.resolve();
    await nodeReadyWork;

    const task = tasks.get(SESSION_ID);
    if (task?.executionPromise) await task.executionPromise;
    const row = await ledger.get(DELIVERY_ID);
    const input = modelInputs[0];

    expect(oldNode.node.connectionId).not.toBe(activeConnectionId);
    expect(oldDispatches).toHaveLength(0);
    expect(newDispatches).toHaveLength(1);
    expect(transcriptInspect).toHaveBeenCalledOnce();
    expect(ledger.trace).toEqual([
      "queued",
      "transcript_claimed",
      "pending",
      "node_ready_claimed",
      "dispatching",
      "queued_after_route",
      "consumed",
    ]);
    expect(queueOnly).not.toHaveBeenCalled();
    expect(autoResumeCall).toHaveBeenCalledOnce();
    expect(persistence.acquireExecutionOwnershipAndWaitForApplication).toHaveBeenCalledOnce();
    expect(modelInputs).toHaveLength(1);
    expect(input).toMatchObject({
      inputUuid: buildDeliveryInputUuid(DELIVERY_ID),
      prompt: expect.stringContaining(interventionBody(DELIVERY_ID).text as string),
    });
    expect(persistedEventTypes.filter((type) => type === "assistant_message"))
      .toHaveLength(1);
    expect(persistedEventTypes.filter((type) => type === "complete")).toHaveLength(1);
    expect(ledger.consumeCount).toBe(1);
    expect(row).toMatchObject({
      state: "consumed",
      aggregate_state: "consumed",
      attempt_count: 1,
      target_receipt_id: expect.stringMatching(/^event:\d+$/),
      dead_lettered_at: null,
    });
    expect(task).toMatchObject({
      agentSessionId: SESSION_ID,
      status: "completed",
    });
  });
});

class RestartDeliveryLedger {
  private row: SessionDeliveryRow;
  readonly trace = ["queued"];
  consumeCount = 0;

  readonly notifications = {
    stageWithQueuedDelivery: vi.fn(),
    get: vi.fn(),
    markPublished: vi.fn(),
    retry: vi.fn(),
  };

  constructor() {
    const body = interventionBody(DELIVERY_ID);
    const canonical = buildCanonicalDeliveryPayload({
      text: String(body.text),
      user: String(body.user),
      source: String(body.source),
      completionId: String(body.completion_id),
      relationKey: String(body.relation_key),
    });
    this.row = {
      ...makeDeliveryRow({
        deliveryId: DELIVERY_ID,
        targetSessionId: SESSION_ID,
        relationKey: String(body.relation_key),
        completionId: String(body.completion_id),
        intent: "human_live_steer",
        source: "user_message",
        payloadHash: canonical.payloadHash,
        payload: canonical.payload,
        createdAt: new Date(String(body.created_at)),
      }),
      state: "queued",
      aggregate_state: "pending",
      attempt_count: 0,
      claimed_at: new Date("2026-08-28T15:09:01.000Z"),
      dispatching_at: new Date("2026-08-28T15:09:02.000Z"),
      queued_at: new Date("2026-08-28T15:09:03.000Z"),
      last_error: "queued_transcript_input_absent",
    };
  }

  readonly get = vi.fn(async (deliveryId: string) =>
    deliveryId === DELIVERY_ID ? structuredClone(this.row) : null);

  readonly register = vi.fn(async (_params: RegisterSessionDeliveryParams) => ({
    row: structuredClone(this.row),
    inserted: false,
    conflict: false,
  }));

  readonly claimQueuedAfterNodeRestart = vi.fn(async (
    _nodeId: string,
    workerId: string,
  ) => {
    if (this.row.state !== "queued") return [];
    this.row.lease_owner = workerId;
    this.row.lease_expires_at = new Date(Date.now() + 60_000);
    this.trace.push("transcript_claimed");
    return [structuredClone(this.row)];
  });

  readonly retryLeasedDelivery = vi.fn(async (
    deliveryId: string,
    leaseOwner: string,
    error: string,
  ) => {
    if (deliveryId !== DELIVERY_ID || this.row.lease_owner !== leaseOwner) return null;
    this.row.state = "pending";
    this.row.lease_owner = null;
    this.row.lease_expires_at = null;
    this.row.last_error = error;
    this.row.next_attempt_at = new Date();
    this.trace.push("pending");
    return structuredClone(this.row);
  });

  readonly claimPendingImmediateIntentsForNode = vi.fn(async (
    _nodeId: string,
    leaseOwner: string,
  ) => {
    if (this.row.state !== "pending") return [];
    this.row.state = "claimed";
    this.row.lease_owner = leaseOwner;
    this.row.lease_expires_at = new Date(Date.now() + 30_000);
    this.row.claimed_at = new Date();
    this.row.attempt_count += 1;
    this.trace.push("node_ready_claimed");
    return [structuredClone(this.row)];
  });

  readonly claimForTarget = vi.fn(async () => null);

  readonly beginDispatch = vi.fn(async (
    deliveryId: string,
    leaseOwner?: string,
  ) => {
    if (
      deliveryId !== DELIVERY_ID
      || this.row.state !== "claimed"
      || this.row.lease_owner !== leaseOwner
    ) return null;
    this.row.state = "dispatching";
    this.row.dispatching_at = new Date();
    this.trace.push("dispatching");
    return structuredClone(this.row);
  });

  readonly markQueued = vi.fn(async (
    deliveryId: string,
    leaseOwner?: string,
  ) => {
    if (
      deliveryId !== DELIVERY_ID
      || this.row.state !== "dispatching"
      || this.row.lease_owner !== leaseOwner
    ) return null;
    this.row.state = "queued";
    this.row.aggregate_state = "pending";
    this.row.queued_at = new Date();
    this.row.lease_owner = null;
    this.row.lease_expires_at = null;
    this.trace.push("queued_after_route");
    return structuredClone(this.row);
  });

  readonly markConsumed = vi.fn(async (deliveryId: string, receiptId: string) => {
    if (deliveryId !== DELIVERY_ID || this.row.state === "consumed") {
      return this.row.state === "consumed" ? structuredClone(this.row) : null;
    }
    if (this.row.state !== "queued" && this.row.state !== "delivered") return null;
    this.consumeCount += 1;
    this.row.state = "consumed";
    this.row.aggregate_state = "consumed";
    this.row.target_receipt_id = receiptId;
    this.row.target_receipt_at = new Date();
    this.row.consumed_at = new Date();
    this.row.consumed_reason = "foreground turn result";
    this.trace.push("consumed");
    return structuredClone(this.row);
  });

  readonly markDeliveredFromTranscript = vi.fn(async () => null);
  readonly deferQueuedTranscriptCheck = vi.fn(async () => null);
  readonly markDelivered = vi.fn(async () => null);
  readonly markUncertain = vi.fn(async () => null);
  readonly markConsumedByRelation = vi.fn(async () => null);
  readonly recordRelationConsumed = vi.fn(async () => null);
  readonly markPendingSuperseded = vi.fn(async () => null);
}
