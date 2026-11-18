import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { queryEventIngressDeliveryLatency, type DeliveryLatencySql } from "../src/node/event_ingress_delivery_latency.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

const SINCE = "2026-11-15T12:00:00.000Z";
const UNTIL = "2026-11-17T12:00:00.000Z";
const COMMITTED = "2026-11-16T12:00:00.000Z";

describe("delivery latency query (real Postgres)", () => {
  let h: PagePostgresHarness;
  let sql: DeliveryLatencySql;

  async function put(node: string, id: number, delayMs: number, committedAt = COMMITTED) {
    const session = `session-${node}`;
    const committed = new Date(committedAt);
    const created = new Date(committed.getTime() - delayMs);
    await h.sql`INSERT INTO events (session_id, id, event_type, created_at)
      VALUES (${session}, ${id}, ${`type-${id}`}, ${created})`;
    await h.sql`INSERT INTO event_ingress_receipts
      (node_id, stream_id, source_seq, session_id, payload_hash, event_id, created_at)
      VALUES (${node}, '00000000-0000-0000-0000-000000000001', ${id}, ${session},
              ${"a".repeat(64)}, ${id}, ${committed})`;
  }

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    sql = h.sql as unknown as DeliveryLatencySql;
    await h.sql.unsafe(await readFile(new URL("../../packages/db-schema/sql/migrations/054_event_ingress_receipts.sql", import.meta.url), "utf8"));
    await h.sql`INSERT INTO sessions (session_id) VALUES ('session-node-a'), ('session-node-b')`;
    await put("node-a", 1, -100, SINCE); // inclusive lower bound and a negative delay
    await put("node-b", 1, 0); // same event_id in another session must not cross-join
    await put("node-a", 3, 1000);
    await put("node-b", 4, 2000);
    await put("node-a", 5, 3000);
    await put("node-b", 6, 3000); // equal delays break ties by descending event_id
    await put("node-a", 7, 9000, "2026-11-15T11:59:59.999Z");
    await put("node-b", 8, 8000, UNTIL); // exclusive upper bound
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("computes node and overall percentiles and the five slowest within a 48-hour window", async () => {
    const result = await queryEventIngressDeliveryLatency(sql, { since: SINCE, until: UNTIL });

    expect(result.window).toEqual({ since: SINCE, until: UNTIL });
    expect(result.overall).toEqual({ count: 6, p50_ms: 1500, p90_ms: 3000, p99_ms: 3000, max_ms: 3000 });
    expect(result.by_node).toEqual([
      { node_id: "node-a", count: 3, p50_ms: 1000, p90_ms: 2600, p99_ms: 2960, max_ms: 3000 },
      { node_id: "node-b", count: 3, p50_ms: 2000, p90_ms: 2800, p99_ms: 2980, max_ms: 3000 },
    ]);
    expect(result.slowest.map((row) => [row.node_id, row.event_id, row.delay_ms])).toEqual([
      ["node-b", 6, 3000], ["node-a", 5, 3000], ["node-b", 4, 2000],
      ["node-a", 3, 1000], ["node-b", 1, 0],
    ]);
    expect(result.slowest[0]).toEqual({
      node_id: "node-b", session_id: "session-node-b", event_id: 6, event_type: "type-6",
      created_at: "2026-11-16T11:59:57.000Z", committed_at: COMMITTED, delay_ms: 3000,
    });
  });

  it("filters every result by node and keeps the empty result shape", async () => {
    const filtered = await queryEventIngressDeliveryLatency(sql, { since: SINCE, until: UNTIL, node_id: "node-a" });
    expect(filtered.overall).toEqual({ count: 3, p50_ms: 1000, p90_ms: 2600, p99_ms: 2960, max_ms: 3000 });
    expect(filtered.by_node).toEqual([{ node_id: "node-a", ...filtered.overall }]);
    expect(filtered.slowest.map((row) => [row.event_id, row.delay_ms])).toEqual([[5, 3000], [3, 1000], [1, -100]]);

    const empty = await queryEventIngressDeliveryLatency(sql, { since: SINCE, until: UNTIL, node_id: "missing" });
    expect(empty.overall).toEqual({ count: 0, p50_ms: null, p90_ms: null, p99_ms: null, max_ms: null });
    expect(empty.by_node).toEqual([]);
    expect(empty.slowest).toEqual([]);
  });

  it("accepts a seven-day window and includes a receipt at the earlier window's upper bound", async () => {
    const result = await queryEventIngressDeliveryLatency(sql, { since: SINCE, until: "2026-11-22T12:00:00.000Z" });
    expect(result.overall.count).toBe(7);
    expect(result.overall.max_ms).toBe(8000);
    expect(result.slowest[0]?.event_id).toBe(8);
  });
});
