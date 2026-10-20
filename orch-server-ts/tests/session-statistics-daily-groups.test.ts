import { describe, expect, it } from "vitest";
import { createSessionStatisticsDailyGroups } from "../src/usage/session_statistics_daily_groups.js";
import { createSessionStatisticsDailyState } from "../src/usage/session_statistics_daily_state.js";
import { buildDailyOverview } from "../src/usage/session_statistics_daily_merge.js";
import { read, usageRow, fact, missingRow } from "./fixtures/session_statistics_aggregation.fixtures.js";
import type { SessionStatisticsReadResult } from "../src/usage/session_statistics_types.js";

describe("daily folder groups", () => {
  const source: SessionStatisticsReadResult = read([usageRow(), usageRow({ session_id: "s2", fact: fact({ session_id: "s2", model: "other" }) }),
    missingRow({ session_id: "s3", input_id: "unknown" })], {}, new Map([
      [JSON.stringify(["session-1", "20", "usage:aggregate"]), "0.1"],
      [JSON.stringify(["s2", "20", "usage:aggregate"]), "0.2"],
    ]), [
    { sessionId: "session-1", folderId: "f", cardFolderId: null, projectId: "p", projectLabel: "P" },
    { sessionId: "s2", folderId: "f", cardFolderId: null, projectId: "p", projectLabel: "P" },
    { sessionId: "s3", folderId: null, cardFolderId: "f", projectId: "p", projectLabel: "P" },
  ]);
  const state = createSessionStatisticsDailyState(source, "2026-10-19");

  it.each([{}, { model: "other" }, { project_ids: ["p"] }])("preserves selectors and missing evidence with filter %j", query => {
    const metadata = { ...source, query: { ...source.query, ...query } };
    const groups = createSessionStatisticsDailyGroups(state.sessions);
    expect(groups).toHaveLength(2);
    expect(JSON.stringify(groups)).not.toContain('"material"');
    expect(buildDailyOverview(metadata, [{ ...state, sessions: [], groups }]))
      .toEqual(buildDailyOverview(metadata, [state]));
  });

  it("filters restricted users through current authorized folder pairs", () => {
    const metadata = { ...source, sessions: source.sessions.filter(session => session.folderId === "f") };
    const groups = createSessionStatisticsDailyGroups(state.sessions);
    expect(buildDailyOverview(metadata, [{ ...state, sessions: [], groups }]))
      .toEqual(buildDailyOverview(metadata, [state]));
  });

  it("preserves the existing provider/model/backend option identity", () => {
    const first = state.sessions[0]!;
    const option = first.options[0]!;
    const other = { ...first, sessionId: "backend-variant", options: [{ ...option, backend: "opencode" }] };
    const groups = createSessionStatisticsDailyGroups([first, other]);
    expect(groups[0]!.options).toEqual([option, { ...option, backend: "opencode" }]);
  });
});
