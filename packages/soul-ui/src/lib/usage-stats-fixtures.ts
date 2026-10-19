// Pure, deterministic public fixture builders for the usage statistics mockup.
import {
  MISSING_TURNS,
  PENDING_TURNS,
  PROJECT_LABELS,
  RAW_INPUT_MATERIAL,
  RAW_TOOL_CALLS,
  RAW_USAGE_RECORDS,
  USAGE_STATS_FIXTURE_AS_OF,
  USAGE_STATS_PROVIDERS,
} from "./usage-stats-fixture-data";
import type {
  MissingTurnRecord,
  PendingTurnRecord,
  ProjectGroup,
  RawInputMaterialRecord,
  RawUsageRecord,
  UsageStatsDayDetail,
  UsageStatsInputMaterial,
  UsageStatsInputPart,
  UsageStatsOverview,
  UsageStatsPeriod,
  UsageStatsProvider,
  UsageStatsProviderRow,
  UsageStatsProjectRow,
  UsageStatsQuery,
  UsageStatsRange,
  UsageStatsSeriesPoint,
} from "./usage-stats-fixture-data";
import {
  aggregate,
  aggregateMetrics,
  hasUnknownPrice,
  zeroCoverage,
  zeroMetrics,
} from "./usage-stats-fixture-aggregate";

export { USAGE_STATS_FIXTURE_ANCHOR, USAGE_STATS_PROVIDERS } from "./usage-stats-fixture-data";

export function buildUsageStatsOverview(query: UsageStatsQuery): UsageStatsOverview {
  const range = buildRange(query.period, query.anchor);
  const records = filterUsageRecords(query, range.since, range.effective_until);
  const missing = filterMissingTurns(query, range.since, range.effective_until);
  const pending = filterPendingTurns(query, range.since, range.effective_until);
  const totals = aggregate(records, missing, pending, true);
  const projectRoster = buildProjectRoster(records, query);
  const byModel = buildProviderRows(records, missing, pending, query);
  const byProject = buildProjectRows(records, missing, pending, query, projectRoster);
  const series = buildSeries(query, range, records, missing, pending, projectRoster);

  return {
    schema_version: 1,
    generated_at: USAGE_STATS_FIXTURE_AS_OF,
    as_of: USAGE_STATS_FIXTURE_AS_OF,
    range,
    policies: {
      date_attribution: "recorded_terminal",
      project_attribution: "current_folder",
      price_version: "api-list-usd-2026-10-19-v1",
    },
    projection_status: { state: "ready", covered_since: "2026-09-01" },
    totals,
    by_model: byModel,
    by_project: byProject,
    series,
  };
}

export function buildEmptyUsageStatsOverview(query: UsageStatsQuery): UsageStatsOverview {
  const overview = buildUsageStatsOverview(query);
  overview.totals = {
    metrics: zeroMetrics(),
    coverage: zeroCoverage(),
    is_partial: false,
  };
  overview.by_model = [];
  overview.by_project = [];
  overview.series = [];
  return overview;
}

export function buildUsageStatsDayDetail(
  date: string,
  filter: { provider?: UsageStatsProvider | null; model?: string | null; project_ids?: readonly string[] },
  projectRoster?: readonly string[],
): UsageStatsDayDetail {
  const records: RawUsageRecord[] = [];
  for (const record of RAW_USAGE_RECORDS) {
    if (record.date !== date || !matchesProvider(record, filter.provider ?? null, filter.model ?? null)) continue;
    if (!matchesProject(record.project_id, filter.project_ids)) continue;
    records.push(record);
  }
  const missing = filterMissingTurns(filter, date, addDays(date, 1));
  const pending = filterPendingTurns(filter, date, addDays(date, 1));
  const totals = aggregate(records, missing, pending, !filter.provider && !filter.model);
  const byModel = buildProviderRows(records, [], [], filter);
  const byProject = buildProjectRows(records, missing, pending, filter, projectRoster);
  const inputMaterial = buildInputMaterial(date, filter);
  let toolCalls = 0;
  for (const call of RAW_TOOL_CALLS) {
    if (call.date !== date) continue;
    if (filter.provider && call.provider !== filter.provider) continue;
    if (filter.model && call.model !== filter.model) continue;
    if (!matchesProject(call.project_id, filter.project_ids)) continue;
    toolCalls += call.calls;
  }

  return {
    schema_version: 1,
    date,
    generated_at: USAGE_STATS_FIXTURE_AS_OF,
    as_of: USAGE_STATS_FIXTURE_AS_OF,
    totals,
    by_model: byModel,
    by_project: byProject,
    input_material: inputMaterial,
    tool_calls: toolCalls,
  };
}

function buildRange(period: UsageStatsPeriod, anchor: string): UsageStatsRange {
  const asOf = USAGE_STATS_FIXTURE_AS_OF.slice(0, 10);
  let since = "2026-09-01";
  let until = asOf;
  let bucket: "day" | "month" = "month";

  if (period === "week") {
    since = mondayOf(anchor);
    until = addDays(since, 7);
    bucket = "day";
  } else if (period === "month") {
    const parsed = parseDate(anchor);
    since = formatDate(Date.UTC(parsed.year, parsed.month - 1, 1));
    until = formatDate(Date.UTC(parsed.year, parsed.month, 1));
    bucket = "day";
  }

  const effectiveUntil = minDate(until, asOf);
  return {
    period,
    since,
    until,
    effective_until: effectiveUntil < since ? since : effectiveUntil,
    timezone: "Asia/Seoul",
    bucket,
  };
}

function filterUsageRecords(query: UsageStatsQuery, since: string, until: string): RawUsageRecord[] {
  const selected: RawUsageRecord[] = [];
  for (const record of RAW_USAGE_RECORDS) {
    if (record.date < since || record.date >= until) continue;
    if (!matchesProvider(record, query.provider ?? null, query.model ?? null)) continue;
    if (!matchesProject(record.project_id, query.project_ids)) continue;
    selected.push(record);
  }
  return selected;
}

function matchesProvider(record: RawUsageRecord, provider: UsageStatsProvider | null, model: string | null): boolean {
  if (provider && record.provider !== provider) return false;
  if (model && record.model !== model) return false;
  return true;
}

function matchesProject(projectId: string | null, projectIds?: readonly string[]): boolean {
  if (!projectIds || projectIds.length === 0) return true;
  for (const selected of projectIds) {
    if (selected === "__unclassified__" && projectId === null) return true;
    if (selected === projectId) return true;
  }
  return false;
}

function filterMissingTurns(query: { provider?: UsageStatsProvider | null; model?: string | null; project_ids?: readonly string[] }, since: string, until: string): MissingTurnRecord[] {
  const selected: MissingTurnRecord[] = [];
  if (query.provider || query.model) return selected;
  for (const turn of MISSING_TURNS) {
    if (turn.date < since || turn.date >= until) continue;
    if (!matchesProject(turn.project_id, query.project_ids)) continue;
    selected.push(turn);
  }
  return selected;
}

function filterPendingTurns(query: { provider?: UsageStatsProvider | null; model?: string | null; project_ids?: readonly string[] }, since: string, until: string): PendingTurnRecord[] {
  const selected: PendingTurnRecord[] = [];
  if (query.provider || query.model) return selected;
  for (const turn of PENDING_TURNS) {
    if (turn.date < since || turn.date >= until) continue;
    if (!matchesProject(turn.project_id, query.project_ids)) continue;
    selected.push(turn);
  }
  return selected;
}

function buildProviderRows(
  records: RawUsageRecord[],
  missing: MissingTurnRecord[],
  pending: PendingTurnRecord[],
  query: { provider?: UsageStatsProvider | null; model?: string | null },
): UsageStatsProviderRow[] {
  const rows: UsageStatsProviderRow[] = [];
  if (!query.provider && !query.model) {
    for (const provider of USAGE_STATS_PROVIDERS) {
      const matching: RawUsageRecord[] = [];
      for (const record of records) if (record.provider === provider) matching.push(record);
      rows.push({
        provider,
        backend: backendFor(provider),
        model: null,
        attribution: "provider",
        metrics: aggregateMetrics(matching),
        coverage: aggregate(matching, [], [], false).coverage,
        is_partial: matching.length === 0 || hasUnknownPrice(matching),
      });
    }
    return rows;
  }

  const modelKeys: string[] = [];
  const modelProviders: UsageStatsProvider[] = [];
  for (const record of records) {
    const key = `${record.provider}:${record.model}`;
    if (modelKeys.indexOf(key) >= 0) continue;
    modelKeys.push(key);
    modelProviders.push(record.provider);
  }
  if (query.model && modelKeys.length === 0) {
    const provider = query.provider ?? "claude";
    modelKeys.push(`${provider}:${query.model}`);
    modelProviders.push(provider);
  }
  if (modelKeys.length === 0 && query.provider) {
    modelKeys.push(`${query.provider}:`);
    modelProviders.push(query.provider);
  }

  for (let index = 0; index < modelKeys.length; index += 1) {
    const key = modelKeys[index];
    const provider = modelProviders[index];
    const model = key.slice(key.indexOf(":") + 1) || null;
    const matching: RawUsageRecord[] = [];
    for (const record of records) {
      if (record.provider === provider && record.model === model) matching.push(record);
    }
    rows.push({
      provider,
      backend: backendFor(provider),
      model,
      attribution: "model",
      metrics: aggregateMetrics(matching),
      coverage: aggregate(matching, [], [], false).coverage,
      is_partial: matching.length === 0 || hasUnknownPrice(matching),
    });
  }
  return rows;
}

function buildProjectRows(
  records: RawUsageRecord[],
  missing: MissingTurnRecord[],
  pending: PendingTurnRecord[],
  query: { project_ids?: readonly string[] },
  projectRoster?: readonly string[],
): UsageStatsProjectRow[] {
  const groups = groupProjectRecords(records);
  const roster = projectRoster ?? buildProjectRoster(records, query);
  const rows: UsageStatsProjectRow[] = [];
  const otherRecords: RawUsageRecord[] = [];
  let unclassified: ProjectGroup | undefined;
  for (const group of groups) {
    if (group.project_id === null) {
      unclassified = group;
    } else if (roster.indexOf(group.project_id) >= 0) {
      rows.push(projectRow(group, missing, pending));
    } else {
      for (const record of group.records) otherRecords.push(record);
    }
  }
  if (unclassified) rows.push(projectRow(unclassified, missing, pending));
  if (otherRecords.length > 0) {
    const other: ProjectGroup = { project_id: "__other__", label: "기타", records: otherRecords };
    rows.push(projectRow(other, missing, pending));
  }
  return rows;
}

function buildProjectRoster(records: RawUsageRecord[], query: { project_ids?: readonly string[] }): string[] {
  const groups = groupProjectRecords(records);
  const roster: string[] = [];
  const maximumNamed = query.project_ids && query.project_ids.length > 0 ? groups.length : 5;
  for (const group of groups) {
    if (group.project_id !== null) roster.push(group.project_id);
  }
  if (roster.length > maximumNamed) roster.length = maximumNamed;
  return roster;
}

function groupProjectRecords(records: RawUsageRecord[]): ProjectGroup[] {
  const groups: ProjectGroup[] = [];
  for (const record of records) {
    let group: ProjectGroup | undefined;
    for (const candidate of groups) if (candidate.project_id === record.project_id) group = candidate;
    if (!group) {
      group = { project_id: record.project_id, label: projectLabel(record.project_id), records: [] };
      groups.push(group);
    }
    group.records.push(record);
  }
  groups.sort((left, right) => valueForSort(right.records) - valueForSort(left.records));
  return groups;
}

function projectRow(group: ProjectGroup, missing: MissingTurnRecord[], pending: PendingTurnRecord[]): UsageStatsProjectRow {
  const matchingMissing: MissingTurnRecord[] = [];
  const matchingPending: PendingTurnRecord[] = [];
  for (const turn of missing) if (turn.project_id === group.project_id) matchingMissing.push(turn);
  for (const turn of pending) if (turn.project_id === group.project_id) matchingPending.push(turn);
  const value = aggregate(group.records, matchingMissing, matchingPending, true);
  return {
    project_id: group.project_id,
    label: group.label,
    metrics: value.metrics,
    coverage: value.coverage,
    is_partial: value.is_partial,
  };
}

function buildSeries(
  query: UsageStatsQuery,
  range: UsageStatsRange,
  records: RawUsageRecord[],
  missing: MissingTurnRecord[],
  pending: PendingTurnRecord[],
  projectRoster: readonly string[],
): UsageStatsSeriesPoint[] {
  const series: UsageStatsSeriesPoint[] = [];
  const buckets = bucketStarts(range);
  for (const bucket of buckets) {
    const bucketRecords: RawUsageRecord[] = [];
    for (const record of records) {
      const key = range.bucket === "month" ? record.date.slice(0, 7) + "-01" : record.date;
      if (key === bucket) bucketRecords.push(record);
    }
    const modelRows = buildProviderRows(bucketRecords, [], [], query);
    for (const row of modelRows) {
      if (row.metrics.total_tokens === null) continue;
      const point: UsageStatsSeriesPoint = {
        bucket_start: bucket,
        provider: row.provider,
        label: row.model ? `${providerLabel(row.provider)} (${row.model})` : providerLabel(row.provider),
        metrics: row.metrics,
      };
      if (row.model) point.model = row.model;
      series.push(point);
    }

    const projectRows = buildProjectRows(bucketRecords, missing, pending, query, projectRoster);
    for (const row of projectRows) {
      if (row.metrics.total_tokens === null) continue;
      const point: UsageStatsSeriesPoint = {
        bucket_start: bucket,
        project_id: row.project_id,
        label: row.label,
        metrics: row.metrics,
      };
      series.push(point);
    }
  }
  return series;
}

function bucketStarts(range: UsageStatsRange): string[] {
  const buckets: string[] = [];
  if (range.bucket === "day") {
    let cursor = range.since;
    while (cursor < range.until) {
      buckets.push(cursor);
      cursor = addDays(cursor, 1);
    }
    return buckets;
  }
  const start = parseDate(range.since);
  const end = parseDate(range.effective_until);
  let year = start.year;
  let month = start.month;
  while (year < end.year || (year === end.year && month <= end.month)) {
    buckets.push(formatDate(Date.UTC(year, month - 1, 1)));
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return buckets;
}

function filterInputRecords(
  date: string,
  filter: { provider?: UsageStatsProvider | null; model?: string | null; project_ids?: readonly string[] },
): RawInputMaterialRecord[] {
  const selected: RawInputMaterialRecord[] = [];
  for (const record of RAW_INPUT_MATERIAL) {
    if (record.date !== date) continue;
    if (filter.provider && filter.provider !== record.provider) continue;
    if (filter.model && filter.model !== record.model) continue;
    if (!matchesProject(record.project_id, filter.project_ids)) continue;
    selected.push(record);
  }
  return selected;
}

function buildInputMaterial(
  date: string,
  filter: { provider?: UsageStatsProvider | null; model?: string | null; project_ids?: readonly string[] },
): UsageStatsInputMaterial {
  const records = filterInputRecords(date, filter);
  const totals: Record<string, number> = {};
  const sourceKeys: Record<string, string | null> = {};
  const samples = new Set<string>();
  let observed = 0;
  for (const record of records) {
    samples.add(record.sample_id);
    totals[record.category] = (totals[record.category] ?? 0) + record.chars;
    sourceKeys[record.category] = record.source_key;
    observed += record.chars;
  }

  const parts: UsageStatsInputPart[] = [];
  for (const category of ["system_prompt", "soulstream_injection", "user_prompt", "tool_result"]) {
    if (totals[category] === undefined) continue;
    parts.push({
      category,
      source_key: sourceKeys[category] ?? null,
      chars: totals[category],
      share: observed > 0 ? totals[category] / observed : null,
    });
  }
  parts.push({ category: "harness_internal", source_key: null, chars: null, share: null });

  return {
    basis: "observed_input_material",
    unit: "chars_utf16",
    method: "combined_visible",
    observed_chars: records.length > 0 ? observed : null,
    parts,
    coverage: {
      complete_samples: samples.size,
      partial_samples: 0,
      manifest_only_samples: 0,
      missing_samples: records.length > 0 ? 0 : 1,
    },
  };
}

function backendFor(provider: UsageStatsProvider): string {
  if (provider === "claude") return "claude-code";
  if (provider === "codex") return "codex";
  if (provider === "antigravity") return "antigravity";
  if (provider === "deepseek") return "opencode";
  return "kimi-for-coding";
}

function providerLabel(provider: UsageStatsProvider): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "antigravity") return "Antigravity";
  if (provider === "deepseek") return "DeepSeek";
  return "Kimi";
}

function projectLabel(projectId: string | null): string {
  if (projectId === null) return "미분류";
  return PROJECT_LABELS[projectId] ?? projectId;
}

function valueForSort(records: RawUsageRecord[]): number {
  const value = aggregateMetrics(records).total_tokens;
  return value ?? 0;
}

function mondayOf(date: string): string {
  const parsed = parseDate(date);
  const weekday = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  const daysFromMonday = (weekday + 6) % 7;
  return addDays(date, -daysFromMonday);
}

function minDate(left: string, right: string): string {
  return left < right ? left : right;
}

function addDays(date: string, amount: number): string {
  const parsed = parseDate(date);
  return formatDate(Date.UTC(parsed.year, parsed.month - 1, parsed.day + amount));
}

function parseDate(value: string): { year: number; month: number; day: number } {
  const parts = value.split("-");
  return { year: Number(parts[0]), month: Number(parts[1]), day: Number(parts[2]) };
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
