import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ClaudeBackgroundTaskRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/claude_background_task_repository.js";
import { SessionDeliveryRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import type { SqlClient } from
  "../../../orch-server-ts/src/control_plane/control_plane_types.js";
import type { ClaudeRuntimeHostClient } from
  "../../src/control_plane/persistence_host_clients.js";
import { attachClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_client_event.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../../src/task/claude_background_task_lifecycle.js";
import { decidePostgresTests } from "../../../packages/db-schema/scripts/postgres-test-policy.mjs";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres = decidePostgresTests().backendAvailable ? describe : describe.skip;

describePostgres("Claude background lifecycle PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_notification_outbox`;
    await harness.sql`DELETE FROM session_delivery_relation_consumptions`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM claude_background_task_generations`;
    await harness.sql`DELETE FROM claude_background_tasks`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES ('caller-session', 'claude', 'completed', 'worker')
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("records a resumed old tool id under a new owner and separate delivery", async () => {
    const lifecycle = makeLifecycle(harness.sql);
    const firstOwner = { registrationId: "registration-a", executionCommandId: "command-a" };
    const nextOwner = { registrationId: "registration-b", executionCommandId: "command-b" };
    const taskId = "task-resumed";
    await expect(lifecycle.observe("caller-session", started(taskId), undefined, firstOwner)).resolves.toBe(true);
    await expect(lifecycle.observe("caller-session", terminal(taskId, "completed"), undefined, firstOwner)).resolves.toBe(true);
    const first = await background(harness.sql).getGeneration(
      "node-test", "caller-session", "sdk-session", taskId, `toolu-${taskId}`,
    );
    await deliveries(harness.sql).recordRelationConsumed({
      relationKey: first!.relation_key, completionId: first!.completion_id,
      callerSessionId: "caller-session", consumedTurnId: "event:first",
    });
    await expect(lifecycle.observe("caller-session", started(taskId), undefined, nextOwner)).resolves.toBe(true);
    await expect(lifecycle.observe("caller-session", terminal(taskId, "completed"), undefined, nextOwner)).resolves.toBe(true);
    const resumed = await background(harness.sql).getGeneration(
      "node-test", "caller-session", "sdk-session", taskId, `toolu-${taskId}#r1`,
    );
    expect(resumed).toMatchObject({
      status: "completed", runner_registration_id: "registration-b", execution_command_id: "command-b",
    });
    expect(resumed!.relation_key).not.toBe(first!.relation_key);
    expect(resumed!.completion_id).not.toBe(first!.completion_id);
    expect(resumed!.notification_delivery_id).not.toBe(first!.notification_delivery_id);
    await expect(deliveries(harness.sql).get(first!.notification_delivery_id!))
      .resolves.toMatchObject({ state: "consumed" });
    await expect(deliveries(harness.sql).get(resumed!.notification_delivery_id!))
      .resolves.toMatchObject({ state: "pending" });
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

  it("records a proven-dead runner terminal before recovering an expired dispatch attempt", async () => {
    const lifecycle = makeLifecycle(harness.sql);
    const deadExecution = {
      registrationId: "registration-restart",
      executionCommandId: "command-restart",
    };
    await lifecycle.observe(
      "caller-session",
      started("task-restart"),
      undefined,
      deadExecution,
    );
    await expect(lifecycle.terminalizeDeadRunner(
      "caller-session",
      deadExecution,
    )).resolves.toBe(1);
    await expect(lifecycle.terminalizeDeadRunner(
      "caller-session",
      deadExecution,
    )).resolves.toBe(0);

    const task = await background(harness.sql).get(
      "node-test",
      "caller-session",
      "task-restart",
    );
    expect(task).toMatchObject({
      status: "killed",
      close_reason: "runner_dead",
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
      SET attempt_expires_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = ${task!.notification_delivery_id!}
    `;
    await expect(repository.expireStaleDeliveryAttempts()).resolves.toBe(1);
    await harness.sql`
      UPDATE session_deliveries
      SET next_attempt_at = NOW()
      WHERE delivery_id = ${task!.notification_delivery_id!}
    `;
    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-recovered",
      1,
    )).resolves.toMatchObject([
      { attempt_token: "worker-recovered", state: "claimed" },
    ]);
    await expect(repository.beginDispatch(
      task!.notification_delivery_id!,
      "worker-dead",
    )).resolves.toBeNull();
  });

  it("selects old active generations on one node and closes them without a delivery", async () => {
    const repo = background(harness.sql);
    const old = new Date("2026-01-01T00:00:00.000Z");
    const cutoff = new Date("2026-02-01T00:00:00.000Z");
    const observe = async (sourceNode: string, taskId: string, observedAt: Date) => await repo.observeGeneration({
      sourceNode, sessionId: "caller-session", sdkSessionId: "sdk-session", taskId,
      initiatingToolUseId: `tool-${taskId}`, generationKey: `generation-${taskId}`,
      relationKey: `relation-${taskId}`, completionId: `completion-${taskId}`, observedAt,
    });
    await observe("node-test", "old", old);
    await observe("node-test", "new", cutoff);
    await observe("other-node", "other", old);
    const rows = await repo.activeGenerationsForNode({ sourceNode: "node-test", updatedBefore: cutoff, limit: 10 });
    expect(rows.map((item) => item.task_id)).toEqual(["old"]);
    const result = await repo.terminalizeGeneration({
      sourceNode: "node-test", sessionId: "caller-session", sdkSessionId: "sdk-session", taskId: "old",
      initiatingToolUseId: "tool-old", generationKey: "generation-old", relationKey: "relation-old",
      completionId: "completion-old", status: "killed", closeReason: "runner_missing", terminalRevision: "runner-missing:generation-old",
    });
    expect(result).toMatchObject({ accepted: true, row: { status: "killed", notification_delivery_id: null } });
    expect(result).not.toHaveProperty("delivery");
    expect(await harness.sql`SELECT delivery_id FROM session_deliveries`).toHaveLength(0);
    await expect(repo.get("node-test", "caller-session", "old")).resolves.toMatchObject({ status: "killed", close_reason: "runner_missing", notification_delivery_id: null });
  });

  it("closes an orphaned owned generation without changing its owner or creating a delivery", async () => {
    const lifecycle = makeLifecycle(harness.sql);
    await lifecycle.observe("caller-session", started("task-owned-orphan"), undefined, {
      registrationId: "registration-orphan",
      executionCommandId: "command-orphan",
    });

    await expect(lifecycle.terminalizeOrphanedForNode({
      liveSessionIds: new Set(),
      updatedBefore: new Date(Date.now() + 60_000),
      limit: 100,
    })).resolves.toEqual({ queried: 1, closed: 1, skippedLive: 0, failed: 0 });
    await expect(background(harness.sql).getGeneration(
      "node-test", "caller-session", "sdk-session", "task-owned-orphan", "toolu-task-owned-orphan",
    )).resolves.toMatchObject({
      status: "killed",
      close_reason: "runner_missing",
      runner_registration_id: "registration-orphan",
      execution_command_id: "command-orphan",
      notification_delivery_id: null,
    });
    expect(await harness.sql`SELECT delivery_id FROM session_deliveries`).toHaveLength(0);
  });

  it("lets shutdown and dead-runner recovery race without duplicate terminal delivery", async () => {
    const shutdownWorker = makeLifecycle(harness.createPeer());
    const recoveryWorker = makeLifecycle(harness.createPeer());
    const deadExecution = {
      registrationId: "registration-shutdown-race",
      executionCommandId: "command-shutdown-race",
    };
    await shutdownWorker.observe(
      "caller-session",
      started("task-shutdown-race"),
      undefined,
      deadExecution,
    );

    const [shutdownAccepted, recovered] = await Promise.all([
      shutdownWorker.observe(
        "caller-session",
        updated("task-shutdown-race", "killed", "shutdown"),
      ),
      recoveryWorker.terminalizeDeadRunner("caller-session", deadExecution),
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
    repository: Object.create(background(sql)) as ClaudeRuntimeHostClient,
    sourceNode: "node-test",
    // Stamps the delivery's created_at, which the retry budget measures age
    // against. A pinned past date would exhaust that budget before these
    // tests reach the behaviour they are about.
    now: () => new Date(),
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
    toolUseId: `toolu-${taskId}`,
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
    toolUseId: `toolu-${taskId}`,
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
      tool_use_id: `toolu-${taskId}`,
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
