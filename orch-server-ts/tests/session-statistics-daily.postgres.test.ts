import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { SessionStatisticsDailyRepository } from "../src/usage/session_statistics_daily_repository.js";
import { SessionStatisticsRepository } from "../src/usage/session_statistics_repository.js";
import type { BoardYjsSql } from "../src/board-yjs/board_yjs_sql.js";
import type { SessionStatisticsReadRequest } from "../src/usage/session_statistics_types.js";
import { createSessionStatisticsDailyState } from "../src/usage/session_statistics_daily_state.js";
import { read, usageRow } from "./fixtures/session_statistics_aggregation.fixtures.js";

describe("daily statistics PostgreSQL storage", () => {
  let harness: FullSchemaPostgresHarness;
  beforeAll(async () => { harness = await createFullSchemaPostgresHarness(); }, 60_000);
  afterAll(async () => { await harness?.cleanup(); });

  it("roundtrips session states, preserves an empty marker, filters authorization, and cascades explicit deletion", async () => {
    const sql = harness.sql;
    const counts = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM sessions`;
    expect(counts[0]?.count).toBe(0);
    const repository = new SessionStatisticsDailyRepository(sql as unknown as BoardYjsSql);
    const state = createSessionStatisticsDailyState(read([usageRow()]), "2026-10-19");
    await repository.save(state, "20");
    const loaded = await repository.load("2026-10-19", "2026-10-20", 1, ["session-1"]);
    expect(loaded).toEqual([{ ...state, sourceMaxEventId: "20" }]);
    expect((await repository.load("2026-10-19", "2026-10-20", 1, []))[0]?.sessions).toEqual([]);
    await repository.save({ ...state, day: "2026-10-18", sessions: [] }, "0");
    expect((await repository.load("2026-10-18", "2026-10-19", 1))[0]?.sessions).toEqual([]);
    expect(await repository.load("2026-10-18", "2026-10-20", 2)).toEqual([]);
    await sql`DELETE FROM session_statistics_daily_batches WHERE day = '2026-10-19'`;
    expect((await sql`SELECT * FROM session_statistics_daily_sessions`).length).toBe(0);
  });

  it("reads metadata without canonical selection and resolves an internal day outside the query week", async () => {
    const sql = harness.sql;
    await sql`UPDATE system_settings SET value = '{"state":"ready","normalization_version":1,"covered_since":"2026-10-01T00:00:00Z"}'::jsonb
      WHERE setting_key = 'session_statistics_projection_v1'`;
    await sql`INSERT INTO sessions (session_id, created_at) VALUES ('daily-slice-test', '2026-10-01T00:00:00Z')`;
    const repository = new SessionStatisticsRepository(sql as unknown as BoardYjsSql);
    const input: SessionStatisticsReadRequest = { query: { period: "week", anchor: "2026-10-19" },
      asOf: "2026-10-20T00:00:00Z", timezone: "Asia/Seoul", day: null,
      access: { restricted: false, allowedFolderIds: [] }, visibleFolders: [] };
    const metadata = await repository.readMetadata(input);
    expect(metadata.sessions.map(session => session.sessionId)).toEqual(["daily-slice-test"]);
    expect(metadata.rows).toEqual([]);
    const slice = await repository.readSlice(input, "2026-10-02");
    expect(slice.range).toMatchObject({ since: "2026-10-02", effective_until: "2026-10-03" });
    expect(slice.rows).toEqual([]);
  });
});
