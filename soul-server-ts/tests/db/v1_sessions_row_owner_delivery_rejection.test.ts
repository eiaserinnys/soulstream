import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

describe("V1 old-contract rejection preserves central pending delivery", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 45_000);

  afterAll(async () => await harness.cleanup());

  it("rejects a post-cut legacy reserve without consuming its pending delivery", async () => {
    const now = new Date("2026-08-27T00:00:00.000Z");
    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES ('v1-old-contract', 'codex', 'initializing', 'v1-old-contract')
    `;
    await harness.sql`
      INSERT INTO session_deliveries (
        delivery_id, target_session_id, relation_key, completion_id,
        intent, source, payload_hash, payload, state, created_at, updated_at
      ) VALUES (
        'v1-old-contract-delivery', 'v1-old-contract',
        'v1-old-contract-relation', 'v1-old-contract-completion',
        'durable_next_turn', 'send_message', 'v1-old-contract-hash',
        ${harness.sql.json({ text: "must remain pending" })},
        'pending', ${now}, ${now}
      )
    `;

    const reserve = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_ownership_v2(
        'v1-old-contract', 1, 'runner_process', 'legacy-manifest',
        'legacy-runtime', ${now}
      )
    `;
    expect(reserve[0]?.applied).toBe(false);

    const rows = await harness.sql<Array<{
      state: string;
      aggregate_state: string;
      consumed_at: Date | null;
    }>>`
      SELECT state, aggregate_state, consumed_at
      FROM session_deliveries
      WHERE delivery_id = 'v1-old-contract-delivery'
    `;
    expect(rows).toEqual([{
      state: "pending",
      aggregate_state: "pending",
      consumed_at: null,
    }]);
  });
});
