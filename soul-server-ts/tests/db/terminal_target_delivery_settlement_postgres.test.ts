import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionDeliveryRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

describePostgres("exact completion receipt authority", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: SessionDeliveryRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    repository = new SessionDeliveryRepository(harness.sql);
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_relation_consumptions`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (
        session_id, node_id, session_type, status, agent_id,
        termination_event_id
      ) VALUES
        ('terminal-parent', 'node-test', 'claude', 'completed', 'caller', 77),
        ('child-session', 'node-test', 'claude', 'completed', 'child', 42)
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("keeps queued completion ownership until its exact late receipt consumes it", async () => {
    await repository.register({
      deliveryId: "terminal-queued",
      targetSessionId: "terminal-parent",
      sourceSessionId: "child-session",
      relationKey: "relation-terminal-queued",
      completionId: "completion-relation-terminal-queued",
      intent: "completion_notification",
      source: "completion_notifier",
      producerKind: "child_session",
      producerId: "child-session",
      producerTerminalRevision: "42",
      payloadHash: "hash-relation-terminal-queued",
      payload: { text: "done", user: "agent" },
    });
    await repository.claimForTarget(
      "terminal-queued",
      "terminal-parent",
      "worker-terminal-queued",
    );
    await repository.beginDispatch("terminal-queued", "worker-terminal-queued");
    await repository.markQueued("terminal-queued", "worker-terminal-queued");
    await harness.sql`
      UPDATE session_deliveries
      SET lease_expires_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = 'terminal-queued'
    `;

    await expect(repository.releaseExpiredDeliveryLeases()).resolves.toBe(0);
    await expect(repository.get("terminal-queued")).resolves.toMatchObject({
      state: "queued",
      aggregate_state: "pending",
    });

    await expect(repository.markConsumedByRelation({
      deliveryId: "terminal-queued",
      relationKey: "relation-terminal-queued",
      completionId: "completion-relation-terminal-queued",
      callerSessionId: "terminal-parent",
      consumedTurnId: "event:late-exact-receipt",
    })).resolves.toMatchObject({ deliveryConsumed: true });

    await expect(repository.claimRecoverableCompletionDeliveries(
      "post-receipt-recovery",
      10,
    )).resolves.toEqual([]);
    await expect(repository.get("terminal-queued")).resolves.toMatchObject({
      state: "consumed",
      aggregate_state: "consumed",
      target_receipt_id: "event:late-exact-receipt",
      consumed_reason: "exact relation receipt",
    });
  });
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
