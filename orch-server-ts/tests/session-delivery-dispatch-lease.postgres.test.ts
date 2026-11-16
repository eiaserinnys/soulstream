/**
 * card #1380 — beginDispatch가 dispatching 전이에서 attempt_expires_at을
 * dispatchLease(기본 120초)로 연장한다. claim의 15초가 지난 dispatching 줄은
 * 만료 sweep이 되돌리지 않고, 연장된 시한이 지나야 pending으로 되돌린다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { SessionDeliveryRepository } from
  "../src/control_plane/repositories/session_delivery_repository.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

describe("dispatching attempt expiry over PostgreSQL", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: SessionDeliveryRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    repository = new SessionDeliveryRepository(harness.sql as unknown as SqlClient);
  }, 60_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_delivery_attempts`;
    await harness.sql`DELETE FROM session_deliveries`;
    await harness.sql`DELETE FROM sessions`;
    await harness.sql`
      INSERT INTO sessions (session_id, status) VALUES ('target-1', 'running')
    `;
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("keeps a dispatching attempt past the claim TTL and reverts it only after the lease", async () => {
    await insertPendingDelivery();
    await expect(repository.claim("delivery-1", "token-1")).resolves.not.toBeNull();
    const [claimed] = await harness.sql<Array<{ attempt_expires_at: Date }>>`
      SELECT attempt_expires_at
      FROM session_deliveries
      WHERE delivery_id = 'delivery-1'
    `;
    expect(claimed!.attempt_expires_at.getTime() - Date.now()).toBeLessThan(30_000);

    await expect(repository.beginDispatch("delivery-1", "token-1")).resolves.not.toBeNull();
    const [dispatching] = await harness.sql<Array<{
      attempt_expires_at: Date;
      state: string;
    }>>`
      SELECT attempt_expires_at, state
      FROM session_deliveries
      WHERE delivery_id = 'delivery-1'
    `;
    expect(dispatching!.state).toBe("dispatching");
    expect(dispatching!.attempt_expires_at.getTime() - Date.now()).toBeGreaterThan(90_000);

    // claim의 15초가 지난 시점을 만든다. 연장된 시한은 아직 남아 있다.
    await harness.sql`
      UPDATE session_deliveries
      SET dispatching_at = NOW() - INTERVAL '16 seconds'
      WHERE delivery_id = 'delivery-1'
    `;
    await expect(repository.expireStaleDeliveryAttempts()).resolves.toBe(0);
    const [alive] = await harness.sql<Array<{ state: string }>>`
      SELECT state FROM session_deliveries WHERE delivery_id = 'delivery-1'
    `;
    expect(alive!.state).toBe("dispatching");

    // 연장된 시한이 지나면 pending으로 되돌린다.
    await harness.sql`
      UPDATE session_deliveries
      SET attempt_expires_at = NOW() - INTERVAL '1 second'
      WHERE delivery_id = 'delivery-1'
    `;
    await expect(repository.expireStaleDeliveryAttempts()).resolves.toBe(1);
    const [expired] = await harness.sql<Array<{
      state: string;
      attempt_token: string | null;
      last_error: string | null;
    }>>`
      SELECT state, attempt_token, last_error
      FROM session_deliveries
      WHERE delivery_id = 'delivery-1'
    `;
    expect(expired).toMatchObject({
      state: "pending",
      attempt_token: null,
      last_error: "delivery attempt expired",
    });
  });

  it("honors a custom dispatching window", async () => {
    await insertPendingDelivery();
    await repository.claim("delivery-1", "token-1");
    await repository.beginDispatch("delivery-1", "token-1", 5_000);

    const [row] = await harness.sql<Array<{ attempt_expires_at: Date }>>`
      SELECT attempt_expires_at
      FROM session_deliveries
      WHERE delivery_id = 'delivery-1'
    `;
    const remainingMs = row!.attempt_expires_at.getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(1_000);
    expect(remainingMs).toBeLessThan(10_000);
  });

  async function insertPendingDelivery(): Promise<void> {
    await harness.sql`
      INSERT INTO session_deliveries (
        delivery_id, target_session_id, relation_key, intent, source,
        payload_hash, payload, state, aggregate_state
      ) VALUES (
        'delivery-1', 'target-1', 'user_message:target-1:delivery-1',
        'human_live_steer', 'browser', 'hash-1', ${harness.sql.json({})},
        'pending', 'pending'
      )
    `;
  }
});
