import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { SessionStatisticsRepository } from "../src/usage/session_statistics_repository.js";
import { buildDailyOverview } from "../src/usage/session_statistics_daily_merge.js";
import { createSessionStatisticsDailyState } from "../src/usage/session_statistics_daily_state.js";
import type { BoardYjsSql } from "../src/board-yjs/board_yjs_sql.js";
import type { SessionStatisticsReadRequest, SessionStatisticsReadResult } from "../src/usage/session_statistics_types.js";
import { read, usageRow, fact } from "./fixtures/session_statistics_aggregation.fixtures.js";

describe("daily groups PostgreSQL membership and fallback", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: SessionStatisticsRepository;
  const input: SessionStatisticsReadRequest = { query: { period: "week", anchor: "2026-10-19" },
    asOf: "2026-10-20T00:00:00Z", timezone: "Asia/Seoul", day: null,
    access: { restricted: false, allowedFolderIds: [] },
    visibleFolders: [{ id: "f1", name: "One" }, { id: "f2", name: "Two" }] };
  beforeAll(async () => { harness = await createFullSchemaPostgresHarness(); }, 60_000);
  afterAll(async () => { await harness?.cleanup(); });
  beforeEach(async () => {
    const sql = harness.sql;
    await sql`UPDATE system_settings SET value = '{"state":"ready","normalization_version":1,"covered_since":"2026-10-01T00:00:00Z"}'::jsonb
      WHERE setting_key = 'session_statistics_projection_v1'`;
    await sql`DELETE FROM session_statistics_daily_batches`;
    await sql`DELETE FROM sessions`;
    await sql`DELETE FROM cards`;
    await sql`DELETE FROM folders`;
    await sql`INSERT INTO folders (id, name) VALUES ('f1', 'One'), ('f2', 'Two')`;
    await sql`INSERT INTO cards (id, folder_id, position_key, title) VALUES ('c', 'f2', 'a0', 'C')`;
    await sql`INSERT INTO sessions (session_id, folder_id, card_id, created_at) VALUES
      ('session-1', 'f1', null, '2026-10-19T00:00:00Z'), ('s2', null, 'c', '2026-10-19T00:00:00Z')`;
    repository = new SessionStatisticsRepository(sql as unknown as BoardYjsSql);
    const source: SessionStatisticsReadResult = read([usageRow(), usageRow({ session_id: "s2",
      fact: fact({ session_id: "s2", known_cost_usd: null }) })], {}, undefined, [
      { sessionId: "session-1", folderId: "f1", cardFolderId: null, projectId: "f1", projectLabel: "One" },
      { sessionId: "s2", folderId: null, cardFolderId: "f2", projectId: "f2", projectLabel: "Two" },
    ]);
    await repository.daily.save(createSessionStatisticsDailyState(source, "2026-10-19"), "0");
  });

  async function compare(request = input) {
    const metadata = await repository.readMetadata(request);
    const ids = metadata.sessions.map(session => session.sessionId);
    const grouped = await repository.daily.loadOverview("2026-10-19", "2026-10-20", 1, request, ids);
    const sessions = await repository.daily.load("2026-10-19", "2026-10-20", 1, ids);
    expect(buildDailyOverview(metadata, grouped)).toEqual(buildDailyOverview(metadata, sessions));
    return grouped[0]!;
  }

  it("limits groups by the session folder, including when the card folder is visible", async () => {
    const result = await compare({ ...input, access: { restricted: true, allowedFolderIds: ["f1"] },
      visibleFolders: [input.visibleFolders[0]!] });
    expect(result.groups?.map(group => group.folderId)).toEqual(["f1"]);
    expect(result.sessions).toEqual([]);
  });

  it("falls back for moved sessions and cards, then regroups without reading facts", async () => {
    await harness.sql`UPDATE sessions SET folder_id = 'f2' WHERE session_id = 'session-1'`;
    await harness.sql`UPDATE cards SET folder_id = 'f1' WHERE id = 'c'`;
    expect((await compare()).groups).toBeUndefined();
    // This single-connection harness exercises the stored-cell regroup operation
    // directly. The scheduler's advisory lock is covered by the service tests.
    expect(await repository.daily.regroupNext("2026-10-19", "2026-10-20", 1)).toBe(true);
    expect((await compare()).groups?.map(group => [group.folderId, group.cardFolderId])).toEqual([
      [null, "f1"], ["f2", null],
    ]);
    expect(await repository.daily.regroupNext("2026-10-19", "2026-10-20", 1)).toBe(false);
  });

  it("excludes deleted sessions before and after regrouping", async () => {
    await harness.sql`DELETE FROM sessions WHERE session_id = 's2'`;
    expect((await compare()).groups).toBeUndefined();
    expect(await repository.daily.regroupNext("2026-10-19", "2026-10-20", 1)).toBe(true);
    expect((await compare()).groups).toHaveLength(1);
    expect(await repository.daily.regroupNext("2026-10-19", "2026-10-20", 1)).toBe(false);
  });

  it("uses existing session cells until groups are ready and fills legacy folder keys", async () => {
    await harness.sql`DELETE FROM session_statistics_daily_groups`;
    await harness.sql`UPDATE session_statistics_daily_sessions SET folder_id = null, card_folder_id = null,
      payload = payload - 'folderId' - 'cardFolderId'`;
    expect((await compare()).groups).toBeUndefined();
    expect(await repository.daily.regroupNext("2026-10-19", "2026-10-20", 1)).toBe(true);
    expect((await compare()).groups).toHaveLength(2);
    const keys = await harness.sql`SELECT folder_id, card_folder_id FROM session_statistics_daily_sessions ORDER BY session_id`;
    expect(keys).toEqual([{ folder_id: null, card_folder_id: "f2" }, { folder_id: "f1", card_folder_id: null }]);
  });
});
