// Known difference: missing-input counts can add across dates for the same cross-midnight input.
// Known difference: the resulting ended-only evidence can also mark field partials true.
import type { UsageStatsCoverage, UsageStatsMetrics, UsageStatsOptions } from "@soulstream/wire-schema/session-statistics";
import { createSessionStatisticsMetricState, finalizeSessionStatisticsMetrics, sessionStatisticsProjectMatches,
  type SessionStatisticsMetricState, type SessionStatisticsScope } from "./session_statistics_aggregate.js";
import { addDecimal, decimalString, parseDecimal } from "./session_statistics_decimal.js";
import { buildSessionStatisticsMaterial } from "./session_statistics_material.js";
import { finalizeSessionStatisticsOptions } from "./session_statistics_options.js";
import { buildDay, buildOverview, finalizeSessionStatisticsAggregate, type SessionStatisticsView } from "./session_statistics_service.js";
import { dailySelectorKey, type DailyAggregateState, type DailyMaterial, type DailySessionState,
  type SessionStatisticsDailyState } from "./session_statistics_daily_state.js";
import type { SessionStatisticsReadResult } from "./session_statistics_types.js";

const COUNT_KEYS = ["usage_complete_events", "usage_partial_events", "terminal_missing_usage",
  "ended_input_without_usage", "missing_usage_turns", "pending_inputs", "priced_events",
  "unpriced_events", "unknown_total_token_events"] as const;
const TOKEN_FLAGS = ["total_tokens", "provider_total_tokens", "ordinary_input", "cache_read"] as const;

function knownSum(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
}

export function mergeSessionStatisticsMetricStates(read: SessionStatisticsReadResult,
  states: readonly SessionStatisticsMetricState[]): SessionStatisticsMetricState {
  const result = createSessionStatisticsMetricState(read, []);
  for (const state of states) {
    for (const key of Object.keys(result.tokens) as Array<keyof typeof result.tokens>) {
      result.tokens[key] = knownSum(result.tokens[key], state.tokens[key]);
    }
    for (const key of ["total", "cache_read", "non_cache"] as const) {
      const value = state.costs[key];
      if (value !== null) result.costs[key] = decimalString(addDecimal(
        result.costs[key] === null ? null : parseDecimal(result.costs[key]!), parseDecimal(value)));
    }
    for (const key of ["cache_read", "non_cache"] as const) result.costPartials[key] ||= state.costPartials[key];
  }
  for (const key of Object.keys(result.tokens) as Array<keyof typeof result.tokens>) {
    if (result.tokens[key] !== null && !Number.isSafeInteger(result.tokens[key])) result.tokens[key] = null;
  }
  return result;
}

function emptyCoverage(): UsageStatsCoverage {
  return { usage_complete_events: 0, usage_partial_events: 0, terminal_missing_usage: 0,
    ended_input_without_usage: 0, missing_usage_turns: 0, pending_inputs: 0, priced_events: 0,
    unpriced_events: 0, priced_total_tokens: null, unpriced_total_tokens: null,
    unknown_total_token_events: 0, unattributed_missing_usage: false,
    token_partials: { total_tokens: false, provider_total_tokens: false, ordinary_input: false, cache_read: false } };
}

/** Counts intentionally add across dates; cross-midnight identity dedup is a documented difference. */
function mergeCoverage(states: readonly DailyAggregateState[]): UsageStatsCoverage {
  const coverage = emptyCoverage();
  let evidence = false;
  for (const state of states) {
    for (const key of COUNT_KEYS) coverage[key] += state.coverage[key];
    coverage.priced_total_tokens = knownSum(coverage.priced_total_tokens, state.coverage.priced_total_tokens);
    coverage.unpriced_total_tokens = knownSum(coverage.unpriced_total_tokens, state.coverage.unpriced_total_tokens);
    coverage.unattributed_missing_usage ||= state.coverage.unattributed_missing_usage;
    if (state.tokenEvidence) {
      evidence = true;
      for (const key of TOKEN_FLAGS) coverage.token_partials[key] ||= state.coverage.token_partials[key];
    }
  }
  if (!evidence) for (const key of TOKEN_FLAGS) coverage.token_partials[key] = true;
  return coverage;
}

function mergeMaterial(read: SessionStatisticsReadResult, date: string, values: readonly DailyMaterial[]): DailyMaterial {
  const empty = buildSessionStatisticsMaterial({ ...read, rows: [] }, date);
  const parts = new Map<string, DailyMaterial["input_material"]["parts"][number]>();
  const reasons = new Set<string>();
  const coverage = empty.input_material.coverage;
  let toolCalls = 0;
  for (const value of values) {
    toolCalls += value.tool_calls;
    for (const key of Object.keys(coverage) as Array<keyof typeof coverage>) coverage[key] += value.input_material.coverage[key];
    for (const reason of value.input_material.calibration.reasons) reasons.add(reason);
    for (const part of value.input_material.parts) {
      if (part.category === "harness_internal") continue;
      const key = JSON.stringify([part.category, part.source_key, part.measurement]);
      const prior = parts.get(key);
      parts.set(key, { ...part, approximate_tokens: knownSum(prior?.approximate_tokens ?? null, part.approximate_tokens), share: null });
    }
  }
  const total = [...parts.values()].reduce<number | null>((sum, part) => knownSum(sum, part.approximate_tokens), null);
  const sorted = [...parts.values()].sort((a, b) => {
    for (const [left, right] of [[a.category, b.category], [a.source_key ?? "", b.source_key ?? ""], [a.measurement, b.measurement]]) {
      if (left !== right) return left! < right! ? -1 : 1;
    }
    return 0;
  }).map(part => ({ ...part, share: total !== null && total > 0 && part.approximate_tokens !== null ? part.approximate_tokens / total : null }));
  return { tool_calls: toolCalls, input_material: { ...empty.input_material,
    observed_approximate_tokens: total,
    parts: [...sorted, ...empty.input_material.parts], coverage,
    calibration: { ...empty.input_material.calibration, reasons: [...new Set([...empty.input_material.calibration.reasons, ...reasons])].sort() },
  } };
}

function dailyView(read: SessionStatisticsReadResult, days: readonly SessionStatisticsDailyState[]): SessionStatisticsView {
  const authorized = new Map(read.sessions.map(session => [session.sessionId, session]));
  const cells = days.filter(day => read.range.since <= day.day && day.day < read.range.effective_until)
    .flatMap(day => day.sessions.filter(cell => authorized.has(cell.sessionId)).map(cell => ({ day: day.day, cell })));
  const models: UsageStatsOptions["models"] = [];
  const projects: UsageStatsOptions["projects"] = [];
  const weights = new Map<string, number>();
  for (const { cell } of cells) {
    models.push(...cell.options);
    const session = authorized.get(cell.sessionId)!;
    if (session.projectId !== null) {
      if (cell.options.length > 0) projects.push({ project_id: session.projectId, label: session.projectLabel });
      weights.set(session.projectId, (weights.get(session.projectId) ?? 0)
        + (cell.selectors[dailySelectorKey({})]!.metrics.tokens.total_tokens ?? 0));
    }
  }
  const emptyMetric = createSessionStatisticsMetricState(read, []);
  const emptyMaterial = buildSessionStatisticsMaterial({ ...read, rows: [] }, read.range.since);
  const fallback = (cell: DailySessionState): DailyAggregateState => {
    const coverage = emptyCoverage();
    coverage.unattributed_missing_usage = cell.selectors[dailySelectorKey({})]!.coverage.unattributed_missing_usage;
    if (cell.unattributedAllFields) for (const key of TOKEN_FLAGS) coverage.token_partials[key] = true;
    return { metrics: emptyMetric, coverage, sourceCount: 0, tokenEvidence: cell.unattributedAllFields, material: emptyMaterial };
  };
  const select = (scope: SessionStatisticsScope) => {
    const respects = scope.respectQueryFilters !== false;
    const query = respects ? read.query : { provider: null, model: null, project_ids: undefined };
    const conflict = (scope.provider !== undefined && query.provider != null && scope.provider !== query.provider)
      || (scope.model !== undefined && query.model != null && scope.model.value !== query.model);
    const key = dailySelectorKey({ provider: scope.provider ?? query.provider ?? undefined,
      model: scope.model ?? (query.model == null ? undefined : { value: query.model }) });
    return cells.filter(({ day, cell }) => {
      const project = authorized.get(cell.sessionId)!.projectId;
      return (scope.date === undefined || (scope.date.length === 7 ? day.startsWith(scope.date) : day === scope.date))
        && (query.project_ids === undefined || sessionStatisticsProjectMatches(project, query.project_ids))
        && (scope.projectIds === undefined || scope.projectIds.includes(project));
    }).map(({ cell }) => conflict ? fallback(cell) : cell.selectors[key] ?? fallback(cell));
  };
  const aggregateCache = new Map<string, ReturnType<SessionStatisticsView["aggregate"]>>();
  return {
    options: finalizeSessionStatisticsOptions(models, projects, weights),
    hasUsage: cells.some(({ cell }) => cell.hasUsage),
    hasUnclassifiedUsage: cells.some(({ cell }) => cell.hasUsage && authorized.get(cell.sessionId)!.projectId === null),
    aggregate(scope) {
      const key = JSON.stringify(scope);
      let result = aggregateCache.get(key);
      if (result === undefined) {
        const selected = select(scope);
        const metrics: UsageStatsMetrics = finalizeSessionStatisticsMetrics(mergeSessionStatisticsMetricStates(read, selected.map(state => state.metrics)));
        result = finalizeSessionStatisticsAggregate(read, metrics, mergeCoverage(selected));
        aggregateCache.set(key, result);
      }
      return result;
    },
    rowCount: scope => select(scope).reduce((total, state) => total + state.sourceCount, 0),
    material: date => mergeMaterial(read, date, select({ date }).map(state => state.material)),
  };
}

export function buildDailyOverview(read: SessionStatisticsReadResult, days: readonly SessionStatisticsDailyState[]) {
  return buildOverview(read, dailyView(read, days));
}

export function buildDailyDay(read: SessionStatisticsReadResult, days: readonly SessionStatisticsDailyState[], date: string) {
  return buildDay(read, date, dailyView(read, days));
}
