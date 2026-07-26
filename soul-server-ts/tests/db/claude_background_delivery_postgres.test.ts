import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ClaudeBackgroundTaskRepository } from
  "../../src/db/repositories/claude_background_task_repository.js";
import { SessionDeliveryRepository } from
  "../../src/db/repositories/session_delivery_repository.js";
import type { SqlClient } from "../../src/db/session_db.js";
import {
  mapClaudeClientEvent,
  type ClaudeClientEvent,
} from "../../src/engine/claude_event_mapper.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../../src/task/claude_background_task_lifecycle.js";
import { ClaudeRuntimeTaskFollowupController } from
  "../../src/task/claude_runtime_task_followup.js";
import { CompletionDeliveryCoordinator } from
  "../../src/task/completion_delivery_coordinator.js";
import { TaskDeliveryLedgerGate } from
  "../../src/task/task_delivery_ledger_gate.js";
import { TaskInterventionRoute } from
  "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

describePostgres("Claude background delivery PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    for (const migration of [
      "../../../packages/db-schema/sql/pending/043_session_deliveries.sql",
      "../../../packages/db-schema/sql/pending/045_claude_background_tasks.sql",
    ]) {
      await harness.sql.unsafe(readFileSync(new URL(migration, import.meta.url), "utf8"));
    }
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_notification_outbox`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM claude_background_tasks`;
    await harness.sql`DELETE FROM supervisor_registry`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES ('caller-session', 'claude', 'completed', 'worker')
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("keeps one canonical hash from terminal persistence through inline flush", async () => {
    const lifecycle = makeLifecycle(harness.sql);
    const event = terminal("task-inline-flush", "completed");
    await lifecycle.observe("caller-session", started("task-inline-flush"));
    await expect(lifecycle.observe("caller-session", event)).resolves.toBe(true);
    const path = makeDeliveryPath(harness.sql);
    const payloads = mapClaudeClientEvent(event);

    for (const payload of payloads) {
      await path.followup.collectDetached(path.task, payload);
      await path.followup.collectDetached(path.task, payload);
    }

    await expectExactlyOnceDelivery(harness.sql, "task-inline-flush", path.counts);
  });

  it("keeps one canonical hash from terminal persistence through recovery", async () => {
    const lifecycle = makeLifecycle(harness.sql);
    await lifecycle.observe("caller-session", started("task-recovery-flush"));
    await expect(lifecycle.observe(
      "caller-session",
      terminal("task-recovery-flush", "completed"),
    )).resolves.toBe(true);
    const path = makeDeliveryPath(harness.sql);

    await path.recovery.recoverPending();
    await path.recovery.recoverPending();

    await expectExactlyOnceDelivery(harness.sql, "task-recovery-flush", path.counts);
  });

  it("keeps schema-only fresh install equal to the 043 then 045 upgrade", async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const freshSchema = `background_fresh_${suffix}`;
    const upgradeSchema = `background_upgrade_${suffix}`;
    const fresh = harness.createPeer();
    const upgrade = harness.createPeer();
    const schemaSql = readFileSync(
      new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url),
      "utf8",
    );
    const deliveryMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/pending/043_session_deliveries.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const backgroundMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/pending/045_claude_background_tasks.sql",
        import.meta.url,
      ),
      "utf8",
    );

    try {
      await fresh.unsafe(`CREATE SCHEMA ${freshSchema}`);
      await fresh.unsafe(`SET search_path TO ${freshSchema}`);
      await fresh.unsafe(schemaSql);

      await upgrade.unsafe(`CREATE SCHEMA ${upgradeSchema}`);
      await upgrade.unsafe(`SET search_path TO ${upgradeSchema}`);
      await upgrade.unsafe("CREATE TABLE sessions (session_id TEXT PRIMARY KEY)");
      await upgrade.unsafe(deliveryMigration);
      await upgrade.unsafe(backgroundMigration);
      await upgrade.unsafe(backgroundMigration);

      await expect(backgroundCatalog(fresh, freshSchema)).resolves.toEqual(
        await backgroundCatalog(upgrade, upgradeSchema),
      );
    } finally {
      await harness.sql.unsafe(`DROP SCHEMA IF EXISTS ${freshSchema} CASCADE`);
      await harness.sql.unsafe(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE`);
    }
  });
});

function makeLifecycle(sql: SqlClient): ClaudeBackgroundTaskLifecycle {
  return new ClaudeBackgroundTaskLifecycle({
    repository: new ClaudeBackgroundTaskRepository(sql),
    sourceNode: "node-test",
    now: () => new Date("2026-07-26T10:00:00.000Z"),
  });
}

function makeDeliveryPath(sql: SqlClient): {
  task: Task;
  followup: ClaudeRuntimeTaskFollowupController;
  recovery: CompletionDeliveryCoordinator;
  counts: DeliveryPathCounts;
} {
  const task: Task = {
    agentSessionId: "caller-session",
    prompt: "finished foreground",
    status: "completed",
    createdAt: new Date("2026-07-26T09:00:00.000Z"),
    lastEventId: 41,
    lastReadEventId: 0,
    interventionQueue: [],
    claudeRuntime: {
      sessionState: "idle",
      updatedAt: Date.now(),
      tasks: {},
    },
  };
  const counts: DeliveryPathCounts = {
    resume: 0,
    wake: 0,
    notification: 0,
  };
  const repository = new SessionDeliveryRepository(sql);
  const ledger = new TaskDeliveryLedgerGate(true, repository);
  const onResume = (): void => {
    counts.wake += 1;
  };
  const route = new TaskInterventionRoute({
    getTask: (sessionId) => sessionId === task.agentSessionId ? task : undefined,
    loadEvictedTask: async () => null,
    rememberTask: () => {},
    activeTaskRecovery: {
      prepareForIntervention: () => "auto-resume",
    },
    runningInterventionTransition: {
      deliver: async () => {
        throw new Error("unexpected running delivery");
      },
      queueOnly: async () => {
        throw new Error("unexpected running queue");
      },
    },
    autoResumeTransition: {
      resume: async (resumedTask, _message, callback) => {
        counts.resume += 1;
        callback(resumedTask);
        return { autoResumed: true };
      },
    },
    deliveryLedgerGate: ledger,
    sessionNotificationPublisher: {
      publish: async () => {
        counts.notification += 1;
        return true;
      },
    },
  });
  const dispatch = async (
    params: Parameters<TaskInterventionRoute["addIntervention"]>[0],
  ): Promise<void> => {
    await route.addIntervention(params, onResume);
  };
  return {
    task,
    counts,
    followup: new ClaudeRuntimeTaskFollowupController({
      taskManager: {
        addIntervention: (params, callback) =>
          route.addIntervention(params, callback),
      },
      onResume,
      logger: pino({ level: "silent" }),
      deliveryV2Enabled: true,
    }),
    recovery: new CompletionDeliveryCoordinator({
      repository,
      dispatch,
      logger: pino({ level: "silent" }),
    }, "background-recovery-test"),
  };
}

interface DeliveryPathCounts {
  resume: number;
  wake: number;
  notification: number;
}

async function expectExactlyOnceDelivery(
  sql: SqlClient,
  taskId: string,
  counts: DeliveryPathCounts,
): Promise<void> {
  expect(counts).toEqual({
    resume: 1,
    wake: 1,
    notification: 1,
  });
  await expect(sql`
    SELECT state, COUNT(*)::int AS count
    FROM session_deliveries
    WHERE producer_kind = 'claude_background_task'
      AND producer_id = ${taskId}
    GROUP BY state
  `).resolves.toMatchObject([{ state: "queued", count: 1 }]);
  await expect(sql`
    SELECT state, COUNT(*)::int AS count
    FROM session_delivery_notification_outbox
    WHERE delivery_id = (
      SELECT notification_delivery_id
      FROM claude_background_tasks
      WHERE source_node = 'node-test'
        AND session_id = 'caller-session'
        AND task_id = ${taskId}
    )
    GROUP BY state
  `).resolves.toMatchObject([{ state: "published", count: 1 }]);
  await expect(sql`
    SELECT COUNT(*)::int AS count
    FROM session_deliveries
    WHERE state = 'uncertain'
  `).resolves.toMatchObject([{ count: 0 }]);
}

async function backgroundCatalog(
  sql: SqlClient,
  schema: string,
): Promise<{
  columns: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown>>;
  indexes: Array<Record<string, unknown>>;
}> {
  const columns = await sql<Array<Record<string, unknown>>>`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = ${schema}
      AND table_name = 'claude_background_tasks'
    ORDER BY ordinal_position
  `;
  const constraints = await sql<Array<Record<string, unknown>>>`
    SELECT
      constraint_row.conname AS constraint_name,
      constraint_row.contype AS constraint_type,
      pg_get_constraintdef(constraint_row.oid, true) AS definition
    FROM pg_constraint AS constraint_row
    INNER JOIN pg_class AS relation
      ON relation.oid = constraint_row.conrelid
    INNER JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schema}
      AND relation.relname = 'claude_background_tasks'
      AND constraint_row.contype <> 'n'
    ORDER BY constraint_row.conname
  `;
  const indexes = await sql<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = ${schema}
      AND tablename = 'claude_background_tasks'
    ORDER BY indexname
  `;
  return {
    columns,
    constraints,
    indexes: indexes.map((row) => ({
      indexname: row.indexname,
      indexdef: row.indexdef.replaceAll(schema, "<schema>"),
    })),
  };
}

function started(taskId: string): ClaudeClientEvent {
  return {
    type: "claude_runtime_task_started",
    taskId,
    sessionId: "sdk-session",
    description: "long work",
  };
}

function terminal(
  taskId: string,
  status: "completed" | "failed" | "stopped",
): ClaudeClientEvent {
  return {
    type: "claude_runtime_task_notification",
    taskId,
    sessionId: "sdk-session",
    status,
    summary: `${status} summary`,
  };
}

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
