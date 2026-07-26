import { spawnSync } from "node:child_process";

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

describePostgres("session delivery atomicity PostgreSQL integration", () => {
  let harness: FullSchemaPostgresHarness;
  let peer: SqlClient;
  let repository: SessionDeliveryRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    peer = harness.createPeer();
    repository = new SessionDeliveryRepository(harness.sql);
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM supervisor_registry`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES
        ('supervisor-old', 'claude', 'completed', 'ariella'),
        ('supervisor-new', 'claude', 'completed', 'ariella')
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("serializes both consume-first and dispatch-first interleavings on the real row", async () => {
    await register("delivery-consume-first", "relation-consume-first");
    await repository.claimForTarget("delivery-consume-first", "supervisor-old");

    let blockedDispatch!: ReturnType<SessionDeliveryRepository["beginDispatch"]>;
    await peer.begin(async (transaction) => {
      const transactional = new SessionDeliveryRepository(
        transaction as unknown as SqlClient,
      );
      await transaction`
        SELECT 1 FROM session_deliveries
        WHERE delivery_id = 'delivery-consume-first'
        FOR UPDATE
      `;
      blockedDispatch = repository.beginDispatch("delivery-consume-first");
      await new Promise((resolve) => setImmediate(resolve));
      await transactional.markConsumedByRelation(
        "relation-consume-first",
        "completion-relation-consume-first",
        "turn-inline",
      );
    });
    await expect(blockedDispatch).resolves.toBeNull();
    expect((await repository.get("delivery-consume-first"))?.state).toBe("consumed");

    await register("delivery-dispatch-first", "relation-dispatch-first");
    await repository.claimForTarget("delivery-dispatch-first", "supervisor-old");
    let blockedConsume!: ReturnType<
      SessionDeliveryRepository["markConsumedByRelation"]
    >;
    await peer.begin(async (transaction) => {
      const transactional = new SessionDeliveryRepository(
        transaction as unknown as SqlClient,
      );
      await transaction`
        SELECT 1 FROM session_deliveries
        WHERE delivery_id = 'delivery-dispatch-first'
        FOR UPDATE
      `;
      blockedConsume = repository.markConsumedByRelation(
        "relation-dispatch-first",
        "completion-relation-dispatch-first",
        "turn-inline",
      );
      await new Promise((resolve) => setImmediate(resolve));
      await expect(transactional.beginDispatch("delivery-dispatch-first"))
        .resolves.toMatchObject({ state: "dispatching" });
    });
    await expect(blockedConsume).resolves.toBeNull();
    expect((await repository.get("delivery-dispatch-first"))?.state)
      .toBe("dispatching");
  });

  it("rejects a stale supervisor snapshot and lets retry claim the new epoch", async () => {
    await harness.sql`
      INSERT INTO supervisor_registry (
        role, active_session_id, epoch, cursor_offset, handover_state,
        cumulative_tokens, compaction_count
      ) VALUES ('ariella', 'supervisor-old', 4, 0, 'idle', 0, 0)
    `;
    const lookedUp = await harness.sql<Array<{
      active_session_id: string;
      epoch: number;
    }>>`
      SELECT active_session_id, epoch::int AS epoch
      FROM supervisor_registry
      WHERE role = 'ariella'
    `;
    await register("delivery-handover", "relation-handover");

    // Real handover occurs after producer lookup but before its conditional claim.
    await peer`
      UPDATE supervisor_registry
      SET active_session_id = 'supervisor-new', epoch = 5, updated_at = NOW()
      WHERE role = 'ariella'
    `;

    await expect(repository.claimForSupervisorTarget(
      "delivery-handover",
      lookedUp[0]!.active_session_id,
      "ariella",
      lookedUp[0]!.epoch,
    )).resolves.toBeNull();
    expect((await repository.get("delivery-handover"))?.state).toBe("pending");

    await expect(repository.claimForSupervisorTarget(
      "delivery-handover",
      "supervisor-new",
      "ariella",
      5,
    )).resolves.toMatchObject({
      target_session_id: "supervisor-new",
      supervisor_role: "ariella",
      supervisor_epoch: 5,
      state: "claimed",
    });
  });

  async function register(deliveryId: string, relationKey: string): Promise<void> {
    await repository.register({
      deliveryId,
      targetSessionId: "supervisor-old",
      relationKey,
      completionId: `completion-${relationKey}`,
      intent: "completion_notification",
      source: "completion_notifier",
      payloadHash: `hash-${relationKey}`,
      payload: { text: "done" },
    });
  }
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
