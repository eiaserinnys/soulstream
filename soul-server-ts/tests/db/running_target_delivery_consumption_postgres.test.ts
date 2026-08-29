import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionDeliveryRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
} from "../../src/engine/protocol.js";
import { createInProcessTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import { TaskDeliveryLedgerGate } from
  "../../src/task/task_delivery_ledger_gate.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskInterventionRoute } from
  "../../src/task/task_intervention_route.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import { enqueueInterventionOnce } from
  "../../src/task/task_intervention_queue.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import type { SessionBroadcaster } from
  "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from
  "../task/event_persistence_test_double.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;
const SESSION_ID = "running-target-delivery-session";
const DELIVERY_IDS = [
  "running-target-delivery-1",
  "running-target-delivery-2",
  "running-target-delivery-3",
  "running-target-delivery-4",
] as const;

const agent: AgentProfile = {
  id: "claude-running-target",
  name: "Claude Running Target",
  backend: "claude",
  workspace_dir: "/tmp/claude-running-target",
};

describePostgres("running target delivery consumption PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_notification_outbox`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, session_type, status, agent_id)
      VALUES (${SESSION_ID}, 'node-test', 'claude', 'running', ${agent.id})
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("settles four routed human steers before the running target stops", async () => {
    const persistence = makeEventPersistenceTestDouble();
    const broadcaster = {
      emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
      emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionBroadcaster;
    const db = {
      updateSession: vi.fn().mockResolvedValue(undefined),
      setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionDB;
    const repository = new SessionDeliveryRepository(harness.sql);
    const ledger = new TaskDeliveryLedgerGate(true, repository);
    const executeInputs: EngineExecuteParams[] = [];
    const turnReady = Array.from({ length: 6 }, () => deferred<void>());
    const releaseTurn = Array.from({ length: 6 }, () => deferred<void>());
    let activeTurn = -1;
    const engine: EnginePort = {
      backendId: "claude",
      workspaceDir: agent.workspace_dir,
      async *execute(params): AsyncIterable<SSEEventPayload> {
        const turn = executeInputs.push(params) - 1;
        activeTurn = turn;
        yield turn === 0
          ? { type: "session", session_id: "claude-running-target-owner" }
          : {
              type: "assistant_message",
              content: `accepted turn ${turn}`,
              timestamp: turn,
            };
        turnReady[turn]!.resolve();
        await releaseTurn[turn]!.promise;
      },
      async intervene() {
        return {
          status: "not_delivered",
          mechanism: "interrupt_then_next_turn",
          reason: "no_active_turn",
        } as const;
      },
      async interrupt() {
        releaseTurn[activeTurn]!.resolve();
        return true;
      },
      async close() {
        for (const release of releaseTurn) release.resolve();
      },
    };
    const task: Task = {
      agentSessionId: SESSION_ID,
      prompt: "existing foreground turn",
      status: "running",
      profileId: agent.id,
      createdAt: new Date("2026-08-29T03:00:00.000Z"),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [],
    };
    const executor = new TaskExecutor(
      () => engine,
      db,
      persistence.persistence,
      broadcaster,
      pino({ level: "silent" }),
      undefined,
      undefined,
      undefined,
      undefined,
      ledger,
    );
    const route = new TaskInterventionRoute({
      getTask: (sessionId) => sessionId === SESSION_ID ? task : undefined,
      loadEvictedTask: async () => null,
      rememberTask: () => undefined,
      runningInterventionTransition: new RunningInterventionTransition({
        broadcaster,
        logger: pino({ level: "silent" }),
        persistence: persistence.persistence,
      }),
      autoResumeTransition: {
        resume: async () => {
          throw new Error("running target must not auto-resume");
        },
      },
      deliveryLedgerGate: ledger,
    });
    const runner = createInProcessTaskRunnerRuntime(engine);

    executor.startExecutionWithRunner(task, agent, runner);
    const execution = task.executionPromise!;

    try {
      await turnReady[0]!.promise;
      for (let index = 0; index < DELIVERY_IDS.length; index += 1) {
        const deliveryId = DELIVERY_IDS[index]!;
        await expect(route.addIntervention({
          agentSessionId: SESSION_ID,
          text: `live steer ${deliveryId}`,
          user: "director",
          source: "user_message",
          deliveryId,
          deliveryIntent: "human_live_steer",
          completionId: `message:${deliveryId}`,
          relationKey: `user_message:${SESSION_ID}:${deliveryId}`,
        }, () => {
          throw new Error("running target must keep its existing execution");
        })).resolves.toMatchObject({
          delivered: false,
          queued: true,
          consumeWhen: "next_turn",
        });
        await turnReady[index + 1]!.promise;
      }

      const runtimeFollowup: InterventionMessage = {
        text: "runtime follow-up keeps the target alive",
        user: "runtime",
        source: "claude_runtime_task_followup",
      };
      enqueueInterventionOnce(task, runtimeFollowup);
      releaseTurn[4]!.resolve();
      await turnReady[5]!.promise;

      const rows = await harness.sql<Array<{
        delivery_id: string;
        state: string;
        target_session_id: string | null;
        attempt_count: number;
        lease_owner: string | null;
        last_error: string | null;
        consumed_at: Date | null;
      }>>`
        SELECT
          delivery_id,
          state,
          target_session_id,
          attempt_count,
          lease_owner,
          last_error,
          consumed_at
        FROM session_deliveries
        WHERE target_session_id = ${SESSION_ID}
          AND intent = 'human_live_steer'
        ORDER BY delivery_id
      `;
      const queued = rows.filter((row) => row.state === "queued");
      const modelInputs = DELIVERY_IDS.map((deliveryId) => ({
        deliveryId,
        count: executeInputs.filter((input) => input.prompt.includes(deliveryId)).length,
      }));

      expect(task.status).toBe("running");
      expect(rows).toHaveLength(DELIVERY_IDS.length);
      expect(rows.map((row) => row.delivery_id)).toEqual([...DELIVERY_IDS]);
      expect(rows.every((row) => row.state === "consumed")).toBe(true);
      expect(rows.every((row) => row.target_session_id === SESSION_ID)).toBe(true);
      expect(rows.every((row) => row.attempt_count === 0)).toBe(true);
      expect(rows.every((row) => row.lease_owner?.startsWith("route:") === true)).toBe(true);
      expect(rows.every((row) => row.last_error === null)).toBe(true);
      expect(rows.every((row) => row.consumed_at !== null)).toBe(true);
      expect(modelInputs).toEqual(DELIVERY_IDS.map((deliveryId) => ({
        deliveryId,
        count: 1,
      })));
      expect(queued).toEqual([]);
    } finally {
      for (const release of releaseTurn) release.resolve();
      await execution;
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
