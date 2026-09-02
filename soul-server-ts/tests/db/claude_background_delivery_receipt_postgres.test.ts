import { spawnSync } from "node:child_process";

import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionDeliveryRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import type { SqlClient } from "../../src/db/session_db.js";
import { buildDeterministicDeliveryIdentity } from
  "../../src/task/delivery_identity.js";
import { buildCanonicalDeliveryPayload } from
  "../../src/task/delivery_payload.js";
import { CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE } from
  "../../src/task/claude_runtime_task_followup.js";
import { TaskDeliveryLedgerGate } from
  "../../src/task/task_delivery_ledger_gate.js";
import {
  type AddInterventionParams,
  TaskInterventionRoute,
} from "../../src/task/task_intervention_route.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

describePostgres("Claude background delivery receipt PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_notification_outbox`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM claude_background_tasks`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, session_type, status, agent_id)
      VALUES ('caller-session', 'node-test', 'claude', 'completed', 'worker')
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("keeps one exact runtime follow-up delivery replayable until a receipt consumes it", async () => {
    const repository = new SessionDeliveryRepository(harness.sql);
    const ledger = new TaskDeliveryLedgerGate(true, repository);
    const task = makeTask();
    const counts = { resume: 0, wake: 0, notification: 0 };
    const dispatched: InterventionMessage[] = [];
    const route = makeRoute(task, ledger, counts, dispatched);
    const original = await registerOriginal(repository);

    await route.addIntervention(original.params, () => {
      counts.wake += 1;
    });

    expect(dispatched).toHaveLength(1);
    const delivered = dispatched[0] as InterventionMessage & {
      storedDeliveryPayload?: Record<string, unknown>;
      storedDeliveryPayloadHash?: string;
    };
    expect(delivered).toMatchObject({
      deliveryId: original.params.deliveryId,
      storedDeliveryPayload: original.payload,
      storedDeliveryPayloadHash: original.payloadHash,
    });
    expect(counts).toEqual({ resume: 1, wake: 1, notification: 1 });

    const rows = await harness.sql<Array<{
      delivery_id: string;
      parent_delivery_id: string | null;
      state: string;
      payload_hash: string;
    }>>`
      SELECT delivery_id, parent_delivery_id, state, payload_hash
      FROM session_deliveries
      ORDER BY created_at, delivery_id
    `;
    expect(rows).toEqual([{
      delivery_id: original.params.deliveryId,
      parent_delivery_id: null,
      state: "delivered",
      payload_hash: original.payloadHash,
    }]);
    await expect(harness.sql`
      SELECT COUNT(*)::int AS count
      FROM session_delivery_notification_outbox
      WHERE state = 'published'
    `).resolves.toMatchObject([{ count: 1 }]);
  });

  it.each([
    ["durable_next_turn", "schedule_dispatcher"],
    ["completion_notification", "completion_notifier"],
    ["runtime_followup", CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE],
  ] as const)(
    "reuses the stored payload for existing %s delivery ids",
    async (intent, source) => {
      const repository = new SessionDeliveryRepository(harness.sql);
      const relationKey = `stored-payload:${intent}`;
      const identity = buildDeterministicDeliveryIdentity({
        targetSessionId: "caller-session",
        relationKey,
        intent,
      });
      const canonical = buildCanonicalDeliveryPayload({
        text: "canonical message",
        user: "system",
        source,
        completionId: identity.completionId,
        relationKey,
      });
      await repository.register({
        ...identity,
        targetSessionId: "caller-session",
        intent,
        source,
        payload: canonical.payload,
        payloadHash: canonical.payloadHash,
      });
      const gate = new TaskDeliveryLedgerGate(true, repository);

      const admission = await gate.admit({
        agentSessionId: "caller-session",
        text: "divergent retry text that must not be re-hashed",
        user: "system",
        source,
        deliveryId: identity.deliveryId,
        deliveryIntent: intent,
        completionId: identity.completionId,
        relationKey,
      });

      expect(admission).toMatchObject({
        kind: "admitted",
        row: {
          delivery_id: identity.deliveryId,
          payload_hash: canonical.payloadHash,
          payload: canonical.payload,
        },
      });
      await expect(repository.get(identity.deliveryId)).resolves.toMatchObject({
        state: "claimed",
        payload_hash: canonical.payloadHash,
        payload: canonical.payload,
      });
      await expect(harness.sql`
        SELECT COUNT(*)::int AS count
        FROM session_deliveries
        WHERE state = 'uncertain'
      `).resolves.toMatchObject([{ count: 0 }]);
    },
  );

  it("keeps repository conflict detection for a genuinely divergent new registration", async () => {
    const repository = new SessionDeliveryRepository(harness.sql);
    const first = await registerOriginal(repository);

    const conflict = await repository.register({
      deliveryId: first.params.deliveryId!,
      targetSessionId: "caller-session",
      relationKey: first.params.relationKey!,
      completionId: first.params.completionId!,
      intent: "runtime_followup",
      source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
      payloadHash: "different-hash",
      payload: { text: "different payload" },
    });

    expect(conflict.conflict).toBe(true);
    expect(conflict.row.state).toBe("uncertain");
  });
});

async function registerOriginal(
  repository: SessionDeliveryRepository,
): Promise<{
  params: AddInterventionParams;
  payload: Record<string, unknown>;
  payloadHash: string;
}> {
  const relationKey = "claude_runtime:caller-session:sdk-session:task-1@77";
  const identity = buildDeterministicDeliveryIdentity({
    targetSessionId: "caller-session",
    relationKey,
    intent: "runtime_followup",
  });
  const payload = buildCanonicalDeliveryPayload({
    text: "canonical background completion",
    user: "system",
    source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
    completionId: identity.completionId,
    relationKey,
    callerInfo: { source: "system", display_name: "Soulstream" },
    followupKey: "caller-session:task-1",
    followupAttempt: 1,
    followupTaskIds: ["task-1"],
  });
  await repository.register({
    ...identity,
    targetSessionId: "caller-session",
    intent: "runtime_followup",
    source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
    producerTerminalRevision: "task-1@77",
    payloadHash: payload.payloadHash,
    payload: payload.payload,
  });
  return {
    payload: payload.payload,
    payloadHash: payload.payloadHash,
    params: {
      agentSessionId: "caller-session",
      text: "canonical background completion",
      user: "system",
      callerInfo: { source: "system", display_name: "Soulstream" },
      source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
      followupAttempt: 1,
      followupKey: "caller-session:task-1",
      followupTaskIds: ["task-1"],
      deliveryId: identity.deliveryId,
      deliveryIntent: "runtime_followup",
      completionId: identity.completionId,
      relationKey,
      producerTerminalRevision: "task-1@77",
      storedDeliveryPayload: payload.payload,
      storedDeliveryPayloadHash: payload.payloadHash,
    },
  };
}

function makeTask(): Task {
  return {
    agentSessionId: "caller-session",
    prompt: "foreground complete",
    status: "completed",
    createdAt: new Date("2026-07-26T09:00:00.000Z"),
    lastEventId: 41,
    lastReadEventId: 0,
    interventionQueue: [],
    claudeRuntime: {
      sessionState: "idle",
      updatedAt: Date.now(),
      tasks: {
        "task-1": {
          taskId: "task-1",
          status: "completed",
          updatedAt: 77,
          isBackgrounded: true,
          summary: "done",
        },
      },
    },
  };
}

function makeRoute(
  task: Task,
  ledger: TaskDeliveryLedgerGate,
  counts: { resume: number; wake: number; notification: number },
  dispatched: InterventionMessage[],
): TaskInterventionRoute {
  return new TaskInterventionRoute({
    getTask: (sessionId) => sessionId === task.agentSessionId ? task : undefined,
    loadEvictedTask: async () => null,
    rememberTask: () => {},
    runningInterventionTransition: {
      deliver: async () => {
        throw new Error("unexpected running delivery");
      },
      queueOnly: async () => {
        throw new Error("unexpected running queue");
      },
    },
    autoResumeTransition: {
      resume: async (resumedTask, message, callback) => {
        counts.resume += 1;
        dispatched.push(message);
        callback(resumedTask);
        return { autoResumed: true };
      },
    },
    deliveryLedgerGate: ledger,
    sessionNotificationPublisher: {
      publish: async () => {
        counts.notification += 1;
        return { published: true, targetReceiptId: "event:notification-test" };
      },
    },
  });
}

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
