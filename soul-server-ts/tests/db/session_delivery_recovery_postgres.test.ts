import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionDeliveryRepository } from "../../src/db/repositories/session_delivery_repository.js";
import type { SqlClient } from "../../src/db/session_db.js";
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
        "../../../packages/db-schema/sql/pending/043_session_deliveries.sql",
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
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES
        ('supervisor-old', 'claude', 'completed', 'ariella'),
        ('supervisor-new', 'claude', 'completed', 'ariella'),
        ('child-session', 'claude', 'completed', 'worker')
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

  it("uses SKIP LOCKED across workers and does not let poison rows starve a due row", async () => {
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

    await repository.retryLeasedDelivery(
      "delivery-free",
      "worker-b",
      "poison",
      new Date(Date.now() + 60_000),
    );
    for (let index = 0; index < 100; index += 1) {
      await register(
        `delivery-poison-${index}`,
        `relation-poison-${index}`,
        { supervisorRole: "ariella" },
      );
    }
    await harness.sql`
      UPDATE session_deliveries
      SET next_attempt_at = NOW() + INTERVAL '1 hour'
      WHERE delivery_id LIKE 'delivery-poison-%'
         OR delivery_id IN ('delivery-locked', 'delivery-free')
    `;
    await register("delivery-healthy", "relation-healthy", {
      supervisorRole: "ariella",
    });

    await expect(repository.claimRecoverableCompletionDeliveries(
      "worker-fair",
      1,
    )).resolves.toMatchObject([
      { delivery_id: "delivery-healthy", lease_owner: "worker-fair" },
    ]);
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
