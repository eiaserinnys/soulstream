import { describe, expect, it } from "vitest";
import { buildDay, buildOverview } from "../src/usage/session_statistics_service.js";
import { createSessionStatisticsDailyState } from "../src/usage/session_statistics_daily_state.js";
import { buildDailyDay, buildDailyOverview } from "../src/usage/session_statistics_daily_merge.js";
import { resolveSessionStatisticsDateSlice } from "../src/usage/session_statistics_period.js";
import type { SessionStatisticsReadResult } from "../src/usage/session_statistics_types.js";
import { fact, materialRow, missingRow, read, usageRow } from "./fixtures/session_statistics_aggregation.fixtures.js";
import { sessionStatisticsSourceKey } from "../src/usage/session_statistics_aggregate.js";

function fixture(): SessionStatisticsReadResult {
  const rows = [usageRow(), usageRow({ session_id: "s2", owner_recorded_at: "2026-10-20T01:00:00Z",
    fact: fact({ session_id: "s2", recorded_at: "2026-10-20T01:00:00Z", provider: "codex", backend: "codex", model: "sol" }),
  }), materialRow(31, "input/user", 7)];
  return read(rows, {}, new Map([
    [sessionStatisticsSourceKey("session-1", 20, "usage:aggregate"), "0.1"],
    [sessionStatisticsSourceKey("s2", 20, "usage:aggregate"), "0.2"],
  ]), [
    { sessionId: "session-1", folderId: "f1", cardFolderId: null, projectId: "p1", projectLabel: "One" },
    { sessionId: "s2", folderId: "f2", cardFolderId: null, projectId: "p2", projectLabel: "Two" },
  ]);
}

function states(source: SessionStatisticsReadResult) {
  return ["2026-10-19", "2026-10-20"].map(day => createSessionStatisticsDailyState(source, day));
}

describe("session statistics daily rollups", () => {
  it.each([{}, { provider: "claude", model: "sonnet" }, { model: "sol" },
    { project_ids: ["p1"] }, { project_ids: ["p1", "p2"] }])("matches the direct period with filter %j", query => {
    const source = fixture();
    const filtered = { ...source, query: { ...source.query, ...query } } as SessionStatisticsReadResult;
    expect(buildDailyOverview(filtered, states(source))).toEqual(buildOverview(filtered));
    expect(buildDailyDay(filtered, states(source), "2026-10-19")).toEqual(buildDay(filtered, "2026-10-19"));
  });

  it("keeps decimal sums exact, known zero, and empty-day flags neutral", () => {
    const source = fixture();
    const actual = buildDailyOverview(source, states(source));
    expect(actual.totals.metrics.reference_cost_usd).toBe(0.3);
    expect(actual.totals.coverage.token_partials.total_tokens).toBe(false);
    const zero = read([usageRow({ fact: fact({ input_total: 0, output_total: 0, total_tokens: 0 }) })], {},
      new Map([[sessionStatisticsSourceKey("session-1", 20, "usage:aggregate"), "0"]]));
    expect(buildDailyOverview(zero, states(zero)).totals.metrics.total_tokens).toBe(0);
    const unresolved = read([usageRow({ fact: fact({ input_total: 0, output_total: 0, total_tokens: 0 }) }),
      missingRow({ input_id: "other" })], {},
    new Map([[sessionStatisticsSourceKey("session-1", 20, "usage:aggregate"), "0"]]));
    expect(buildDailyOverview(unresolved, states(unresolved)).totals.metrics.total_tokens).toBe(null);
  });

  it("counts multi-model parts once in ALL and provider selectors", () => {
    const source = read([usageRow({ fact: fact({ part_key: "m:a", model: "a" }) }),
      usageRow({ fact: fact({ part_key: "m:b", model: "b" }) })], {}, new Map([
      [sessionStatisticsSourceKey("session-1", 20, "m:a"), "0.1"],
      [sessionStatisticsSourceKey("session-1", 20, "m:b"), "0.2"],
    ]));
    const result = buildDailyOverview(source, states(source));
    expect(result).toEqual(buildOverview(source));
    expect(result.totals.coverage.usage_complete_events).toBe(1);
    expect(result.by_model[0]?.coverage.priced_events).toBe(1);
  });

  it("uses current authorized sessions and project mapping", () => {
    const source = fixture();
    const current = { ...source, sessions: [{ ...source.sessions[0]!, projectId: "moved", projectLabel: "Moved" }],
      rows: source.rows.filter(row => row.session_id === "session-1") };
    expect(buildDailyOverview(current, states(source))).toEqual(buildOverview(current));
  });

  it("keeps unclassified usage and absent filtered sources consistent", () => {
    const source = fixture();
    const current = { ...source, query: { ...source.query, provider: "unknown" as const },
      sessions: source.sessions.map(session => ({ ...session, projectId: null })) };
    expect(buildDailyOverview(current, states(source))).toEqual(buildOverview(current));
  });

  it("uses a KST day slice and clamps the current day to asOf", () => {
    expect(resolveSessionStatisticsDateSlice("2026-10-19", "2026-10-20T00:00:00Z")).toEqual({
      recordedAtFrom: "2026-10-18T15:00:00.000Z", recordedAtBefore: "2026-10-19T15:00:00.000Z",
    });
    expect(resolveSessionStatisticsDateSlice("2026-10-20", "2026-10-20T00:00:00Z").recordedAtBefore)
      .toBe("2026-10-20T00:00:00.000Z");
  });
});
