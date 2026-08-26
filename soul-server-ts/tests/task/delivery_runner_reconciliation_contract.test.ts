import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EngineExecuteParams, SSEEventPayload } from "../../src/engine/protocol.js";
import { engineEventFrame } from "../../src/runner/frame_protocol.js";
import { RunnerProcessEngineProxy } from
  "../../src/runner/runner_process_engine_proxy.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import type {
  DeliveryLedgerAdmission,
  TaskDeliveryLedgerGate,
} from "../../src/task/task_delivery_ledger_gate.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });
const agent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

type TerminalDeliveryState = "consumed" | "delivered" | "dead_letter";

interface LocalInboxRow {
  interventionId: string;
  message: InterventionMessage;
}

function makeTerminalTask(): Task {
  return {
    agentSessionId: "session-d-reconciliation",
    prompt: "previous prompt",
    status: "completed",
    profileId: agent.id,
    createdAt: new Date("2026-08-23T20:00:00.000Z"),
    completedAt: new Date("2026-08-23T20:01:00.000Z"),
    lastEventId: 10,
    terminalEventId: 10,
    lastReadEventId: 10,
    interventionQueue: [],
  };
}

function makeLedgerGate(terminalStates: ReadonlyMap<string, TerminalDeliveryState>) {
  const admit = vi.fn(async (params: {
    deliveryId?: string;
    text: string;
    user: string;
  }): Promise<DeliveryLedgerAdmission> => {
    const deliveryId = params.deliveryId;
    if (!deliveryId) return { kind: "legacy" };
    const terminalState = terminalStates.get(deliveryId);
    if (terminalState) {
      return {
        kind: "suppressed",
        deliveryId,
        reason: terminalState === "dead_letter"
          ? "delivery_dead_letter"
          : `delivery_${terminalState}`,
      };
    }
    return {
      kind: "admitted",
      deliveryId,
      row: {
        delivery_id: deliveryId,
        intent: "durable_next_turn",
        source: "completion_notifier",
        completion_id: `completion:${deliveryId}`,
        relation_key: `relation:${deliveryId}`,
        producer_terminal_revision: null,
        parent_delivery_id: null,
        caller_turn_id: null,
        lease_owner: "route-contract",
        attempt_count: 1,
        created_at: new Date("2026-08-23T20:02:00.000Z"),
        payload: {
          text: params.text,
          user: params.user,
          attachment_paths: null,
          context: null,
          caller_info: null,
          followup_task_ids: null,
        },
        payload_hash: `hash:${deliveryId}`,
      } as never,
    };
  });
  const beginDispatch = vi.fn(async (admission: DeliveryLedgerAdmission) => admission);
  const recordResult = vi.fn(async () => undefined);
  const recordFailure = vi.fn(async () => undefined);
  const recordReservationRetry = vi.fn(async () => "retryable" as const);
  const recordConsumed = vi.fn(async () => undefined);
  const recordTurnStarted = vi.fn(async () => "turn-contract");
  return {
    admit,
    beginDispatch,
    recordResult,
    recordFailure,
    recordReservationRetry,
    recordConsumed,
    recordTurnStarted,
  } as unknown as Pick<
    TaskDeliveryLedgerGate,
    "admit" | "beginDispatch" | "recordResult" | "recordFailure"
      | "recordReservationRetry" | "recordConsumed" | "recordTurnStarted"
  >;
}

function makeRunner(localRows: readonly LocalInboxRow[]) {
  const openRows = new Map(localRows.map((row) => [row.interventionId, row]));
  const executed: EngineExecuteParams[] = [];
  const dispatcher = {
    executeFrames: vi.fn((params: EngineExecuteParams) => (async function* () {
      executed.push(params);
      const interventionId = params.runnerInterventionId;
      if (interventionId && !openRows.has(interventionId)) {
        throw new Error(`execute_intervention_claim_failed:${interventionId}`);
      }
      yield engineEventFrame({
        type: "assistant_message",
        content: `handled:${params.prompt}`,
      });
      yield engineEventFrame({ type: "complete", result: "done", timestamp: 1 });
      if (interventionId) openRows.delete(interventionId);
    })()),
    prepareSession: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    detachHost: vi.fn(async () => undefined),
    waitForSessionAck: vi.fn(async () => null),
    recoverPendingInterventions: vi.fn(async () => [...openRows.values()]),
    invoke: vi.fn(async () => undefined),
  };
  const runner: TaskRunnerRuntime = {
    engine: new RunnerProcessEngineProxy(
      "codex",
      agent.workspace_dir,
      dispatcher as never,
    ),
    dispatcher: dispatcher as never,
    eventPersistence: "runner",
  };
  return { runner, openRows, executed, dispatcher };
}

function deliveryMessage(deliveryId: string, text: string): InterventionMessage {
  return {
    text,
    user: "system",
    source: "completion_notifier",
    deliveryId,
    deliveryIntent: "durable_next_turn",
    completionId: `completion:${deliveryId}`,
    relationKey: `relation:${deliveryId}`,
  };
}

function makeHarness(input: {
  terminalStates?: ReadonlyMap<string, TerminalDeliveryState>;
  localRows?: readonly LocalInboxRow[];
}) {
  const task = makeTerminalTask();
  const persistenceDouble = makeEventPersistenceTestDouble();
  const ledgerGate = makeLedgerGate(input.terminalStates ?? new Map());
  const { runner, openRows, executed, dispatcher } = makeRunner(input.localRows ?? []);
  const db = {
    updateSession: vi.fn(async () => undefined),
    setClaudeSessionId: vi.fn(async () => undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn(async () => undefined),
    emitSessionUpdated: vi.fn(async () => undefined),
  } as unknown as SessionBroadcaster;
  const executor = new TaskExecutor(
    () => runner.engine,
    db,
    persistenceDouble.persistence,
    broadcaster,
    silentLogger,
    undefined,
    undefined,
    undefined,
    undefined,
    ledgerGate,
  );
  const autoResumeTransition = new AutoResumeTransition({
    logger: silentLogger,
    persistence: persistenceDouble.persistence,
  });
  const queued = {
    delivered: false,
    queued: true,
    queuePosition: 1,
    consumeWhen: "next_turn",
    reason: "queue_only_policy",
  } as const;
  const runningInterventionTransition = {
    deliver: vi.fn(async () => queued),
    queueOnly: vi.fn(async () => queued),
  } as unknown as Pick<RunningInterventionTransition, "deliver" | "queueOnly">;
  const route = new TaskInterventionRoute({
    getTask: () => task,
    loadEvictedTask: vi.fn(async () => null),
    rememberTask: vi.fn(),
    runningInterventionTransition,
    autoResumeTransition,
    deliveryLedgerGate: ledgerGate,
  });
  const resume = async (message: InterventionMessage) => {
    const result = await route.addIntervention({
      agentSessionId: task.agentSessionId,
      ...message,
    }, (resumedTask) => executor.startExecutionWithRunner(resumedTask, agent, runner));
    await task.executionPromise;
    return result;
  };
  return { task, route, resume, openRows, executed, dispatcher, ledgerGate };
}

describe("central delivery ↔ runner inbox reconciliation contract", () => {
  it.each([
    "consumed",
    "delivered",
    "dead_letter",
  ] as const)(
    "does not restore a locally pending delivery after central %s suppression",
    async (terminalState) => {
      const staleId = `delivery-${terminalState}`;
      const fresh = deliveryMessage("delivery-fresh", "fresh resume");
      const harness = makeHarness({
        terminalStates: new Map([[staleId, terminalState]]),
        localRows: [{
          interventionId: staleId,
          message: deliveryMessage(staleId, `stale ${terminalState}`),
        }],
      });

      await expect(harness.route.addIntervention({
        agentSessionId: harness.task.agentSessionId,
        ...deliveryMessage(staleId, `stale ${terminalState}`),
      }, vi.fn())).resolves.toMatchObject({
        suppressed: true,
        deliveryId: staleId,
      });

      await expect(harness.resume(fresh)).resolves.toEqual({ autoResumed: true });
      expect(harness.executed.map((input) => input.prompt)).toEqual(["fresh resume"]);
    },
  );

  it("auto-resumes a central delivery when no local inbox row exists", async () => {
    const harness = makeHarness({});

    await expect(harness.resume(
      deliveryMessage("delivery-central-only", "central only"),
    )).resolves.toEqual({ autoResumed: true });

    expect(harness.executed.map((input) => input.prompt)).toEqual(["central only"]);
    expect([...harness.openRows.keys()]).toEqual([]);
    expect(harness.task.status).toBe("completed");
  });

  it("settles a matching local inbox row when central auto-resume completes", async () => {
    const deliveryId = "delivery-shared";
    const message = deliveryMessage(deliveryId, "shared delivery");
    const harness = makeHarness({
      localRows: [{ interventionId: deliveryId, message }],
    });

    await expect(harness.resume(message)).resolves.toEqual({ autoResumed: true });

    expect(harness.executed.map((input) => input.prompt)).toEqual(["shared delivery"]);
    expect([...harness.openRows.keys()]).toEqual([]);
  });
});
