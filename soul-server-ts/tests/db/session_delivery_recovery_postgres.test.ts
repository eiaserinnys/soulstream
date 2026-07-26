import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionDeliveryRepository } from "../../src/db/repositories/session_delivery_repository.js";
import type { SqlClient } from "../../src/db/session_db.js";
import { CompletionDeliveryCoordinator } from
  "../../src/task/completion_delivery_coordinator.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { QueuedDeliveryTranscriptRecovery } from
  "../../src/task/queued_delivery_transcript_recovery.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

describePostgres("session delivery recovery PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: SessionDeliveryRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    const pendingMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/045_session_deliveries.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await harness.sql.unsafe(pendingMigration);
    await harness.sql.unsafe(pendingMigration);
    repository = new SessionDeliveryRepository(harness.sql);
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_notification_outbox`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM supervisor_registry`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, session_type, status, agent_id)
      VALUES
        ('supervisor-old', 'node-test', 'claude', 'completed', 'ariella'),
        ('supervisor-new', 'node-test', 'claude', 'completed', 'ariella'),
        ('child-session', 'node-test', 'claude', 'completed', 'worker')
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("preserves a durable delivery when its target session is deleted and retargets it", async () => {
    await register("delivery-delete", "relation-delete", {
      targetSessionId: "supervisor-old",
      supervisorRole: "ariella",
    });

    await harness.sql`DELETE FROM sessions WHERE session_id = 'supervisor-old'`;
    expect(await repository.get("delivery-delete")).toMatchObject({
      state: "pending",
      target_session_id: null,
    });

    await setSupervisor("supervisor-new");
    await expect(repository.claimForCurrentSupervisor(
      "delivery-delete",
      "ariella",
      "worker-current",
    )).resolves.toMatchObject({
      state: "claimed",
      target_session_id: "supervisor-new",
      lease_owner: "worker-current",
    });
  });

  it("sees a committed handover after a row-lock wait before resolving and claiming", async () => {
    await register("delivery-handover", "relation-handover", {
      supervisorRole: "ariella",
    });
    await setSupervisor("supervisor-old");

    const blocker = harness.createPeer();
    const handover = harness.createPeer();
    const locked = deferred<void>();
    const release = deferred<void>();
    const blockingTransaction = blocker.begin(async (transaction) => {
      await transaction`
        SELECT 1 FROM session_deliveries
        WHERE delivery_id = 'delivery-handover'
        FOR UPDATE
      `;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const claiming = repository.claimForCurrentSupervisor(
      "delivery-handover",
      "ariella",
      "worker-handover",
    );
    await nextMacrotask();
    await handover`
      UPDATE supervisor_registry
      SET active_session_id = 'supervisor-new', updated_at = NOW()
      WHERE role = 'ariella'
    `;
    release.resolve();
    await blockingTransaction;

    await expect(claiming).resolves.toMatchObject({
      state: "claimed",
      target_session_id: "supervisor-new",
    });
  });

  it("uses SKIP LOCKED across workers", async () => {
    await setSupervisor("supervisor-old");
    await register("delivery-locked", "relation-locked", {
      supervisorRole: "ariella",
    });
    await register("delivery-free", "relation-free", {
      supervisorRole: "ariella",
    });

    const blocker = harness.createPeer();
    const locked = deferred<void>();
    const release = deferred<void>();
    const blockingTransaction = blocker.begin(async (transaction) => {
      await transaction`
        SELECT 1 FROM session_deliveries
        WHERE delivery_id = 'delivery-locked'
        FOR UPDATE
      `;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;

    const workerB = new SessionDeliveryRepository(harness.createPeer());
    await expect(workerB.claimRecoverableCompletionDeliveries(
      "worker-b",
      1,
    )).resolves.toMatchObject([
      { delivery_id: "delivery-free", lease_owner: "worker-b" },
    ]);
    release.resolve();
    await blockingTransaction;
  });

  it("backs off a due targetless poison row before claiming the healthy row behind it", async () => {
    await register("delivery-poison", "relation-poison", {
      supervisorRole: "missing-supervisor",
    });
    await register("delivery-healthy", "relation-healthy", {
      targetSessionId: "supervisor-old",
    });
    await harness.sql`
      UPDATE session_deliveries
      SET
        attempt_count = 9,
        next_attempt_at = NOW() - INTERVAL '2 seconds',
        created_at = NOW() - INTERVAL '2 seconds'
      WHERE delivery_id = 'delivery-poison'
    `;
    await harness.sql`
      UPDATE session_deliveries
      SET
        next_attempt_at = NOW() - INTERVAL '1 second',
        created_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = 'delivery-healthy'
    `;

    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-poison",
      1,
    )).resolves.toEqual([]);
    await expect(repository.get("delivery-poison")).resolves.toMatchObject({
      state: "pending",
      target_session_id: null,
      attempt_count: 10,
      last_error: "no_current_target",
    });

    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-healthy",
      1,
    )).resolves.toMatchObject([
      { delivery_id: "delivery-healthy", lease_owner: "worker-healthy" },
    ]);
  });

  it("upgrades the pre-manifest delivery ledger to the recovery schema idempotently", async () => {
    const upgradeSchema =
      `delivery_upgrade_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const upgradeSql = harness.createPeer();
    const legacyMigration = readFileSync(
      new URL(
        "./fixtures/session_deliveries_pre_manifest_408c36b0.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const currentMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/045_session_deliveries.sql",
        import.meta.url,
      ),
      "utf8",
    );

    try {
      await upgradeSql.unsafe(`CREATE SCHEMA ${upgradeSchema}`);
      await upgradeSql.unsafe(`SET search_path TO ${upgradeSchema}`);
      await upgradeSql.unsafe("CREATE TABLE sessions (session_id TEXT PRIMARY KEY)");
      await upgradeSql.unsafe(legacyMigration);
      await upgradeSql.unsafe(currentMigration);
      await upgradeSql.unsafe(currentMigration);

      const columns = await upgradeSql<Array<{ column_name: string }>>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = ${upgradeSchema}
          AND table_name = 'session_deliveries'
          AND column_name IN ('supervisor_role', 'dispatching_at')
        ORDER BY column_name
      `;
      expect(columns.map((row) => row.column_name)).toEqual([
        "dispatching_at",
        "supervisor_role",
      ]);

      await upgradeSql`
        INSERT INTO sessions (session_id) VALUES ('upgrade-target')
      `;
      await upgradeSql`
        INSERT INTO session_deliveries (
          delivery_id,
          target_session_id,
          relation_key,
          intent,
          source,
          supervisor_role,
          payload_hash,
          state,
          dispatching_at
        ) VALUES (
          'upgrade-delivery',
          'upgrade-target',
          'upgrade-relation',
          'completion_notification',
          'completion_notifier',
          'ariella',
          'upgrade-hash',
          'dispatching',
          NOW()
        )
      `;
      await expect(upgradeSql`
        SELECT state, supervisor_role, dispatching_at IS NOT NULL AS has_dispatching_at
        FROM session_deliveries
        WHERE delivery_id = 'upgrade-delivery'
      `).resolves.toMatchObject([{
        state: "dispatching",
        supervisor_role: "ariella",
        has_dispatching_at: true,
      }]);
    } finally {
      await upgradeSql.unsafe(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE`);
    }
  });

  it("recovers an expired crash lease and fences the old worker from dispatch", async () => {
    await register("delivery-crash", "relation-crash", {
      targetSessionId: "supervisor-old",
    });
    await repository.claimForTarget(
      "delivery-crash",
      "supervisor-old",
      "worker-dead",
      15_000,
    );
    await repository.beginDispatch("delivery-crash", "worker-dead");
    await harness.sql`
      UPDATE session_deliveries
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = 'delivery-crash'
    `;

    await expect(repository.releaseExpiredDeliveryLeases()).resolves.toBe(1);
    await harness.sql`
      UPDATE session_deliveries
      SET next_attempt_at = NOW()
      WHERE delivery_id = 'delivery-crash'
    `;
    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-recovered",
      1,
    )).resolves.toMatchObject([
      {
        delivery_id: "delivery-crash",
        state: "claimed",
        lease_owner: "worker-recovered",
      },
    ]);
    await expect(repository.beginDispatch(
      "delivery-crash",
      "worker-dead",
    )).resolves.toBeNull();
    await expect(repository.beginDispatch(
      "delivery-crash",
      "worker-recovered",
    )).resolves.toMatchObject({ state: "dispatching" });
  });

  it("recovers every pre-receipt crash boundary once and preserves the SDK input UUID", async () => {
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, session_type, status, agent_id)
      VALUES ('other-node-target', 'node-other', 'claude', 'running', 'other')
    `;
    const crashBoundaries = [
      { deliveryId: "delivery-after-dispatching", relation: "after-dispatching" },
      { deliveryId: "delivery-after-memory-enqueue", relation: "after-memory-enqueue" },
      { deliveryId: "delivery-after-queued", relation: "after-queued" },
      { deliveryId: "delivery-after-turn-started", relation: "after-turn-started" },
    ] as const;
    for (const boundary of crashBoundaries) {
      await register(boundary.deliveryId, boundary.relation, {
        targetSessionId: "supervisor-old",
      });
      await repository.claimForTarget(
        boundary.deliveryId,
        "supervisor-old",
        `dead:${boundary.deliveryId}`,
      );
      await repository.beginDispatch(
        boundary.deliveryId,
        `dead:${boundary.deliveryId}`,
      );
    }
    await register("delivery-other-node-queued", "other-node-queued", {
      targetSessionId: "other-node-target",
    });
    await repository.claimForTarget(
      "delivery-other-node-queued",
      "other-node-target",
      "healthy-other-node",
    );
    await repository.beginDispatch(
      "delivery-other-node-queued",
      "healthy-other-node",
    );
    await repository.markQueued(
      "delivery-other-node-queued",
      "healthy-other-node",
    );
    await repository.markQueued(
      "delivery-after-queued",
      "dead:delivery-after-queued",
    );
    await repository.markQueued(
      "delivery-after-turn-started",
      "dead:delivery-after-turn-started",
    );
    await repository.markDelivered(
      "delivery-after-turn-started",
      "event:turn-started",
    );
    await harness.sql`
      UPDATE session_deliveries
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE state = 'dispatching'
    `;

    const queuedRecovery = makeQueuedRecovery("queued-startup", async () => ({
      kind: "absent",
      inputUuid: "not-persisted",
    }));
    // Startup recovery leases queued memory, checks the transcript receipt,
    // and only replays when the stable input UUID is absent.
    await expect(
      queuedRecovery.recoverAfterNodeRestart("node-test"),
    ).resolves.toBe(1);
    await expect(repository.releaseExpiredDeliveryLeases()).resolves.toBe(2);
    await harness.sql`
      UPDATE session_deliveries
      SET next_attempt_at = NOW()
      WHERE state = 'pending'
    `;

    const dispatched: string[] = [];
    const seenInputUuids = new Map<string, string>();
    const coordinator = new CompletionDeliveryCoordinator({
      repository,
      dispatch: async (params) => {
        const deliveryId = params.deliveryId!;
        const leaseOwner = params.deliveryLeaseOwner!;
        dispatched.push(deliveryId);
        seenInputUuids.set(deliveryId, buildDeliveryInputUuid(deliveryId));
        await repository.beginDispatch(deliveryId, leaseOwner);
        await repository.markQueued(deliveryId, leaseOwner);
        await repository.markDelivered(deliveryId, `event:${deliveryId}`);
      },
      logger: { error() {}, warn() {} },
      sourceNode: "node-test",
      queuedDeliveryRecovery: queuedRecovery,
    }, "recovery-worker");

    await coordinator.recoverPending(10);
    await coordinator.recoverPending(10);

    expect(dispatched.sort()).toEqual([
      "delivery-after-dispatching",
      "delivery-after-memory-enqueue",
      "delivery-after-queued",
    ]);
    expect(new Set(dispatched)).toHaveLength(3);
    expect(dispatched).not.toContain("delivery-after-turn-started");
    for (const deliveryId of dispatched) {
      expect(seenInputUuids.get(deliveryId)).toBe(
        buildDeliveryInputUuid(deliveryId),
      );
      await expect(repository.get(deliveryId)).resolves.toMatchObject({
        state: "delivered",
      });
    }
    await expect(repository.get("delivery-after-turn-started")).resolves.toMatchObject({
      state: "delivered",
      caller_turn_id: "event:turn-started",
    });
    await expect(repository.get("delivery-other-node-queued")).resolves.toMatchObject({
      state: "queued",
      target_session_id: "other-node-target",
    });

    // Startup intentionally touches only this node. The periodic worker must
    // later recover a queued delivery whose remote owner stopped heartbeating.
    await harness.sql`
      INSERT INTO soulstream_node_heartbeats (node_id, last_seen_at)
      VALUES ('node-other', NOW() - INTERVAL '10 minutes')
      ON CONFLICT (node_id) DO UPDATE
      SET last_seen_at = EXCLUDED.last_seen_at
    `;
    await coordinator.recoverPending(10);
    await expect(repository.get("delivery-other-node-queued")).resolves.toMatchObject({
      state: "delivered",
      target_session_id: "other-node-target",
    });
    expect(dispatched.filter((id) => id === "delivery-other-node-queued"))
      .toHaveLength(1);
  });

  it("periodically requeues a queued delivery after supervisor handover and targets the current supervisor once", async () => {
    await setSupervisor("supervisor-old");
    await register("delivery-queued-handover", "relation-queued-handover", {
      supervisorRole: "ariella",
    });
    await repository.claimForCurrentSupervisor(
      "delivery-queued-handover",
      "ariella",
      "worker-old",
    );
    await repository.beginDispatch("delivery-queued-handover", "worker-old");
    await repository.markQueued("delivery-queued-handover", "worker-old");
    await setSupervisor("supervisor-new");

    const targets: string[] = [];
    const coordinator = new CompletionDeliveryCoordinator({
      repository,
      dispatch: async (params) => {
        targets.push(params.agentSessionId);
        const won = await repository.beginDispatch(
          params.deliveryId!,
          params.deliveryLeaseOwner,
        );
        if (!won) throw new Error("dispatch lease lost");
        await repository.markQueued(params.deliveryId!, params.deliveryLeaseOwner);
        await repository.markDelivered(params.deliveryId!, "event:handover");
      },
      logger: { error() {}, warn() {} },
      sourceNode: "node-test",
      queuedDeliveryRecovery: makeQueuedRecovery(
        "queued-handover",
        async () => ({ kind: "absent", inputUuid: "not-persisted" }),
      ),
    }, "handover-recovery");

    await coordinator.recoverPending(10);
    await coordinator.recoverPending(10);

    expect(targets).toEqual(["supervisor-new"]);
    await expect(repository.get("delivery-queued-handover")).resolves.toMatchObject({
      state: "delivered",
      target_session_id: "supervisor-new",
      caller_turn_id: "event:handover",
    });
  });

  it("settles a queued delivery from the transcript without replaying its SDK input", async () => {
    await register("delivery-transcript", "relation-transcript", {
      targetSessionId: "supervisor-old",
    });
    await repository.claimForTarget(
      "delivery-transcript",
      "supervisor-old",
      "worker-before-crash",
    );
    await repository.beginDispatch(
      "delivery-transcript",
      "worker-before-crash",
    );
    await repository.markQueued(
      "delivery-transcript",
      "worker-before-crash",
    );

    const dispatched: string[] = [];
    const queuedRecovery = makeQueuedRecovery(
      "queued-transcript",
      async (row) => ({
        kind: "completed",
        inputUuid: buildDeliveryInputUuid(row.delivery_id),
        assistantMessageUuid: "assistant-result-uuid",
      }),
    );
    const coordinator = new CompletionDeliveryCoordinator({
      repository,
      dispatch: async (params) => {
        dispatched.push(params.deliveryId!);
      },
      logger: { error() {}, warn() {} },
      sourceNode: "node-test",
      queuedDeliveryRecovery: queuedRecovery,
    }, "transcript-coordinator");

    await queuedRecovery.recoverAfterNodeRestart("node-test");
    await coordinator.recoverPending(10);
    await coordinator.recoverPending(10);

    expect(dispatched).toEqual([]);
    await expect(repository.get("delivery-transcript")).resolves.toMatchObject({
      state: "delivered",
      caller_turn_id: "transcript:assistant-result-uuid",
      last_error: "worker_restart_transcript_reconciled",
    });
  });

  it("keeps an accepted SDK input queued while its assistant transcript is pending", async () => {
    await register("delivery-input-pending", "relation-input-pending", {
      targetSessionId: "supervisor-old",
    });
    await repository.claimForTarget(
      "delivery-input-pending",
      "supervisor-old",
      "worker-before-crash",
    );
    await repository.beginDispatch(
      "delivery-input-pending",
      "worker-before-crash",
    );
    await repository.markQueued(
      "delivery-input-pending",
      "worker-before-crash",
    );

    const queuedRecovery = makeQueuedRecovery(
      "queued-input-pending",
      async (row) => ({
        kind: "input_pending",
        inputUuid: buildDeliveryInputUuid(row.delivery_id),
      }),
    );
    await expect(
      queuedRecovery.recoverAfterNodeRestart("node-test"),
    ).resolves.toBe(0);

    await expect(repository.get("delivery-input-pending")).resolves.toMatchObject({
      state: "queued",
      attempt_count: 1,
      last_error: "queued_transcript_input_pending",
    });
  });

  it("rolls ledger and notification outbox forward atomically", async () => {
    await register("delivery-outbox", "relation-outbox", {
      targetSessionId: "supervisor-old",
    });
    await repository.claimForTarget(
      "delivery-outbox",
      "supervisor-old",
      "worker-outbox",
    );
    await repository.beginDispatch("delivery-outbox", "worker-outbox");
    await harness.sql.unsafe(`
      CREATE OR REPLACE FUNCTION reject_delivery_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected outbox failure';
      END;
      $$;
      CREATE TRIGGER reject_delivery_outbox_insert
      BEFORE INSERT ON session_delivery_notification_outbox
      FOR EACH ROW EXECUTE FUNCTION reject_delivery_outbox();
    `);

    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-outbox",
      leaseOwner: "worker-outbox",
      targetSessionId: "supervisor-old",
      disposition: "queued",
      payload: { text: "done" },
    })).rejects.toThrow("injected outbox failure");
    expect(await repository.get("delivery-outbox")).toMatchObject({
      state: "dispatching",
    });
    expect(await harness.sql`
      SELECT delivery_id FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-outbox'
    `).toHaveLength(0);

    await harness.sql`
      DROP TRIGGER reject_delivery_outbox_insert
      ON session_delivery_notification_outbox
    `;
    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-outbox",
      leaseOwner: "worker-outbox",
      targetSessionId: "supervisor-old",
      disposition: "queued",
      payload: { text: "done" },
    })).resolves.toMatchObject({ state: "queued" });
    expect(await harness.sql`
      SELECT state, lease_owner
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-outbox'
    `).toMatchObject([
      { state: "claimed", lease_owner: "worker-outbox" },
    ]);
  });

  async function register(
    deliveryId: string,
    relationKey: string,
    options: {
      targetSessionId?: string;
      supervisorRole?: string;
    } = {},
  ): Promise<void> {
    await repository.register({
      deliveryId,
      targetSessionId: options.targetSessionId,
      sourceSessionId: "child-session",
      relationKey,
      completionId: `completion-${relationKey}`,
      intent: "completion_notification",
      source: "completion_notifier",
      producerKind: "child_session",
      producerId: "child-session",
      producerTerminalRevision: relationKey,
      supervisorRole: options.supervisorRole,
      payloadHash: `hash-${relationKey}`,
      payload: { text: "done", user: "agent" },
    });
  }

  async function setSupervisor(sessionId: string): Promise<void> {
    await harness.sql`
      INSERT INTO supervisor_registry (
        role, active_session_id, epoch, cursor_offset, handover_state,
        cumulative_tokens, compaction_count
      ) VALUES ('ariella', ${sessionId}, 1, 0, 'idle', 0, 0)
      ON CONFLICT (role) DO UPDATE
      SET active_session_id = EXCLUDED.active_session_id, updated_at = NOW()
    `;
  }

  function makeQueuedRecovery(
    workerId: string,
    inspect: ConstructorParameters<
      typeof QueuedDeliveryTranscriptRecovery
    >[0]["transcriptReceipt"]["inspect"],
  ): QueuedDeliveryTranscriptRecovery {
    return new QueuedDeliveryTranscriptRecovery({
      deliveryRepository: repository,
      recoveryRepository: repository.recovery,
      transcriptReceipt: { inspect },
      logger: { warn() {} },
    }, workerId);
  }
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((candidate) => {
    resolve = candidate;
  });
  return { promise, resolve };
}

async function nextMacrotask(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
