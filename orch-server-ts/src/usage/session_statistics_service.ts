import type {
  UsageStatsAggregate,
  UsageStatsDayDetail,
  UsageStatsMetrics,
  UsageStatsOverview,
  UsageStatsProjectRow,
  UsageStatsProvider,
  UsageStatsProviderRow,
  UsageStatsSeriesPoint,
} from "@soulstream/wire-schema/session-statistics";
import type {
  SessionStatisticsReadRequest,
  SessionStatisticsReadResult,
  SessionStatisticsRepositoryPort,
} from "./session_statistics_types.js";
import {
  aggregateSessionStatisticsMetrics,
  selectOwnedSessionStatisticsRows,
  sessionStatisticsCompareText,
  sessionStatisticsDate,
} from "./session_statistics_aggregate.js";
import type { SessionStatisticsScope } from "./session_statistics_aggregate.js";
import {
  createSessionStatisticsCoverageIndex,
  sessionStatisticsCoverage,
} from "./session_statistics_coverage.js";
import { buildSessionStatisticsMaterial } from "./session_statistics_material.js";
import { buildSessionStatisticsOptions } from "./session_statistics_options.js";

type Read = SessionStatisticsReadResult;
type ModelTarget = {
  provider: UsageStatsProvider;
  model: string | null;
  attribution: "provider" | "model";
  backend: string;
  label: string;
  scope: SessionStatisticsScope;
};
type ProjectTarget = {
  projectId: string | null | "__other__";
  label: string;
  projectIds: readonly (string | null)[];
};

export function preserveKnownSubtotals(
  metrics: UsageStatsMetrics,
  coverage: UsageStatsAggregate["coverage"],
): UsageStatsMetrics {
  const unresolvedTokens = coverage.usage_partial_events > 0
    || coverage.missing_usage_turns > 0
    || coverage.pending_inputs > 0
    || coverage.unattributed_missing_usage;
  const zeroToken = (value: number | null): number | null =>
    value === 0 && unresolvedTokens ? null : value;
  const costMissing = unresolvedTokens || coverage.unpriced_events > 0;
  const costZeroProtected = metrics.reference_cost_usd === 0 && costMissing;
  const component = (
    value: { known_cost_usd: number | null; is_partial: boolean },
    tokenPartial: boolean,
  ): { known_cost_usd: number | null; is_partial: boolean } => ({
    known_cost_usd: costZeroProtected ? null : value.known_cost_usd,
    is_partial: value.is_partial || tokenPartial || costZeroProtected,
  });
  return {
    ...metrics,
    total_tokens: zeroToken(metrics.total_tokens),
    provider_total_tokens: zeroToken(metrics.provider_total_tokens),
    ordinary_input: zeroToken(metrics.ordinary_input),
    reference_cost_usd: costZeroProtected ? null : metrics.reference_cost_usd,
    reference_cost_breakdown: {
      cache_read: component(metrics.reference_cost_breakdown.cache_read, coverage.token_partials.cache_read),
      non_cache: component(
        metrics.reference_cost_breakdown.non_cache,
        coverage.token_partials.ordinary_input || coverage.token_partials.total_tokens,
      ),
    },
  };
}

export function finalizeSessionStatisticsAggregate(
  read: Read, metrics: UsageStatsMetrics, coverage: UsageStatsAggregate["coverage"],
): UsageStatsAggregate {
  return {
    metrics: preserveKnownSubtotals(metrics, coverage),
    coverage,
    is_partial: coverage.usage_partial_events > 0
      || coverage.missing_usage_turns > 0
      || coverage.pending_inputs > 0
      || coverage.unpriced_events > 0
      || coverage.unknown_total_token_events > 0
      || coverage.unattributed_missing_usage
      || read.collectionCoverage === "unknown"
      || read.projectionStatus.state !== "ready",
  };
}

function backendFor(
  options: UsageStatsOverview["options"],
  provider: UsageStatsProvider,
  model?: string | null,
): string {
  const backends = new Set(options.models
    .filter((option) => option.provider === provider && (model === undefined || option.model === model))
    .map((option) => option.backend));
  if (backends.size === 1) return [...backends][0]!;
  return backends.size > 1 ? "mixed" : "unknown";
}

function modelTargets(read: Read, options: UsageStatsOverview["options"]): ModelTarget[] {
  const hasModelFilter = read.query.provider != null || read.query.model != null;
  if (!hasModelFilter) {
    const providers = [...new Set(options.models.map((model) => model.provider))];
    return providers.map((provider) => ({
      provider,
      model: null,
      attribution: "provider",
      backend: backendFor(options, provider),
      label: options.providers.find((item) => item.provider === provider)?.label ?? provider,
      scope: { provider, respectQueryFilters: true },
    }));
  }

  return options.models
    .filter((option) => (read.query.provider == null || option.provider === read.query.provider)
      && (read.query.model == null || option.model === read.query.model))
    .map((option): ModelTarget => ({
      provider: option.provider,
      model: option.model,
      attribution: "model",
      backend: backendFor(options, option.provider, option.model),
      label: option.label,
      scope: { provider: option.provider, model: { value: option.model }, respectQueryFilters: true },
    }))
    .filter((target, index, targets) => targets.findIndex((other) =>
      other.provider === target.provider && other.model === target.model) === index);
}

function projectTargets(read: Read, options: UsageStatsOverview["options"], view: SessionStatisticsView): ProjectTarget[] {
  const roster = options.project_roster;
  const selectedOutside = [...new Set((read.query.project_ids ?? [])
    .filter((id) => id !== "__unclassified__" && !roster.includes(id)
      && options.projects.some((project) => project.project_id === id)))]
    .sort(sessionStatisticsCompareText);
  const outside = new Set(selectedOutside);
  const targets: ProjectTarget[] = roster.map((projectId) => ({
    projectId,
    label: options.projects.find((project) => project.project_id === projectId)?.label ?? projectId,
    projectIds: [projectId],
  }));
  targets.push(...selectedOutside.map((projectId) => ({
    projectId,
    label: options.projects.find((project) => project.project_id === projectId)!.label,
    projectIds: [projectId],
  })));

  const otherIds = options.projects.map((project) => project.project_id)
    .filter((projectId) => !roster.includes(projectId) && !outside.has(projectId));
  if (otherIds.length > 0) targets.push({ projectId: "__other__", label: "기타", projectIds: otherIds });

  const hasUnclassified = view.hasUnclassifiedUsage;
  if (hasUnclassified || read.query.project_ids?.includes("__unclassified__")) {
    targets.push({ projectId: null, label: "미분류", projectIds: [null] });
  }
  return targets;
}

function hasContent(aggregateResult: UsageStatsAggregate, rowCount: number): boolean {
  const coverage = aggregateResult.coverage;
  return rowCount > 0 || coverage.usage_complete_events > 0 || coverage.usage_partial_events > 0
    || coverage.missing_usage_turns > 0 || coverage.pending_inputs > 0
    || coverage.unattributed_missing_usage;
}

function projectRows(
  read: Read,
  view: SessionStatisticsView,
  targets: readonly ProjectTarget[],
  date?: string,
): UsageStatsProjectRow[] {
  const rows: UsageStatsProjectRow[] = [];
  for (const target of targets) {
    const scope: SessionStatisticsScope = { projectIds: target.projectIds, date };
    const result = view.aggregate(scope);
    const rowCount = view.rowCount(scope);
    if (!hasContent(result, rowCount)) continue;
    rows.push({ project_id: target.projectId, label: target.label, ...result });
  }
  return rows;
}

function providerRows(
  read: Read,
  view: SessionStatisticsView,
  targets: readonly ModelTarget[],
  date?: string,
): UsageStatsProviderRow[] {
  const rows: UsageStatsProviderRow[] = [];
  for (const target of targets) {
    const scope = { ...target.scope, date };
    const result = view.aggregate(scope);
    const rowCount = view.rowCount(scope);
    if (!hasContent(result, rowCount)) continue;
    rows.push({
      provider: target.provider,
      backend: target.backend,
      model: target.model,
      attribution: target.attribution,
      ...result,
    });
  }
  return rows;
}

function dateOnly(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function nextDay(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return dateOnly(value.getTime());
}

function nextMonth(date: string): string {
  const value = new Date(`${date.slice(0, 7)}-01T00:00:00.000Z`);
  value.setUTCMonth(value.getUTCMonth() + 1);
  return dateOnly(value.getTime());
}

function bucketStart(date: string, bucket: "day" | "month"): string {
  return bucket === "month" ? `${date.slice(0, 7)}-01` : date;
}

function bucketStarts(read: Read): string[] {
  const { since, effective_until: until, bucket } = read.range;
  if (since >= until) return [];
  const starts: string[] = [];
  for (let current = bucketStart(since, bucket); current < until;
    current = bucket === "month" ? nextMonth(current) : nextDay(current)) starts.push(current);
  return starts;
}

function series(
  read: Read,
  view: SessionStatisticsView,
  models: readonly ModelTarget[],
  projects: readonly ProjectTarget[],
): UsageStatsSeriesPoint[] {
  if (!view.hasUsage) return [];
  const buckets = bucketStarts(read);
  const result: UsageStatsSeriesPoint[] = [];
  const axes: Array<{
    scope: SessionStatisticsScope;
    point: Omit<UsageStatsSeriesPoint, "bucket_start" | "metrics">;
  }> = [];
  for (const target of models) {
    const scope = target.scope;
    if (!hasContent(view.aggregate(scope), view.rowCount(scope))) continue;
    axes.push({
      scope,
      point: target.attribution === "provider"
        ? { provider: target.provider, label: target.label }
        : { provider: target.provider, model: target.model, label: target.label },
    });
  }
  for (const target of projects) {
    const scope = { projectIds: target.projectIds };
    if (!hasContent(view.aggregate(scope), view.rowCount(scope))) continue;
    axes.push({ scope, point: { project_id: target.projectId, label: target.label } });
  }
  for (const bucket of buckets) {
    const date = read.range.bucket === "month" ? bucket.slice(0, 7) : bucket;
    for (const axis of axes) {
      result.push({
        bucket_start: bucket,
        ...axis.point,
        metrics: view.aggregate({ ...axis.scope, date }).metrics,
      });
    }
  }
  return result;
}

export function buildOverview(read: SessionStatisticsReadResult, view = directView(read)): UsageStatsOverview {
  const options = view.options;
  const models = modelTargets(read, options);
  const projects = projectTargets(read, options, view);
  return {
    schema_version: 1,
    generated_at: read.asOf,
    as_of: read.asOf,
    range: read.range,
    policies: {
      date_attribution: "recorded_terminal",
      project_attribution: "current_folder",
      price_version: "api-list-usd-2026-10-19-v1",
    },
    projection_status: read.projectionStatus,
    totals: view.aggregate({}),
    by_model: providerRows(read, view, models),
    by_project: projectRows(read, view, projects),
    series: series(read, view, models, projects),
    options,
  };
}

export function buildDay(read: SessionStatisticsReadResult, date: string, view = directView(read)): UsageStatsDayDetail {
  const options = view.options;
  return {
    schema_version: 1,
    date,
    generated_at: read.asOf,
    as_of: read.asOf,
    totals: view.aggregate({ date }),
    by_model: providerRows(read, view, modelTargets(read, options), date),
    by_project: projectRows(read, view, projectTargets(read, options, view), date),
    ...view.material(date),
  };
}

export type SessionStatisticsView = {
  options: UsageStatsOverview["options"];
  hasUsage: boolean;
  hasUnclassifiedUsage: boolean;
  aggregate(scope: SessionStatisticsScope): UsageStatsAggregate;
  rowCount(scope: SessionStatisticsScope): number;
  material(date: string): Pick<UsageStatsDayDetail, "input_material" | "tool_calls">;
};

function directView(read: Read): SessionStatisticsView {
  const index = createSessionStatisticsCoverageIndex(read);
  const rowsFor = (scope: SessionStatisticsScope) => {
    if (scope.date?.length !== 7) return selectOwnedSessionStatisticsRows(read, scope);
    return selectOwnedSessionStatisticsRows(read, { ...scope, date: undefined }).filter(row =>
      sessionStatisticsDate(row.owner_recorded_at ?? row.fact?.recorded_at ?? null)?.startsWith(scope.date!) === true);
  };
  const projects = new Map(read.sessions.map(session => [session.sessionId, session.projectId]));
  return {
    options: buildSessionStatisticsOptions(read, index),
    hasUsage: read.rows.some(row => row.row_kind === "usage"),
    hasUnclassifiedUsage: read.rows.some(row => row.row_kind === "usage" && projects.get(row.session_id) === null),
    aggregate(scope) {
      const selected = rowsFor(scope);
      return finalizeSessionStatisticsAggregate(read, aggregateSessionStatisticsMetrics(read, selected),
        sessionStatisticsCoverage(read, index, scope, selected));
    },
    rowCount: scope => rowsFor(scope).length,
    material: date => buildSessionStatisticsMaterial(read, date),
  };
}

export class SessionStatisticsService {
  constructor(
    private readonly repositoryProvider: () => Promise<SessionStatisticsRepositoryPort>,
  ) {}

  async getOverview(input: SessionStatisticsReadRequest): Promise<UsageStatsOverview> {
    const repository = await this.repositoryProvider();
    const read = await repository.read(input);
    return buildOverview(read);
  }

  async getDay(input: SessionStatisticsReadRequest & { day: string }): Promise<UsageStatsDayDetail> {
    const repository = await this.repositoryProvider();
    const read = await repository.read(input);
    return buildDay(read, input.day);
  }
}
