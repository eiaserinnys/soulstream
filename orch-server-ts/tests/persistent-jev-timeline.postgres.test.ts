import { describe, expect, it } from "vitest";

import {
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";
import { createFullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

describe("live DB session history persistent Jev timeline", () => {
  it("reloads Jev and generation observations through all three timeline SQL branches", async () => {
    const db = await createFullSchemaPostgresHarness();
    try {
      const jevPayload = {
        type: "debug",
        kind: "persistent_jev_candidates",
        observation: {
          input_id: "input-1",
          selected: [],
          candidate_counts: {
            turn_summaries: 0,
            cards: 0,
            search_sessions: 0,
            recent_completed_sessions: 0,
          },
          model: "jev-latest",
          latency_ms: 15,
          top_raw_score: 0,
        },
      };
      const otherDebugPayload = { type: "debug", kind: "other_debug_kind", value: "excluded" };
      const generationPayload = { generation: 2, reason: "user_requested", previous_generation: 1, current_generation: 2, checkpoint: {}, timestamp: "2026-10-05T00:00:00Z" };
      await db.sql`INSERT INTO sessions (session_id) VALUES ('timeline-fixture')`;
      await db.sql`
        INSERT INTO events (session_id, id, event_type, payload, created_at) VALUES
          ('timeline-fixture', 40, 'debug', ${db.sql.json(otherDebugPayload)}, '2026-10-02T00:00:00Z'),
          ('timeline-fixture', 41, 'debug', ${db.sql.json(jevPayload)}, '2026-10-03T00:00:00Z'),
          ('timeline-fixture', 42, 'generation_started', ${db.sql.json(generationPayload)}, '2026-10-04T00:00:00Z')
      `;
      const provider = createLiveDbCatalogRepository({ sql: db.sql as unknown as LivePostgresSql }).sessionHistoryProvider;
      const jevAndGeneration = [
        expect.objectContaining({ id: 41, event_type: "debug", payload: jevPayload }),
        expect.objectContaining({ id: 42, event_type: "generation_started", payload: generationPayload }),
      ];
      const [firstPage] = await provider.readTimeline("timeline-fixture", null, 10);
      expect(firstPage).toEqual(expect.arrayContaining(jevAndGeneration));
      expect(firstPage.some((row) => (row as { id?: number }).id === 40)).toBe(false);
      const [beforePage] = await provider.readTimeline("timeline-fixture", "2026-10-05T00:00:00.000Z", 10);
      expect(beforePage).toEqual(expect.arrayContaining(jevAndGeneration));
      const [afterPage] = await provider.readTimeline("timeline-fixture", "2026-10-05T00:00:00.000Z,43", 10);
      expect(afterPage).toEqual(expect.arrayContaining(jevAndGeneration));
      await expect(provider.readTimeline("timeline-fixture", null, 10, ["generation_started"])).resolves.toEqual([
        [expect.objectContaining({ id: 42, event_type: "generation_started", payload: generationPayload })],
        null,
      ]);
    } finally {
      await db.cleanup();
    }
  });
});
