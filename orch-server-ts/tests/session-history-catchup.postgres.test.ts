import { describe, expect, it } from "vitest";
import { createLiveSessionHistoryProvider } from "../src/runtime/live_session_history_provider.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { createFullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

describe("bounded session catchup in PostgreSQL", () => {
  it("limits database results, freezes the watermark, and preserves receipt semantics", async () => {
    const db = await createFullSchemaPostgresHarness();
    try {
      const initial = await db.sql`SELECT COUNT(*)::int AS count FROM events`;
      expect(initial[0]?.count).toBe(0);
      await db.sql`INSERT INTO sessions (session_id) VALUES ('catchup'), ('other')`;
      await db.sql`
        INSERT INTO events (session_id, id, event_type, payload)
        SELECT session_id, id, 'tool_result', jsonb_build_object('type', 'tool_result', 'id', id)
        FROM unnest(ARRAY['catchup', 'other']) AS session_id
        CROSS JOIN generate_series(6, 2005) AS id
      `;
      await db.sql`
        INSERT INTO event_ingress_receipts
          (node_id, stream_id, source_seq, session_id, payload_hash, event_id, effect_application)
        VALUES ('test', '00000000-0000-0000-0000-000000000001', 1,
          'catchup', repeat('a', 64), 6, '{"applied": false}')
      `;
      const resultCounts: number[] = [];
      const observedSql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
        db.sql(strings, ...values as never[]).then((rows) => {
          if (strings.join("?").includes("semantic_receipt.effect_applied")) {
            resultCounts.push(rows.length);
          }
          return rows;
        })) as unknown as LivePostgresSql;
      const provider = createLiveSessionHistoryProvider({
        sqlResolver: { resolveSql: async () => observedSql, close: async () => {} },
      });
      for (const [throughId, expectedCount] of [[205, 200], [206, 201], [2005, 201]] as const) {
        const rows = [];
        for await (const row of provider.streamEventsRaw("catchup", 5, { limit: 201, throughId })) {
          rows.push(row);
        }
        expect(rows).toHaveLength(expectedCount);
        expect(rows[0]).toMatchObject({ eventId: 6, sessionEffectApplied: false });
        expect(rows.at(-1)?.eventId).toBe(5 + expectedCount);
        expect(JSON.parse(rows[0]!.payloadText)).toEqual({ type: "tool_result", id: 6 });
      }
      expect(resultCounts).toEqual([200, 201, 201]);
      const legacy = [];
      for await (const row of provider.streamEventsRaw("catchup", 5)) legacy.push(row);
      expect(legacy).toHaveLength(2000);
      expect(resultCounts.at(-1)).toBe(2000);
    } finally {
      await db.cleanup();
    }
  });
});
