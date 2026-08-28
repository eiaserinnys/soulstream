// 500-line exception: the deterministic two-node ledger, clock, execution
// fixture, retry-horizon oracle, and its mutation self-test stay together so
// the oracle cannot drift from the failure model it judges.
import { describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import type { AutoResumeTransition } from
  "../../src/task/task_auto_resume_transition.js";
import type {
  AddInterventionParams,
  AddInterventionResult,
} from "../../src/task/task_intervention_route.js";
import { TaskInterventionRoute } from
  "../../src/task/task_intervention_route.js";
import type {
  DeliveryLedgerAdmission,
  TaskDeliveryLedgerGate,
} from "../../src/task/task_delivery_ledger_gate.js";
import { TaskOwnedByAnotherNodeError } from
  "../../src/task/task_hydration_errors.js";
import type { Task } from "../../src/task/task_models.js";
import type { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import {
  sendMessageToSession,
  type SendMessageToSessionDeps,
} from "../../src/task/session_message_sender.js";
import { buildInterveneAck } from
  "../../src/upstream/task_runtime_commands.js";

const TARGET_SESSION_ID = "target-on-owner-node";
const RETRY_HORIZON_MS = 11 * 60 * 1_000;

type ExecutionObservation = {
  userMessages: number;
  targetInputs: number;
  executions: number;
  assistantMessages: number;
  results: number;
};

type ExactOnceObservation = ExecutionObservation & {
  deliveryTotal: number;
  consumedDeliveries: number;
  retryHorizonAdditionalTurns: number;
};

type StoredDelivery = {
  row: SessionDeliveryRow;
  request: AddInterventionParams;
};

class FakeClock {
  now = Date.parse("2026-08-24T13:29:00.000Z");

  advanceBy(milliseconds: number): void {
    this.now += milliseconds;
  }
}

class SharedDeliveryLedger {
  readonly rows = new Map<string, StoredDelivery>();
  readonly admissions = new Map<string, number>();

  constructor(private readonly clock: FakeClock) {}

  gate(nodeId: string): Pick<
    TaskDeliveryLedgerGate,
    "admit" | "beginDispatch" | "recordResult" | "recordFailure"
      | "recordNotificationPublished" | "recordNotificationFailure"
      | "recordReservationRetry"
  > {
    return {
      admit: async (request) => {
        this.admissions.set(nodeId, (this.admissions.get(nodeId) ?? 0) + 1);
        if (!request.deliveryId || !request.deliveryIntent ||
          !request.relationKey || !request.completionId) {
          throw new Error("test ledger requires the canonical delivery identity");
        }
        let stored = this.rows.get(request.deliveryId);
        if (!stored) {
          stored = {
            request: { ...request },
            row: makeDeliveryRow(request, nodeId, this.clock.now),
          };
          this.rows.set(request.deliveryId, stored);
        } else {
          stored.row.state = "claimed";
          stored.row.aggregate_state = "pending";
          stored.row.lease_owner = `route:${nodeId}`;
          stored.row.lease_expires_at = new Date(
            this.clock.now + RETRY_HORIZON_MS,
          );
        }
        return admitted(stored.row);
      },
      beginDispatch: async (admission) => {
        if (admission.kind !== "admitted") return admission;
        const stored = this.rows.get(admission.deliveryId);
        if (!stored) throw new Error(`unknown delivery ${admission.deliveryId}`);
        stored.row = {
          ...stored.row,
          state: "dispatching",
          dispatching_at: new Date(this.clock.now),
        };
        return { ...admission, row: stored.row };
      },
      recordResult: async (admission, result) => {
        if (admission.kind !== "admitted") return;
        if ("autoResumed" in result || "queued" in result) {
          const stored = this.rows.get(admission.deliveryId);
          if (!stored) throw new Error(`unknown delivery ${admission.deliveryId}`);
          stored.row.state = "queued";
          stored.row.aggregate_state = "queued";
          stored.row.queued_at = new Date(this.clock.now);
        }
      },
      recordFailure: async (admission) => {
        if (admission.kind !== "admitted") return;
        admission.row.last_error = "NOT_OWNER";
      },
      recordNotificationPublished: async () => {},
      recordNotificationFailure: async () => {},
      recordReservationRetry: async () => "scheduled",
    };
  }

  markConsumed(deliveryId: string): void {
    const stored = this.rows.get(deliveryId);
    if (!stored) throw new Error(`unknown delivery ${deliveryId}`);
    stored.row.state = "consumed";
    stored.row.aggregate_state = "consumed";
    stored.row.consumed_at = new Date(this.clock.now);
    stored.row.target_receipt_id = `event:${deliveryId}`;
  }

  async recoverDue(
    deliver: (request: AddInterventionParams) => Promise<void>,
  ): Promise<void> {
    for (const [deliveryId, stored] of [...this.rows]) {
      if (stored.row.aggregate_state === "consumed") continue;
      if ((stored.row.lease_expires_at?.getTime() ?? Infinity) > this.clock.now) {
        continue;
      }
      // resolveTask currently throws before the route's try/catch, so the
      // NOT_OWNER row receives no recordFailure call. It remains claimed until
      // the ordinary expired-lease recovery horizon makes it eligible again.
      stored.row.attempt_count += 1;
      stored.row.next_attempt_at = new Date(this.clock.now);
      await deliver({
        ...stored.request,
        deliveryLeaseOwner: "recovery:owner-node",
        deliveryCreatedAt: stored.row.created_at.toISOString(),
        storedDeliveryPayload: stored.row.payload,
        storedDeliveryPayloadHash: stored.row.payload_hash,
      });
    }
  }

  snapshot(execution: ExecutionObservation, turnsBeforeHorizon: number): ExactOnceObservation {
    const rows = [...this.rows.values()].map(({ row }) => row);
    return {
      deliveryTotal: rows.length,
      consumedDeliveries: rows.filter(
        (row) => row.aggregate_state === "consumed",
      ).length,
      ...execution,
      retryHorizonAdditionalTurns: execution.executions - turnsBeforeHorizon,
    };
  }
}

function makeDeliveryRow(
  request: AddInterventionParams,
  nodeId: string,
  now: number,
): SessionDeliveryRow {
  return {
    delivery_id: request.deliveryId!,
    target_session_id: request.agentSessionId,
    source_session_id: null,
    relation_key: request.relationKey!,
    completion_id: request.completionId!,
    intent: request.deliveryIntent!,
    source: request.source ?? "user_message",
    producer_kind: null,
    producer_id: null,
    producer_terminal_revision: null,
    parent_delivery_id: null,
    caller_turn_id: null,
    payload_hash: `hash:${request.deliveryId}`,
    payload: {
      text: request.text,
      user: request.user,
      attachment_paths: request.attachmentPaths ?? null,
      context: request.context ?? null,
      caller_info: request.callerInfo ?? null,
      followup_key: request.followupKey ?? null,
      followup_attempt: request.followupAttempt ?? null,
      followup_task_ids: request.followupTaskIds ?? null,
    },
    state: "claimed",
    aggregate_state: "pending",
    created_at: new Date(now),
    updated_at: new Date(now),
    claimed_at: new Date(now),
    dispatching_at: null,
    lease_owner: `route:${nodeId}`,
    lease_expires_at: new Date(now + RETRY_HORIZON_MS),
    attempt_count: 0,
    next_attempt_at: new Date(now),
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

function admitted(row: SessionDeliveryRow): DeliveryLedgerAdmission {
  return { kind: "admitted", deliveryId: row.delivery_id, row };
}

function terminalTask(): Task {
  return {
    agentSessionId: TARGET_SESSION_ID,
    prompt: "probe",
    status: "completed",
    createdAt: new Date("2026-08-24T13:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function forbiddenRunningTransition(): Pick<
  RunningInterventionTransition,
  "deliver" | "queueOnly"
> {
  return {
    deliver: vi.fn(async () => {
      throw new Error("terminal test target must not use live delivery");
    }),
    queueOnly: vi.fn(async () => {
      throw new Error("terminal test target must not use queue-only delivery");
    }),
  } as unknown as Pick<RunningInterventionTransition, "deliver" | "queueOnly">;
}

function makeOwnerNode(ledger: SharedDeliveryLedger) {
  const task = terminalTask();
  const execution: ExecutionObservation = {
    userMessages: 0,
    targetInputs: 0,
    executions: 0,
    assistantMessages: 0,
    results: 0,
  };
  const pendingDeliveryIds: string[] = [];
  const autoResumeTransition = {
    resume: vi.fn(async (
      resumedTask: Task,
      message: { deliveryId?: string },
      onResume: (task: Task) => void,
      options?: { publishUserMessage?: boolean },
    ): Promise<AddInterventionResult> => {
      if (!message.deliveryId) throw new Error("owner received no delivery identity");
      if (options?.publishUserMessage !== false) execution.userMessages += 1;
      pendingDeliveryIds.push(message.deliveryId);
      onResume(resumedTask);
      return { autoResumed: true };
    }),
  } as unknown as Pick<AutoResumeTransition, "resume">;
  const route = new TaskInterventionRoute({
    getTask: () => task,
    loadEvictedTask: async () => task,
    rememberTask: () => {},
    runningInterventionTransition: forbiddenRunningTransition(),
    autoResumeTransition,
    deliveryLedgerGate: ledger.gate("owner-node"),
  });
  const onResume = () => {
    const deliveryId = pendingDeliveryIds.shift();
    if (!deliveryId) throw new Error("execution started without an admitted input");
    execution.targetInputs += 1;
    execution.executions += 1;
    execution.assistantMessages += 1;
    execution.results += 1;
    ledger.markConsumed(deliveryId);
    task.status = "completed";
  };
  return { route, execution, onResume };
}

function makeNonOwnerRoute(ledger: SharedDeliveryLedger): TaskInterventionRoute {
  return new TaskInterventionRoute({
    getTask: () => undefined,
    loadEvictedTask: async (sessionId) => {
      throw new TaskOwnedByAnotherNodeError(
        sessionId,
        "owner-node",
        "local-node",
      );
    },
    rememberTask: () => {},
    runningInterventionTransition: forbiddenRunningTransition(),
    autoResumeTransition: {
      resume: vi.fn(async () => {
        throw new Error("non-owner must not auto-resume the target");
      }),
    } as unknown as Pick<AutoResumeTransition, "resume">,
    deliveryLedgerGate: ledger.gate("local-node"),
  });
}

function relayFetch(owner: ReturnType<typeof makeOwnerNode>): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const result = await owner.route.addIntervention({
      agentSessionId: TARGET_SESSION_ID,
      text: String(body.text),
      user: String(body.user),
      ...(isString(body.delivery_id) ? { deliveryId: body.delivery_id } : {}),
      ...(isString(body.delivery_intent)
        ? { deliveryIntent: body.delivery_intent as AddInterventionParams["deliveryIntent"] }
        : {}),
      ...(isString(body.source) ? { source: body.source } : {}),
      ...(isString(body.completion_id) ? { completionId: body.completion_id } : {}),
      ...(isString(body.relation_key) ? { relationKey: body.relation_key } : {}),
      ...(isString(body.created_at) ? { deliveryCreatedAt: body.created_at } : {}),
      ...(body.caller_info && typeof body.caller_info === "object"
        ? { callerInfo: body.caller_info as AddInterventionParams["callerInfo"] }
        : {}),
    }, owner.onResume);
    return new Response(JSON.stringify(buildInterveneAck({
      requestId: "relay-request",
      agentSessionId: TARGET_SESSION_ID,
      result,
    })), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function silentLogger(): SendMessageToSessionDeps["logger"] {
  return { warn: () => {} } as unknown as SendMessageToSessionDeps["logger"];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function exactOnceDifferences(observation: ExactOnceObservation): string[] {
  const expected: ExactOnceObservation = {
    deliveryTotal: 1,
    consumedDeliveries: 1,
    userMessages: 1,
    targetInputs: 1,
    executions: 1,
    assistantMessages: 1,
    results: 1,
    retryHorizonAdditionalTurns: 0,
  };
  return Object.entries(expected).flatMap(([key, value]) =>
    observation[key as keyof ExactOnceObservation] === value
      ? []
      : [`${key}: expected ${value}, got ${observation[key as keyof ExactOnceObservation]}`]
  );
}

describe("sendMessageToSession cross-node exact-once", () => {
  it("one cross-node send owns one delivery and one turn after the retry horizon", async () => {
    const clock = new FakeClock();
    const ledger = new SharedDeliveryLedger(clock);
    const owner = makeOwnerNode(ledger);
    const nonOwnerRoute = makeNonOwnerRoute(ledger);

    const result = await sendMessageToSession({
      taskManager: {
        addIntervention: (params, onResume) =>
          nonOwnerRoute.addIntervention(params, onResume),
      },
      nodeId: "local-node",
      sessionLookup: {
        getSession: async () => ({ node_id: "owner-node" }),
      },
      onResume: () => {
        throw new Error("non-owner resumed the target");
      },
      logger: silentLogger(),
      orch: { baseUrl: "http://orch.test", headers: {} },
      fetchImpl: relayFetch(owner),
    }, {
      targetSessionId: TARGET_SESSION_ID,
      message: "single logical message",
    });

    expect(result).toMatchObject({
      ok: true,
      detail: { relayed: true, outcome: "auto_resumed", delivered: true },
    });
    const turnsBeforeHorizon = owner.execution.executions;
    clock.advanceBy(RETRY_HORIZON_MS - 1);
    await ledger.recoverDue(async (request) => {
      await owner.route.addIntervention(request, owner.onResume);
    });
    expect(owner.execution.executions).toBe(turnsBeforeHorizon);

    clock.advanceBy(1);
    await ledger.recoverDue(async (request) => {
      await owner.route.addIntervention(request, owner.onResume);
    });
    const observation = ledger.snapshot(owner.execution, turnsBeforeHorizon);

    expect(
      exactOnceDifferences(observation),
      JSON.stringify({
        observation,
        localAdmissions: ledger.admissions.get("local-node") ?? 0,
        ownerAdmissions: ledger.admissions.get("owner-node") ?? 0,
      }),
    ).toEqual([]);
    expect(ledger.admissions.get("local-node") ?? 0).toBe(0);
    expect(ledger.admissions.get("owner-node") ?? 0).toBe(1);
  });

  it("keeps the same-node path at one local admission and one turn", async () => {
    const clock = new FakeClock();
    const ledger = new SharedDeliveryLedger(clock);
    const owner = makeOwnerNode(ledger);
    const result = await sendMessageToSession({
      taskManager: {
        addIntervention: (params, onResume) =>
          owner.route.addIntervention(params, onResume),
      },
      nodeId: "owner-node",
      sessionLookup: {
        getSession: async () => ({ node_id: "owner-node" }),
      },
      onResume: owner.onResume,
      logger: silentLogger(),
      orch: { baseUrl: "http://orch.test", headers: {} },
      fetchImpl: async () => {
        throw new Error("same-node send must not relay");
      },
    }, {
      targetSessionId: TARGET_SESSION_ID,
      message: "same-node logical message",
    });

    expect(result).toMatchObject({ ok: true, detail: { autoResumed: true } });
    const turnsBeforeHorizon = owner.execution.executions;
    clock.advanceBy(RETRY_HORIZON_MS);
    await ledger.recoverDue(async (request) => {
      await owner.route.addIntervention(request, owner.onResume);
    });
    expect(exactOnceDifferences(
      ledger.snapshot(owner.execution, turnsBeforeHorizon),
    )).toEqual([]);
    expect(ledger.admissions.get("owner-node") ?? 0).toBe(1);
  });

  it("reroutes an owner handoff with one identity and no non-owner admission", async () => {
    const clock = new FakeClock();
    const ledger = new SharedDeliveryLedger(clock);
    const owner = makeOwnerNode(ledger);
    const nonOwnerRoute = makeNonOwnerRoute(ledger);
    const ownerSequence = ["local-node", "owner-node"];
    const getSession = vi.fn(async () => ({
      node_id: ownerSequence.shift() ?? "owner-node",
    }));

    const result = await sendMessageToSession({
      taskManager: {
        // The owner was local at preflight, then moved before the route
        // resolved the task. The former owner must not admit the delivery.
        addIntervention: (params, onResume) =>
          nonOwnerRoute.addIntervention(params, onResume),
      },
      nodeId: "local-node",
      sessionLookup: { getSession },
      onResume: () => {
        throw new Error("former owner resumed the target");
      },
      logger: silentLogger(),
      orch: { baseUrl: "http://orch.test", headers: {} },
      fetchImpl: relayFetch(owner),
    }, {
      targetSessionId: TARGET_SESSION_ID,
      message: "handoff logical message",
    });

    expect(result).toMatchObject({
      ok: true,
      detail: { relayed: true, outcome: "auto_resumed", delivered: true },
    });
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(ledger.rows.size).toBe(1);
    expect(ledger.admissions.get("local-node") ?? 0).toBe(0);
    expect(ledger.admissions.get("owner-node") ?? 0).toBe(1);
    expect(owner.execution).toMatchObject({
      targetInputs: 1,
      executions: 1,
      assistantMessages: 1,
      results: 1,
    });
  });

  it("retries a temporary relay failure with the same delivery identity", async () => {
    const clock = new FakeClock();
    const ledger = new SharedDeliveryLedger(clock);
    const owner = makeOwnerNode(ledger);
    const relay = relayFetch(owner);
    const identities: string[] = [];
    let attempts = 0;

    const result = await sendMessageToSession({
      taskManager: {
        addIntervention: async () => {
          throw new Error("remote owner must not receive a local admission");
        },
      },
      nodeId: "local-node",
      sessionLookup: { getSession: async () => ({ node_id: "owner-node" }) },
      onResume: () => {},
      logger: silentLogger(),
      orch: { baseUrl: "http://orch.test", headers: {} },
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        identities.push(String(body.delivery_id));
        attempts += 1;
        if (attempts === 1) throw new Error("temporary connection reset");
        return relay(url, init);
      },
    }, {
      targetSessionId: TARGET_SESSION_ID,
      message: "retry logical message",
    });

    expect(result).toMatchObject({ ok: true, detail: { relayed: true } });
    expect(identities).toHaveLength(2);
    expect(new Set(identities).size).toBe(1);
    expect(ledger.rows.size).toBe(1);
    expect(ledger.admissions.get("local-node") ?? 0).toBe(0);
    expect(ledger.admissions.get("owner-node") ?? 0).toBe(1);
    expect(owner.execution.executions).toBe(1);
  });

  it.each([
    {
      kind: "missing",
      lookupNodeId: null,
      failureMessage: `Task not found: ${TARGET_SESSION_ID}`,
      loadEvictedTask: async () => null,
    },
    {
      kind: "hydration",
      lookupNodeId: "local-node",
      failureMessage: `Task hydration failed: ${TARGET_SESSION_ID}`,
      loadEvictedTask: async () => {
        throw new Error(`Task hydration failed: ${TARGET_SESSION_ID}`);
      },
    },
  ])("keeps $kind failures explicit without a local delivery row", async ({
    lookupNodeId,
    failureMessage,
    loadEvictedTask,
  }) => {
    const clock = new FakeClock();
    const ledger = new SharedDeliveryLedger(clock);
    const route = new TaskInterventionRoute({
      getTask: () => undefined,
      loadEvictedTask,
      rememberTask: () => {},
      runningInterventionTransition: forbiddenRunningTransition(),
      autoResumeTransition: {
        resume: vi.fn(async () => {
          throw new Error("resolution failure must not resume");
        }),
      } as unknown as Pick<AutoResumeTransition, "resume">,
      deliveryLedgerGate: ledger.gate("local-node"),
    });
    const result = await sendMessageToSession({
      taskManager: {
        addIntervention: (params, onResume) =>
          route.addIntervention(params, onResume),
      },
      nodeId: "local-node",
      sessionLookup: {
        getSession: async () => lookupNodeId === null
          ? null
          : { node_id: lookupNodeId },
      },
      onResume: () => {},
      logger: silentLogger(),
    }, {
      targetSessionId: TARGET_SESSION_ID,
      message: "failure contract",
    });

    expect(result).toEqual({
      ok: false,
      error: failureMessage,
      fallback_error: "orch fallback unavailable",
    });
    expect(ledger.rows.size).toBe(0);
    expect(ledger.admissions.get("local-node") ?? 0).toBe(0);
  });

  it("fails an unavailable owner lookup explicitly before any delivery side effect", async () => {
    const addIntervention = vi.fn(async () => ({ delivered: true as const }));
    const fetchImpl = vi.fn(async () => new Response("unexpected relay"));
    const result = await sendMessageToSession({
      taskManager: { addIntervention },
      nodeId: "local-node",
      sessionLookup: {
        getSession: async () => {
          throw new Error("session owner store unavailable");
        },
      },
      onResume: () => {},
      logger: silentLogger(),
      orch: { baseUrl: "http://orch.test", headers: {} },
      fetchImpl,
    }, {
      targetSessionId: TARGET_SESSION_ID,
      message: "owner lookup failure contract",
    });

    expect(result).toEqual({
      ok: false,
      error: "session owner store unavailable",
      fallback_error: "target owner lookup failed: session owner store unavailable",
    });
    expect(addIntervention).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("oracle rejects each independently weakened exact-once dimension", () => {
    const valid: ExactOnceObservation = {
      deliveryTotal: 1,
      consumedDeliveries: 1,
      userMessages: 1,
      targetInputs: 1,
      executions: 1,
      assistantMessages: 1,
      results: 1,
      retryHorizonAdditionalTurns: 0,
    };
    expect(exactOnceDifferences(valid)).toEqual([]);
    for (const key of [
      "deliveryTotal",
      "consumedDeliveries",
      "userMessages",
      "targetInputs",
      "executions",
      "assistantMessages",
      "results",
    ] as const) {
      expect(exactOnceDifferences({ ...valid, [key]: 2 }), key).not.toEqual([]);
    }
    expect(exactOnceDifferences({
      ...valid,
      retryHorizonAdditionalTurns: 1,
    })).not.toEqual([]);
  });
});
