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

describePostgres("terminal target delivery settlement", () => {
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

  it("settles terminal-parent completion deliveries by exact evidence", async () => {
    for (const [deliveryId, relationKey] of [
      ["terminal-receipt", "relation-terminal-receipt"],
      ["terminal-pending", "relation-terminal-pending"],
      ["terminal-queued", "relation-terminal-queued"],
      ["terminal-delivered", "relation-terminal-delivered"],
    ] as const) {
      await repository.register({
        deliveryId,
        targetSessionId: "terminal-parent",
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
    for (const deliveryId of [
      "terminal-receipt",
      "terminal-queued",
      "terminal-delivered",
    ] as const) {
      await repository.claimAttemptForTarget(
        deliveryId,
        "terminal-parent",
        `worker-${deliveryId}`,
      );
      await repository.beginDispatch(deliveryId, `worker-${deliveryId}`);
      await repository.markQueued(deliveryId, `worker-${deliveryId}`);
    }
    await repository.markDelivered(
      "terminal-delivered",
      "event:terminal-delivered",
    );
    await harness.sql`
      INSERT INTO session_delivery_relation_consumptions (
        relation_key, completion_id, caller_session_id, consumed_turn_id
      ) VALUES (
        'relation-terminal-receipt',
        'completion-relation-terminal-receipt',
        'terminal-parent',
        'event:terminal-receipt'
      )
    `;

    await expect(repository.expireStaleDeliveryAttempts()).resolves.toBe(0);

    const rows = await harness.sql<Array<{
      delivery_id: string;
      state: string;
      aggregate_state: string;
      target_receipt_id: string | null;
      superseded_terminal_revision: string | null;
    }>>`
      SELECT delivery_id, state, aggregate_state, target_receipt_id,
             superseded_terminal_revision
      FROM session_deliveries
      WHERE delivery_id LIKE 'terminal-%'
      ORDER BY delivery_id
    `;
    const expected = new Map([
      ["terminal-pending", {
        state: "pending",
        aggregateState: "pending",
        targetReceiptId: null,
        terminalRevision: null,
      }],
      ["terminal-queued", {
        state: "queued",
        aggregateState: "pending",
        targetReceiptId: null,
        terminalRevision: null,
      }],
      ["terminal-delivered", {
        state: "delivered",
        aggregateState: "delivered",
        targetReceiptId: "event:terminal-delivered",
        terminalRevision: null,
      }],
      ["terminal-receipt", {
        state: "consumed",
        aggregateState: "consumed",
        targetReceiptId: "event:terminal-receipt",
        terminalRevision: null,
      }],
    ]);
    const violations = rows.flatMap((row) => {
      const ideal = expected.get(row.delivery_id);
      if (
        ideal
        && row.state === ideal.state
        && row.aggregate_state === ideal.aggregateState
        && row.target_receipt_id === ideal.targetReceiptId
        && row.superseded_terminal_revision === ideal.terminalRevision
      ) return [];
      return [row.delivery_id];
    });

    expect(violations).toEqual([]);
  });
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
