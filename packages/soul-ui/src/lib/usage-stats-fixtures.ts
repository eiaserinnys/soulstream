// Pure, deterministic public fixture builders for the usage statistics mockup.
import { formatUsageStatsModelLabel, formatUsageStatsProviderLabel, usageStatsBucketStarts, usageStatsRange } from "./usage-stats-format";
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
  UsageStatsOptions,
  UsageStatsPeriod,
  UsageStatsProvider,
  UsageStatsProviderRow,
  UsageStatsProjectRow,
  UsageStatsQuery,
  UsageStatsRange,
  UsageStatsSeriesPoint,
} from "./usage-stats-fixture-data";
import {
  aggregateFixtureUsage,
  aggregateMetrics,
  zeroCoverage,
  zeroMetrics,
} from "./usage-stats-fixture-aggregate";

export { USAGE_STATS_FIXTURE_ANCHOR, USAGE_STATS_PROVIDERS } from "./usage-stats-fixture-data";

export function buildUsageStatsOverview(query: UsageStatsQuery): UsageStatsOverview {
  const range = buildRange(query.period, query.anchor);
  const records = filterUsageRecords(query, range.since, range.effective_until);
  const missing = filterMissingTurns(query, range.since, range.effective_until);
  const pending = filterPendingTurns(query, range.since, range.effective_until);
  const totals = aggregateFixtureUsage(records, missing, pending, true, query, range.since, range.effective_until);
  const projectRoster = buildProjectRoster(records, query);
  const byModel = buildProviderRows(records, missing, pending, query, range.since, range.effective_until);
  const byProject = buildProjectRows(records, missing, pending, query, projectRoster, range.since, range.effective_until);
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
    series: totals.metrics.total_tokens === 0 && !totals.is_partial && !records.length ? [] : series,
    options: buildOptions(range),
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
  const totals = aggregateFixtureUsage(records, missing, pending, !filter.provider && !filter.model, filter, date, addDays(date, 1));
  const byModel = buildProviderRows(records, [], [], filter, date, addDays(date, 1));
  const byProject = buildProjectRows(records, missing, pending, filter, projectRoster, date, addDays(date, 1));
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
  return usageStatsRange(period, anchor, USAGE_STATS_FIXTURE_AS_OF, "2026-09-01");
}

function buildOptions(range: UsageStatsRange): UsageStatsOptions {
  const records: RawUsageRecord[] = [];
  for (const record of RAW_USAGE_RECORDS) if (record.date >= range.since && record.date < range.effective_until) records.push(record);
  const providers: UsageStatsOptions["providers"] = [];
  const models: UsageStatsOptions["models"] = [];
  const modelRosters: UsageStatsOptions["model_rosters"] = [];
  for (const provider of USAGE_STATS_PROVIDERS) {
    providers.push({ provider, label: formatUsageStatsProviderLabel(provider) });
    const providerModels: UsageStatsOptions["models"] = [];
    for (const record of records) {
      if (record.provider !== provider) continue;
      let exists = false;
      for (const model of providerModels) if (model.model === record.model && model.backend === record.backend) exists = true;
      if (!exists) providerModels.push({ provider, model: record.model, backend: record.backend, label: formatUsageStatsModelLabel(record.model) });
    }
    providerModels.sort((left, right) => left.model === right.model
      ? (left.backend < right.backend ? -1 : left.backend > right.backend ? 1 : 0)
      : (left.model ?? "") < (right.model ?? "") ? -1 : 1);
    const roster: Array<string | null> = [];
    for (const model of providerModels) {
      models.push(model);
      if (roster.indexOf(model.model) < 0) roster.push(model.model);
    }
    roster.sort((left, right) => left === right ? 0 : left === null ? 1 : right === null ? -1 : left < right ? -1 : 1);
    modelRosters.push({ provider, models: roster });
  }
  const projectRows = groupProjectRecords(records);
  const projects: UsageStatsOptions["projects"] = [];
  for (const row of projectRows) if (row.project_id !== null) projects.push({ project_id: row.project_id, label: row.label });
  const projectRoster: string[] = [];
  for (const project of projects) if (projectRoster.length < 5) projectRoster.push(project.project_id);
  return { providers, models, projects, project_roster: projectRoster, model_rosters: modelRosters };
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
  query: Partial<UsageStatsQuery>, since: string, until: string,
): UsageStatsProviderRow[] {
  const rows: UsageStatsProviderRow[] = [];
  if (!query.provider && !query.model) {
    for (const provider of USAGE_STATS_PROVIDERS) {
      const matching: RawUsageRecord[] = [];
      for (const record of records) if (record.provider === provider) matching.push(record);
      const value = aggregateFixtureUsage(matching, [], [], false, { provider, project_ids: query.project_ids }, since, until);
      rows.push({
        provider,
        backend: backendFor(provider),
        model: null,
        attribution: "provider",
        metrics: value.metrics, coverage: value.coverage, is_partial: value.is_partial,
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
    const value = aggregateFixtureUsage(matching, [], [], false, { provider, model, project_ids: query.project_ids }, since, until);
    rows.push({
      provider,
      backend: backendFor(provider),
      model,
      attribution: "model",
      metrics: value.metrics, coverage: value.coverage, is_partial: value.is_partial,
    });
  }
  return rows;
}

function buildProjectRows(
  records: RawUsageRecord[],
  missing: MissingTurnRecord[],
  pending: PendingTurnRecord[],
  query: Partial<UsageStatsQuery>,
  projectRoster: readonly string[] | undefined, since: string, until: string,
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
      rows.push(projectRow(group, missing, pending, query, since, until));
    } else {
      for (const record of group.records) otherRecords.push(record);
    }
  }
  if (unclassified) rows.push(projectRow(unclassified, missing, pending, query, since, until));
  if (otherRecords.length > 0) {
    const other: ProjectGroup = { project_id: "__other__", label: "기타", records: otherRecords };
    rows.push(projectRow(other, missing, pending, query, since, until));
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

function projectRow(group: ProjectGroup, missing: MissingTurnRecord[], pending: PendingTurnRecord[], query: Partial<UsageStatsQuery>, since: string, until: string): UsageStatsProjectRow {
  const matchingMissing: MissingTurnRecord[] = [];
  const matchingPending: PendingTurnRecord[] = [];
  for (const turn of missing) if (turn.project_id === group.project_id) matchingMissing.push(turn);
  for (const turn of pending) if (turn.project_id === group.project_id) matchingPending.push(turn);
  const value = aggregateFixtureUsage(group.records, matchingMissing, matchingPending, true, { provider: query.provider, model: query.model, project_ids: group.records.map(record => record.project_id ?? "__unclassified__") }, since, until);
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
  const buckets = usageStatsBucketStarts(range);
  for (const bucket of buckets) {
    const bucketRecords: RawUsageRecord[] = [];
    for (const record of records) {
      const key = range.bucket === "month" ? record.date.slice(0, 7) + "-01" : record.date;
      if (key === bucket) bucketRecords.push(record);
    }
    const until = range.bucket === "month" ? minDate(formatDate(Date.UTC(parseDate(bucket).year, parseDate(bucket).month, 1)), range.effective_until) : minDate(addDays(bucket, 1), range.effective_until);
    const modelRows = buildProviderRows(bucketRecords, [], [], query, bucket, until);
    for (const row of modelRows) {
      const point: UsageStatsSeriesPoint = {
        bucket_start: bucket,
        provider: row.provider,
        label: row.model ? `${formatUsageStatsProviderLabel(row.provider)} (${row.model})` : formatUsageStatsProviderLabel(row.provider),
        metrics: row.metrics,
      };
      if (row.model) point.model = row.model;
      series.push(point);
    }

    const projectRows = buildProjectRows(bucketRecords, missing.filter(turn => turn.date >= bucket && turn.date < until), pending.filter(turn => turn.date >= bucket && turn.date < until), query, projectRoster, bucket, until);
    for (const row of projectRows) {
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
  const samples = new Set<string>();
  const sources = new Set<string>();
  let observed = 0;
  const parts: UsageStatsInputPart[] = [];
  for (const record of records) {
    const source = `${record.sample_id}:${record.category}:${record.source_key ?? ""}`;
    if (sources.has(source)) continue;
    sources.add(source);
    samples.add(record.sample_id);
    const approximateTokens = record.approximate_tokens ?? Math.ceil(record.chars / 4);
    let part: UsageStatsInputPart | undefined;
    for (const candidate of parts) {
      if (candidate.category === record.category && candidate.source_key === record.source_key && candidate.measurement === "estimate") part = candidate;
    }
    if (!part) {
      part = { category: record.category, source_key: record.source_key, approximate_tokens: 0, share: null, measurement: "estimate" };
      parts.push(part);
    }
    part.approximate_tokens = (part.approximate_tokens ?? 0) + approximateTokens;
    observed += approximateTokens;
  }
  for (const part of parts) part.share = observed > 0 ? (part.approximate_tokens ?? 0) / observed : null;
  parts.push({ category: "harness_internal", source_key: null, approximate_tokens: null, share: null, measurement: "unobserved" });

  return {
    basis: "observed_input_material",
    unit: "approximate_tokens",
    estimate_method: "utf16_chars_div4_ceil_v1",
    method: "combined_visible",
    observed_approximate_tokens: records.length > 0 ? observed : null,
    parts,
    calibration: { status: "not_comparable", sample_count: 0, factor: null, reasons: ["missing_source_token_breakdown"] },
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
  if (provider === "unknown") return "unknown";
  return "kimi-for-coding";
}

function projectLabel(projectId: string | null): string {
  if (projectId === null) return "미분류";
  return PROJECT_LABELS[projectId] ?? projectId;
}

function valueForSort(records: RawUsageRecord[]): number {
  const value = aggregateMetrics(records).total_tokens;
  return value ?? 0;
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
