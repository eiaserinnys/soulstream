import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ClaudeBackgroundTaskRepository } from
  "../../src/db/repositories/claude_background_task_repository.js";
import { SessionDeliveryRepository } from
  "../../src/db/repositories/session_delivery_repository.js";
import type { SqlClient } from "../../src/db/session_db.js";
import { attachClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../../src/task/claude_background_task_lifecycle.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

describePostgres("Claude background lifecycle PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    for (const migration of [
      "../../../packages/db-schema/sql/migrations/045_session_deliveries.sql",
      "../../../packages/db-schema/sql/migrations/046_claude_background_tasks.sql",
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

  it("commits terminal state and its semantic delivery atomically", async () => {
    const lifecycle = makeLifecycle(harness.sql);
    await lifecycle.observe("caller-session", started("task-atomic"));
    await harness.sql.unsafe(`
      CREATE OR REPLACE FUNCTION reject_background_delivery()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source = 'claude_runtime_task_followup' THEN
          RAISE EXCEPTION 'injected delivery failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_background_delivery_insert
      BEFORE INSERT ON session_deliveries
      FOR EACH ROW EXECUTE FUNCTION reject_background_delivery();
    `);

    await expect(lifecycle.observe(
      "caller-session",
      terminal("task-atomic", "completed"),
    )).rejects.toThrow("injected delivery failure");
    await expect(background(harness.sql).get(
      "node-test",
      "caller-session",
      "task-atomic",
    )).resolves.toMatchObject({
      status: "running",
      notification_delivery_id: null,
    });
    await harness.sql`
      DROP TRIGGER reject_background_delivery_insert ON session_deliveries
    `;

    await expect(lifecycle.observe(
      "caller-session",
      terminal("task-atomic", "completed"),
    )).resolves.toBe(true);
    const row = await background(harness.sql).get(
      "node-test",
      "caller-session",
      "task-atomic",
    );
    expect(row).toMatchObject({
      status: "completed",
      close_reason: "sdk_completed",
    });
    await expect(deliveries(harness.sql).get(
      row!.notification_delivery_id!,
    )).resolves.toMatchObject({
      state: "pending",
      intent: "runtime_followup",
      target_session_id: "caller-session",
    });
  });

  it("lets only one PostgreSQL worker win the terminal CAS", async () => {
    const first = makeLifecycle(harness.createPeer());
    const second = makeLifecycle(harness.createPeer());
    await first.observe("caller-session", started("task-cas"));

    const results = await Promise.all([
      first.observe("caller-session", terminal("task-cas", "completed")),
      second.observe("caller-session", terminal("task-cas", "failed")),
    ]);

    expect(results.sort()).toEqual([false, true]);
    const rows = await harness.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM session_deliveries
      WHERE producer_kind = 'claude_background_task'
        AND producer_id = 'task-cas'
    `;
    expect(rows[0]?.count).toBe(1);
  });

  it.each([
    ["completed", "sdk_completed"],
    ["failed", "sdk_failed"],
    ["stopped", "sdk_stopped"],
    ["killed", "explicit_cancel"],
  ] as const)(
    "durably records the %s background terminal and close reason",
    async (status, closeReason) => {
      const lifecycle = makeLifecycle(harness.sql);
      const taskId = `task-${status}`;
      await lifecycle.observe("caller-session", started(taskId));
      const event = status === "killed"
        ? updated(taskId, "killed", closeReason)
        : terminal(taskId, status);

      await expect(lifecycle.observe("caller-session", event)).resolves.toBe(true);
      const row = await background(harness.sql).get(
        "node-test",
        "caller-session",
        taskId,
      );
      expect(row).toMatchObject({
        status,
        close_reason: closeReason,
      });
      await expect(deliveries(harness.sql).get(
        row!.notification_delivery_id!,
      )).resolves.toMatchObject({
        state: "pending",
        producer_id: taskId,
      });
    },
  );

  it("fences a late SDK terminal behind a registry-close terminal", async () => {
    const blocker = harness.createPeer();
    const first = makeLifecycle(harness.createPeer());
    const second = makeLifecycle(harness.createPeer());
    await first.observe("caller-session", started("task-close-race"));
    const locked = deferred<void>();
    const release = deferred<void>();
    const blocking = blocker.begin(async (transaction) => {
      await transaction`
        SELECT 1 FROM claude_background_tasks
        WHERE source_node = 'node-test'
          AND session_id = 'caller-session'
          AND task_id = 'task-close-race'
        FOR UPDATE
      `;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const close = first.observe(
      "caller-session",
      updated("task-close-race", "killed", "registry_ttl"),
    );
    await nextMacrotask();
    const late = second.observe(
      "caller-session",
      terminal("task-close-race", "completed"),
    );
    release.resolve();
    await blocking;

    await expect(close).resolves.toBe(true);
    await expect(late).resolves.toBe(false);
    await expect(background(harness.sql).get(
      "node-test",
      "caller-session",
      "task-close-race",
    )).resolves.toMatchObject({
      status: "killed",
      close_reason: "registry_ttl",
    });
    expect(await harness.sql`
      SELECT delivery_id FROM session_deliveries
      WHERE producer_id = 'task-close-race'
    `).toHaveLength(1);
  });

  it("preserves terminal and delivery rows after the target session is deleted", async () => {
    const lifecycle = makeLifecycle(harness.sql);
    await lifecycle.observe("caller-session", started("task-deleted-target"));
    await harness.sql`
      DELETE FROM sessions WHERE session_id = 'caller-session'
    `;

    await expect(lifecycle.observe(
      "caller-session",
      terminal("task-deleted-target", "completed"),
    )).resolves.toBe(true);

    const task = await background(harness.sql).get(
      "node-test",
      "caller-session",
      "task-deleted-target",
    );
    expect(task).toMatchObject({
      status: "completed",
      close_reason: "sdk_completed",
    });
    await expect(deliveries(harness.sql).get(
      task!.notification_delivery_id!,
    )).resolves.toMatchObject({
      state: "pending",
      target_session_id: null,
    });
  });

  it("records restart terminal before recovering an expired dispatch lease", async () => {
    const lifecycle = makeLifecycle(harness.sql);
    await lifecycle.observe("caller-session", started("task-restart"));
    await expect(lifecycle.recoverAfterRestart()).resolves.toBe(1);
    await expect(lifecycle.recoverAfterRestart()).resolves.toBe(0);

    const task = await background(harness.sql).get(
      "node-test",
      "caller-session",
      "task-restart",
    );
    expect(task).toMatchObject({
      status: "killed",
      close_reason: "worker_restart",
    });
    const repository = deliveries(harness.sql);
    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-dead",
      1,
      100,
    )).resolves.toHaveLength(1);
    await repository.beginDispatch(task!.notification_delivery_id!, "worker-dead");
    await harness.sql`
      UPDATE session_deliveries
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = ${task!.notification_delivery_id!}
    `;
    await expect(repository.releaseExpiredDeliveryLeases()).resolves.toBe(1);
    await harness.sql`
      UPDATE session_deliveries
      SET next_attempt_at = NOW()
      WHERE delivery_id = ${task!.notification_delivery_id!}
    `;
    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-recovered",
      1,
    )).resolves.toMatchObject([
      { lease_owner: "worker-recovered", state: "claimed" },
    ]);
    await expect(repository.beginDispatch(
      task!.notification_delivery_id!,
      "worker-dead",
    )).resolves.toBeNull();
  });

  it("lets shutdown and restart recovery race without duplicate terminal delivery", async () => {
    const shutdownWorker = makeLifecycle(harness.createPeer());
    const recoveryWorker = makeLifecycle(harness.createPeer());
    await shutdownWorker.observe("caller-session", started("task-shutdown-race"));

    const [shutdownAccepted, recovered] = await Promise.all([
      shutdownWorker.observe(
        "caller-session",
        updated("task-shutdown-race", "killed", "shutdown"),
      ),
      recoveryWorker.recoverAfterRestart(),
    ]);

    expect(Number(shutdownAccepted) + recovered).toBe(1);
    await expect(background(harness.sql).get(
      "node-test",
      "caller-session",
      "task-shutdown-race",
    )).resolves.toMatchObject({ status: "killed" });
    await expect(harness.sql`
      SELECT COUNT(*)::int AS count
      FROM session_deliveries
      WHERE producer_kind = 'claude_background_task'
        AND producer_id = 'task-shutdown-race'
    `).resolves.toMatchObject([{ count: 1 }]);
  });

});

function makeLifecycle(sql: SqlClient): ClaudeBackgroundTaskLifecycle {
  return new ClaudeBackgroundTaskLifecycle({
    repository: background(sql),
    sourceNode: "node-test",
    now: () => new Date("2026-07-26T10:00:00.000Z"),
  });
}

function background(sql: SqlClient): ClaudeBackgroundTaskRepository {
  return new ClaudeBackgroundTaskRepository(sql);
}

function deliveries(sql: SqlClient): SessionDeliveryRepository {
  return new SessionDeliveryRepository(sql);
}

function started(taskId: string): ClaudeClientEvent {
  const event: ClaudeClientEvent = {
    type: "claude_runtime_task_started",
    taskId,
    sessionId: "sdk-session",
    description: "long work",
  };
  attachClaudeBackgroundProvenance(event, "sdk_membership");
  return event;
}

function terminal(
  taskId: string,
  status: "completed" | "failed" | "stopped",
): ClaudeClientEvent {
  const event: ClaudeClientEvent = {
    type: "claude_runtime_task_notification",
    taskId,
    sessionId: "sdk-session",
    status,
    summary: `${status} summary`,
  };
  attachClaudeBackgroundProvenance(event, "sdk_membership");
  return event;
}

function updated(
  taskId: string,
  status: "killed",
  closeReason: string,
): ClaudeClientEvent {
  return {
    type: "claude_runtime_task_updated",
    taskId,
    sessionId: "sdk-session",
    patch: {
      status,
      is_backgrounded: true,
      close_reason: closeReason,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function nextMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
