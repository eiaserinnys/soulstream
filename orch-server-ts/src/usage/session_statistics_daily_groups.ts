import { emptyDailyCoverage, mergeDailyCoverage, mergeSessionStatisticsMetricStates } from "./session_statistics_daily_merge.js";
import { dailySelectorKey, type DailyGroupState, type DailyOverviewAggregateState, type DailySessionState } from "./session_statistics_daily_state.js";

export function dailyFolderPair(folderId: string | null, cardFolderId: string | null): string {
  return JSON.stringify([folderId, cardFolderId]);
}

/** Merge raw states with the same rules as request-time merging; material stays session-only. */
export function createSessionStatisticsDailyGroups(sessions: readonly DailySessionState[]): DailyGroupState[] {
  const pairs = new Map<string, DailySessionState[]>();
  for (const session of sessions) {
    const key = dailyFolderPair(session.folderId ?? null, session.cardFolderId ?? null);
    const cells = pairs.get(key) ?? [];
    cells.push(session);
    pairs.set(key, cells);
  }
  const emptyMetrics = () => mergeSessionStatisticsMetricStates({ costDecimals: new Map() }, []);
  const fallback = (cell: DailySessionState): DailyOverviewAggregateState => {
    const coverage = emptyDailyCoverage();
    coverage.unattributed_missing_usage = cell.selectors[dailySelectorKey({})]!.coverage.unattributed_missing_usage;
    if (cell.unattributedAllFields) for (const key of Object.keys(coverage.token_partials) as Array<keyof typeof coverage.token_partials>) {
      coverage.token_partials[key] = true;
    }
    return { metrics: emptyMetrics(), coverage, sourceCount: 0, tokenEvidence: cell.unattributedAllFields };
  };
  return [...pairs.values()].map(cells => {
    const selectors: DailyGroupState["selectors"] = {};
    const keys = new Set(cells.flatMap(cell => Object.keys(cell.selectors)));
    for (const key of keys) {
      const selected = cells.map(cell => cell.selectors[key] ?? fallback(cell));
      selectors[key] = {
        metrics: mergeSessionStatisticsMetricStates({ costDecimals: new Map() }, selected.map(state => state.metrics)),
        coverage: mergeDailyCoverage(selected),
        sourceCount: selected.reduce((sum, state) => sum + state.sourceCount, 0),
        tokenEvidence: selected.some(state => state.tokenEvidence),
      };
    }
    const options = new Map(cells.flatMap(cell => cell.options).map(option => [JSON.stringify([option.provider, option.model, option.backend]), option]));
    return { folderId: cells[0]!.folderId ?? null, cardFolderId: cells[0]!.cardFolderId ?? null,
      selectors, options: [...options.values()], hasUsage: cells.some(cell => cell.hasUsage),
      unattributedAllFields: cells.some(cell => cell.unattributedAllFields) };
  });
}
