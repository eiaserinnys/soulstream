import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionDeliveryRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
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
    const terminalFenceMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/065_completion_terminal_revision_fence.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await harness.sql.unsafe(terminalFenceMigration);
    repository = new SessionDeliveryRepository(harness.sql);
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_notification_outbox`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, session_type, status, agent_id)
      VALUES
        ('caller-session', 'node-test', 'claude', 'completed', 'caller'),
        ('child-session', 'node-test', 'claude', 'completed', 'worker')
    `;
    await harness.sql`
      UPDATE sessions
      SET termination_event_id = 42, last_assistant_text = 'revision 42'
      WHERE session_id = 'child-session'
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("uses SKIP LOCKED across workers", async () => {
    await register("delivery-locked", "relation-locked", {
      targetSessionId: "caller-session",
    });
    await register("delivery-free", "relation-free", {
      targetSessionId: "caller-session",
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
    await register("delivery-poison", "relation-poison");
    await register("delivery-healthy", "relation-healthy", {
      targetSessionId: "caller-session",
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

  it("coalesces pending runtime siblings before recovery claim and preserves claimed work", async () => {
    const createdAt = new Date("2026-08-18T00:00:00.000Z");
    for (const [deliveryId, relationKey, state] of [
      ["runtime-claimed", "runtime-claimed-relation", "claimed"],
      ["runtime-pending-old", "runtime-pending-old-relation", "pending"],
      ["runtime-pending-latest", "runtime-pending-latest-relation", "pending"],
    ] as const) {
      await harness.sql`
        INSERT INTO session_deliveries (
          delivery_id, target_session_id, relation_key, intent, source,
          payload_hash, payload, state, created_at, updated_at,
          lease_owner, lease_expires_at
        ) VALUES (
          ${deliveryId}, 'caller-session', ${relationKey},
          'runtime_followup', 'claude_runtime_task_followup',
          ${`hash-${deliveryId}`},
          ${harness.sql.json({
            text: deliveryId,
            user: "system",
            source: "claude_runtime_task_followup",
            followup_key: "caller-session:task-1",
            followup_attempt: 2,
          })},
          ${state}, ${createdAt}, ${createdAt},
          ${state === "claimed" ? "existing-worker" : null},
          ${state === "claimed" ? new Date("2099-01-01T00:00:00Z") : null}
        )
      `;
    }

    await expect(repository.claimRecoverableCompletionDeliveries(
      "recovery-worker",
      10,
    )).resolves.toMatchObject([{
      delivery_id: "runtime-pending-latest",
      state: "claimed",
      lease_owner: "recovery-worker",
    }]);
    await expect(repository.get("runtime-pending-old")).resolves.toMatchObject({
      state: "superseded",
      superseded_at: expect.any(Date),
    });
    await expect(repository.get("runtime-claimed")).resolves.toMatchObject({
      state: "claimed",
      lease_owner: "existing-worker",
    });
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
    const sequenceMigration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/066_session_delivery_enqueue_sequence.sql",
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
      await upgradeSql.unsafe(sequenceMigration);
      await upgradeSql.unsafe(sequenceMigration);

      const columns = await upgradeSql<Array<{ column_name: string }>>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = ${upgradeSchema}
          AND table_name = 'session_deliveries'
          AND column_name IN ('dispatching_at', 'enqueue_sequence')
        ORDER BY column_name
      `;
      expect(columns.map((row) => row.column_name)).toEqual([
        "dispatching_at",
        "enqueue_sequence",
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
          payload_hash,
          state,
          dispatching_at
        ) VALUES (
          'upgrade-delivery',
          'upgrade-target',
          'upgrade-relation',
          'completion_notification',
          'completion_notifier',
          'upgrade-hash',
          'dispatching',
          NOW()
        )
      `;
      await expect(upgradeSql`
        SELECT state, dispatching_at IS NOT NULL AS has_dispatching_at
        FROM session_deliveries
        WHERE delivery_id = 'upgrade-delivery'
      `).resolves.toMatchObject([{
        state: "dispatching",
        has_dispatching_at: true,
      }]);
    } finally {
      await upgradeSql.unsafe(`DROP SCHEMA IF EXISTS ${upgradeSchema} CASCADE`);
    }
  });

  it("recovers an expired crash lease and fences the old worker from dispatch", async () => {
    await register("delivery-crash", "relation-crash", {
      targetSessionId: "caller-session",
    });
    await repository.claimForTarget(
      "delivery-crash",
      "caller-session",
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
        targetSessionId: "caller-session",
      });
      await repository.claimForTarget(
        boundary.deliveryId,
        "caller-session",
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

  it("settles a queued delivery from the transcript without replaying its SDK input", async () => {
    await register("delivery-transcript", "relation-transcript", {
      targetSessionId: "caller-session",
    });
    await repository.claimForTarget(
      "delivery-transcript",
      "caller-session",
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
      targetSessionId: "caller-session",
    });
    await repository.claimForTarget(
      "delivery-input-pending",
      "caller-session",
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
      targetSessionId: "caller-session",
    });
    await repository.claimForTarget(
      "delivery-outbox",
      "caller-session",
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
      targetSessionId: "caller-session",
      disposition: "queued",
      payload: notificationPayload("delivery-outbox", "relation-outbox"),
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
      targetSessionId: "caller-session",
      disposition: "queued",
      payload: notificationPayload("delivery-outbox", "relation-outbox"),
    })).resolves.toMatchObject({ state: "queued" });
    expect(await harness.sql`
      SELECT state, lease_owner
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-outbox'
    `).toMatchObject([
      { state: "claimed", lease_owner: "worker-outbox" },
    ]);
  });

  it("validates notification payload before advancing the delivery ledger", async () => {
    await register("delivery-invalid-stage", "relation-invalid-stage", {
      targetSessionId: "caller-session",
    });
    await repository.claimForTarget(
      "delivery-invalid-stage",
      "caller-session",
      "worker-invalid-stage",
    );
    await repository.beginDispatch("delivery-invalid-stage", "worker-invalid-stage");

    await expect(repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-invalid-stage",
      leaseOwner: "worker-invalid-stage",
      targetSessionId: "caller-session",
      disposition: "queued",
      payload: { text: "done" },
    })).rejects.toThrow("Notification outbox payload is missing user");

    await expect(repository.get("delivery-invalid-stage")).resolves.toMatchObject({
      state: "dispatching",
    });
    expect(await harness.sql`
      SELECT delivery_id FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-invalid-stage'
    `).toHaveLength(0);
  });

  it("claims notification rows only on the target session owner node", async () => {
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, session_type, status, agent_id)
      VALUES
        ('other-caller-session', 'node-other', 'claude', 'completed', 'caller'),
        ('ownerless-caller-session', NULL, 'claude', 'completed', 'caller')
    `;
    for (const [deliveryId, relationKey, targetSessionId, worker] of [
      ["delivery-node-local", "relation-node-local", "caller-session", "worker-local"],
      ["delivery-node-other", "relation-node-other", "other-caller-session", "worker-other"],
      [
        "delivery-node-ownerless",
        "relation-node-ownerless",
        "ownerless-caller-session",
        "worker-ownerless",
      ],
    ] as const) {
      await register(deliveryId, relationKey, { targetSessionId });
      await repository.claimForTarget(deliveryId, targetSessionId, worker);
      await repository.beginDispatch(deliveryId, worker);
      await repository.notifications.stageWithQueuedDelivery({
        deliveryId,
        leaseOwner: worker,
        targetSessionId,
        disposition: "queued",
        payload: notificationPayload(deliveryId, relationKey),
      });
    }
    await harness.sql`
      UPDATE session_delivery_notification_outbox
      SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL
    `;

    await expect(repository.notifications.claimDue(
      "node-test",
      "notification-node-test",
      100,
    )).resolves.toMatchObject([{ delivery_id: "delivery-node-local" }]);
    await expect(repository.notifications.claimDue(
      "node-other",
      "notification-node-other",
      100,
    )).resolves.toMatchObject([{ delivery_id: "delivery-node-other" }]);
    await expect(harness.sql`
      SELECT state, last_error
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-node-ownerless'
    `).resolves.toMatchObject([{
      state: "dead_letter",
      last_error: "notification target session has no owner node",
    }]);
  });

  it("dead-letters retryable rows and only requeues them through the explicit operator path", async () => {
    for (const [deliveryId, relationKey, worker] of [
      ["delivery-attempt-cap", "relation-attempt-cap", "worker-attempt-cap"],
      ["delivery-age-cap", "relation-age-cap", "worker-age-cap"],
    ] as const) {
      await register(deliveryId, relationKey, { targetSessionId: "caller-session" });
      await repository.claimForTarget(deliveryId, "caller-session", worker);
      await repository.beginDispatch(deliveryId, worker);
      await repository.notifications.stageWithQueuedDelivery({
        deliveryId,
        leaseOwner: worker,
        targetSessionId: "caller-session",
        disposition: "queued",
        payload: notificationPayload(deliveryId, relationKey),
      });
    }
    await harness.sql`
      UPDATE session_delivery_notification_outbox
      SET attempt_count = 15
      WHERE delivery_id = 'delivery-attempt-cap'
    `;
    await harness.sql`
      UPDATE session_delivery_notification_outbox
      SET created_at = NOW() - INTERVAL '25 hours'
      WHERE delivery_id = 'delivery-age-cap'
    `;
    const oldestAllowed = new Date(Date.now() - 24 * 60 * 60 * 1000);

    await expect(repository.notifications.retry(
      "delivery-attempt-cap",
      "worker-attempt-cap",
      "transient failure",
      new Date(),
      16,
      oldestAllowed,
    )).resolves.toMatchObject({ state: "dead_letter", attempt_count: 16 });
    await expect(repository.notifications.retry(
      "delivery-age-cap",
      "worker-age-cap",
      "transient failure",
      new Date(),
      16,
      oldestAllowed,
    )).resolves.toMatchObject({ state: "dead_letter", attempt_count: 1 });

    await expect(repository.notifications.listDeadLetters(10)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ delivery_id: "delivery-attempt-cap" }),
        expect.objectContaining({ delivery_id: "delivery-age-cap" }),
      ]),
    );
    await expect(
      repository.notifications.requeueDeadLetter("delivery-attempt-cap"),
    ).resolves.toMatchObject({
      state: "pending",
      attempt_count: 0,
      last_error: null,
      dead_lettered_at: null,
    });
    await expect(
      repository.notifications.requeueDeadLetter("delivery-attempt-cap"),
    ).resolves.toBeNull();
  });

  it("quarantines residual camelCase deliveryIntent rows in migration 062", async () => {
    await register("delivery-legacy-camel", "relation-legacy-camel", {
      targetSessionId: "caller-session",
    });
    await repository.claimForTarget(
      "delivery-legacy-camel",
      "caller-session",
      "worker-legacy-camel",
    );
    await repository.beginDispatch("delivery-legacy-camel", "worker-legacy-camel");
    await repository.notifications.stageWithQueuedDelivery({
      deliveryId: "delivery-legacy-camel",
      leaseOwner: "worker-legacy-camel",
      targetSessionId: "caller-session",
      disposition: "queued",
      payload: notificationPayload("delivery-legacy-camel", "relation-legacy-camel"),
    });
    await harness.sql`
      UPDATE session_delivery_notification_outbox
      SET payload = (payload - 'delivery_intent')
        || jsonb_build_object('deliveryIntent', 'completion_notification'),
        state = 'pending', lease_owner = NULL, lease_expires_at = NULL
      WHERE delivery_id = 'delivery-legacy-camel'
    `;
    const migration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/062_notification_outbox_hardening.sql",
        import.meta.url,
      ),
      "utf8",
    );

    await harness.sql.unsafe(migration);

    expect(await harness.sql`
      SELECT state, dead_lettered_at, last_error
      FROM session_delivery_notification_outbox
      WHERE delivery_id = 'delivery-legacy-camel'
    `).toMatchObject([{
      state: "dead_letter",
      dead_lettered_at: expect.any(Date),
      last_error: "legacy camelCase deliveryIntent quarantined by migration 062",
    }]);
  });

  async function register(
    deliveryId: string,
    relationKey: string,
    options: {
      targetSessionId?: string;
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
      producerTerminalRevision: "42",
      payloadHash: `hash-${relationKey}`,
      payload: { text: "done", user: "agent" },
    });
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

function notificationPayload(
  deliveryId: string,
  relationKey: string,
): Record<string, unknown> {
  return {
    text: "done",
    user: "agent",
    source: "completion_notifier",
    delivery_id: deliveryId,
    delivery_intent: "completion_notification",
    completion_id: `completion-${relationKey}`,
    relation_key: relationKey,
    disposition: "queued",
    caller_info: null,
  };
}

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

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
