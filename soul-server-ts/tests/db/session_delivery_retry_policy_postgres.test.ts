import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionDeliveryRepository } from
  "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import { createBoardYjsSqlAdapter } from
  "../../../orch-server-ts/src/board-yjs/board_yjs_sql.js";
import { registerPersistenceHostRoutes } from
  "../../../orch-server-ts/src/control_plane/persistence_host_routes.js";
import type { PersistenceHostRepositories } from
  "../../../orch-server-ts/src/control_plane/persistence_host_runtime.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("session delivery retry policy PostgreSQL contract", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: SessionDeliveryRepository;
  const app = Fastify();

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    const productionSql = createBoardYjsSqlAdapter(
      harness.sql as unknown as Parameters<typeof createBoardYjsSqlAdapter>[0],
    );
    repository = new SessionDeliveryRepository(productionSql);
    registerPersistenceHostRoutes(app, {
      authBearerToken: "service-token",
      repositoryProvider: async () => ({ deliveries: repository }) as
        unknown as PersistenceHostRepositories,
    });
  }, 45_000);

  beforeEach(async () => {
    await harness.sql`DELETE FROM session_deliveries`;
  });

  afterAll(async () => {
    await app.close();
    await harness.cleanup();
  });

  it.each([0, 250])(
    "retries a leased delivery with an explicit %dms delay",
    async (retryDelayMs) => {
      const deliveryId = `retry-delay-${retryDelayMs}`;
      await harness.sql`
        INSERT INTO session_deliveries (
          delivery_id,
          relation_key,
          intent,
          source,
          payload_hash,
          payload,
          state,
          lease_owner,
          lease_expires_at
        ) VALUES (
          ${deliveryId},
          ${`relation-${retryDelayMs}`},
          'durable_next_turn',
          'test',
          ${`hash-${retryDelayMs}`},
          '{}'::jsonb,
          'claimed',
          'worker-a',
          NOW() + INTERVAL '1 minute'
        )
      `;
      const [{ now: before }] = await harness.sql<Array<{ now: Date }>>`
        SELECT NOW() AS now
      `;

      const retried = await repository.retryLeasedDelivery(
        deliveryId,
        "worker-a",
        "transient failure",
        retryDelayMs,
      );

      const [{ now: after }] = await harness.sql<Array<{ now: Date }>>`
        SELECT NOW() AS now
      `;
      expect(retried).toMatchObject({
        delivery_id: deliveryId,
        state: "pending",
        aggregate_state: "pending",
        lease_owner: null,
        lease_expires_at: null,
        attempt_count: 1,
        last_error: "transient failure",
      });
      expect(retried!.next_attempt_at.getTime())
        .toBeGreaterThanOrEqual(before.getTime() + retryDelayMs);
      expect(retried!.next_attempt_at.getTime())
        .toBeLessThanOrEqual(after.getTime() + retryDelayMs);
      await expect(harness.sql`
        SELECT delivery_id, attempt_number, lease_owner, outcome, reason
        FROM session_delivery_attempts
        WHERE delivery_id = ${deliveryId}
      `).resolves.toEqual([{
        delivery_id: deliveryId,
        attempt_number: 1,
        lease_owner: "worker-a",
        outcome: "retryable",
        reason: "transient failure",
      }]);
    },
  );

  it("accepts the legacy absolute retry instant across the host boundary", async () => {
    await harness.sql`
      INSERT INTO session_deliveries (
        delivery_id,
        relation_key,
        intent,
        source,
        payload_hash,
        payload,
        state,
        lease_owner,
        lease_expires_at
      ) VALUES (
        'legacy-retry-at',
        'legacy-retry-at-relation',
        'durable_next_turn',
        'test',
        'legacy-retry-at-hash',
        '{}'::jsonb,
        'claimed',
        'worker-a',
        NOW() + INTERVAL '1 minute'
      )
    `;
    const legacyRetryAt = new Date(Date.now() + 250);

    const response = await app.inject({
      method: "POST",
      url: "/api/session-deliveries/host/retry_leased_delivery",
      headers: { authorization: "Bearer service-token" },
      payload: {
        args: [
          "legacy-retry-at",
          "worker-a",
          "legacy client retry",
          legacyRetryAt.toISOString(),
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    await expect(repository.get("legacy-retry-at")).resolves.toMatchObject({
      state: "pending",
      lease_owner: null,
      attempt_count: 1,
      last_error: "legacy client retry",
    });
  });
});
