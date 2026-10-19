import { describe, expect, it } from "vitest";
import { RAW_USAGE_RECORDS } from "./usage-stats-fixture-data";

import {
  buildEmptyUsageStatsOverview,
  buildUsageStatsDayDetail,
  buildUsageStatsOverview,
  USAGE_STATS_FIXTURE_ANCHOR,
  USAGE_STATS_PROVIDERS,
} from "./usage-stats-fixtures";

function sumKnownTokens(rows: Array<{ metrics: { total_tokens: number | null } }>): number {
  let total = 0;
  for (const row of rows) total += row.metrics.total_tokens ?? 0;
  return total;
}

describe("usage statistics public fixture", () => {
  it("never turns a null usage record into a collected zero", () => {
    RAW_USAGE_RECORDS.push({ date: "2026-10-06", provider: "codex", backend: "codex", model: "gpt-6-luna", project_id: "project-docs", input_total: null, cache_read: null, cache_write: null, output_total: null, reasoning_output: null, reference_cost_usd: null });
    try {
      expect(buildUsageStatsDayDetail("2026-10-06", { provider: "codex" }).totals.metrics.total_tokens).toBeNull();
    } finally { RAW_USAGE_RECORDS.pop(); }
  });
  it("confirms zero only inside collection coverage with no scoped usage or unidentified turns", () => {
    const empty = buildUsageStatsOverview({ period: "week", anchor: "2026-10-10" });
    expect(empty.totals.metrics.total_tokens).toBe(0);
    expect(empty.totals.metrics.reference_cost_usd).toBe(0);
    expect(empty.totals.is_partial).toBe(false);
    expect(empty.series).toEqual([]);
    expect(empty.by_model.find(row => row.provider === "claude")?.metrics.total_tokens).toBe(0);
    expect(empty.by_model.find(row => row.provider === "deepseek")?.metrics.total_tokens).toBeNull();
    expect(buildUsageStatsOverview({ period: "week", anchor: "2026-10-10", provider: "deepseek" }).totals.metrics.total_tokens).toBeNull();
    expect(buildUsageStatsOverview({ period: "week", anchor: "2026-08-16" }).totals.metrics.total_tokens).toBeNull();
    expect(buildUsageStatsDayDetail("2026-10-06", { provider: "codex" }).totals.metrics.total_tokens).toBe(0);
    expect(buildUsageStatsDayDetail("2026-10-16", { provider: "codex" }).totals.metrics.total_tokens).toBeNull();
  });
  it("uses the corrected half-open KST week and never adds cache or reasoning twice", () => {
    const overview = buildUsageStatsOverview({ period: "week", anchor: USAGE_STATS_FIXTURE_ANCHOR });

    expect(overview.range).toMatchObject({
      since: "2026-10-12",
      until: "2026-10-19",
      effective_until: "2026-10-19",
      timezone: "Asia/Seoul",
      bucket: "day",
    });
    expect(overview.totals.metrics.input_total).toBe(4_550_000);
    expect(overview.totals.metrics.output_total).toBe(1_800_000);
    expect(overview.totals.metrics.total_tokens).toBe(6_350_000);
    expect(overview.totals.metrics.total_tokens).not.toBe(9_050_000);
  });

  it("keeps every provider visible while distinguishing Kimi unpriced from DeepSeek unrecorded", () => {
    const overview = buildUsageStatsOverview({ period: "week", anchor: USAGE_STATS_FIXTURE_ANCHOR });
    const providers = overview.by_model.map(row => row.provider);
    const kimi = overview.by_model.find(row => row.provider === "kimi");
    const deepseek = overview.by_model.find(row => row.provider === "deepseek");

    expect(providers).toEqual(USAGE_STATS_PROVIDERS);
    expect(kimi?.metrics.total_tokens).toBeGreaterThan(0);
    expect(kimi?.metrics.reference_cost_usd).toBeNull();
    expect(deepseek?.metrics.total_tokens).toBeNull();
    expect(deepseek?.metrics.reference_cost_usd).toBeNull();
  });

  it("deduplicates missing usage turns and excludes pending inputs", () => {
    const overview = buildUsageStatsOverview({ period: "week", anchor: USAGE_STATS_FIXTURE_ANCHOR });

    expect(overview.totals.coverage.terminal_missing_usage).toBe(10);
    expect(overview.totals.coverage.ended_input_without_usage).toBe(8);
    expect(overview.totals.coverage.missing_usage_turns).toBe(14);
    expect(overview.totals.coverage.pending_inputs).toBe(3);
  });

  it("recomputes period, provider, and project totals from the same raw records", () => {
    const overview = buildUsageStatsOverview({ period: "week", anchor: USAGE_STATS_FIXTURE_ANCHOR });
    const codex = buildUsageStatsOverview({
      period: "week",
      anchor: USAGE_STATS_FIXTURE_ANCHOR,
      provider: "codex",
    });
    const project = buildUsageStatsOverview({
      period: "week",
      anchor: USAGE_STATS_FIXTURE_ANCHOR,
      project_ids: ["project-web-dashboard"],
    });

    expect(sumKnownTokens(overview.by_model)).toBe(overview.totals.metrics.total_tokens);
    expect(sumKnownTokens(overview.by_project)).toBe(overview.totals.metrics.total_tokens);
    expect(sumKnownTokens(codex.by_model)).toBe(codex.totals.metrics.total_tokens);
    expect(sumKnownTokens(project.by_project)).toBe(project.totals.metrics.total_tokens);
    expect(project.by_project.map(row => row.project_id)).toEqual(["project-web-dashboard"]);
    expect(codex.totals.metrics.total_tokens).toBe(1_500_000);
  });

  it("uses two calendar month buckets for all time and gives day detail the same metric shape", () => {
    const overview = buildUsageStatsOverview({ period: "all", anchor: USAGE_STATS_FIXTURE_ANCHOR });
    const day = buildUsageStatsDayDetail("2026-10-16", { provider: null, model: null, project_ids: [] });

    expect(overview.range.bucket).toBe("month");
    expect([...new Set(overview.series.map(point => point.bucket_start))])
      .toEqual(["2026-09-01", "2026-10-01"]);
    expect(sumKnownTokens(overview.by_model)).toBe(overview.totals.metrics.total_tokens);
    expect(sumKnownTokens(overview.by_project)).toBe(overview.totals.metrics.total_tokens);
    expect(sumKnownTokens(overview.series.filter(point => point.provider !== undefined)))
      .toBe(overview.totals.metrics.total_tokens);
    expect(sumKnownTokens(overview.series.filter(point => point.project_id !== undefined)))
      .toBe(overview.totals.metrics.total_tokens);
    expect(day.totals.metrics).toHaveProperty("input_total");
    expect(day.totals.metrics).toHaveProperty("cache_read");
    expect(day.totals.metrics).toHaveProperty("cache_write");
    expect(day.totals.metrics).toHaveProperty("output_total");
    expect(day.totals.metrics).toHaveProperty("reasoning_output");
    expect(day.totals.coverage.priced_total_tokens).toBeGreaterThan(0);
    expect(day.totals.metrics.total_tokens).toBe(1_850_000);
    expect(day.input_material.parts.map(row => row.category)).toContain("harness_internal");
    expect(day.input_material.parts.find(row => row.category === "harness_internal")?.share).toBeNull();
    expect(day.tool_calls).toBe(312);
  });

  it("does not duplicate an unmatched model filter and filters input material by provider and model", () => {
    const unmatched = buildUsageStatsOverview({
      period: "week",
      anchor: USAGE_STATS_FIXTURE_ANCHOR,
      model: "missing-model",
    });
    const claude = buildUsageStatsDayDetail("2026-10-16", {
      provider: "claude",
      model: "claude-sonnet-5.5",
    });
    const missingModel = buildUsageStatsDayDetail("2026-10-16", {
      provider: "kimi",
      model: "claude-sonnet-5.5",
    });
    const mobileProject = buildUsageStatsDayDetail("2026-10-16", {
      project_ids: ["project-mobile-app"],
    });
    const noInputRecord = buildUsageStatsDayDetail("2026-10-15", {
      provider: null,
      model: null,
      project_ids: [],
    });

    expect(unmatched.by_model).toHaveLength(1);
    expect(unmatched.by_model[0].metrics.total_tokens).toBeNull();
    expect(claude.tool_calls).toBe(312);
    expect(claude.input_material.observed_chars).toBe(872_000);
    expect(claude.input_material.coverage.complete_samples).toBe(1);
    expect(missingModel.input_material.observed_chars).toBeNull();
    expect(missingModel.input_material.coverage.complete_samples).toBe(0);
    expect(missingModel.tool_calls).toBe(0);
    expect(missingModel.input_material.parts.map(row => row.category)).toContain("harness_internal");
    expect(mobileProject.tool_calls).toBe(0);
    expect(noInputRecord.input_material.observed_chars).toBeNull();
    expect(noInputRecord.input_material.coverage.missing_samples).toBe(1);
    expect(noInputRecord.input_material.parts.map(row => row.category)).toContain("harness_internal");

    const modelSeries = buildUsageStatsOverview({
      period: "week",
      anchor: USAGE_STATS_FIXTURE_ANCHOR,
      provider: "claude",
    });
    expect(modelSeries.series.find(point => point.model)?.label).toBe("Claude (claude-opus-5.5)");
  });

  it("uses one period project roster across month series and selected-day details", () => {
    const overview = buildUsageStatsOverview({ period: "all", anchor: USAGE_STATS_FIXTURE_ANCHOR });
    const roster = overview.by_project
      .map(row => row.project_id)
      .filter((projectId): projectId is string => projectId !== null && projectId !== "__other__");
    const projectKeys = new Set(
      overview.by_project.map(row => row.project_id ?? "__unclassified__"),
    );
    const projectPoints = overview.series.filter(point => point.project_id !== undefined);
    const modelPoints = overview.series.filter(point => point.provider !== undefined);

    expect(projectPoints.every(point => projectKeys.has(point.project_id ?? "__unclassified__"))).toBe(true);
    expect(projectPoints.find(point => point.bucket_start === "2026-10-01" && point.project_id === "__other__")?.metrics.total_tokens)
      .toBe(300_000);

    const octoberProjects = projectPoints.filter(point => point.bucket_start === "2026-10-01");
    const octoberModels = modelPoints.filter(point => point.bucket_start === "2026-10-01");
    expect(sumKnownTokens(octoberProjects)).toBe(sumKnownTokens(octoberModels));
    expect(sumKnownTokens(projectPoints)).toBe(overview.totals.metrics.total_tokens);

    const day = buildUsageStatsDayDetail("2026-10-17", {}, roster);
    expect(day.by_project.map(row => row.project_id)).toEqual(["__other__"]);
    expect(day.by_project[0].metrics.total_tokens).toBe(300_000);
  });

  it("keeps an observed zero event separate from unidentified missing turns", () => {
    const day = buildUsageStatsDayDetail("2026-10-15", { provider: "codex" });

    expect(day.totals.metrics.total_tokens).toBeNull();
    expect(day.totals.metrics.reference_cost_usd).toBeNull();
    expect(day.by_project[0].metrics.total_tokens).toBeNull();
  });

  it("represents a measured empty range with zero instead of missing values", () => {
    const empty = buildEmptyUsageStatsOverview({ period: "week", anchor: "2026-10-18" });

    expect(empty.totals.metrics.total_tokens).toBe(0);
    expect(empty.totals.metrics.reference_cost_usd).toBe(0);
    expect(empty.totals.coverage.usage_complete_events).toBe(0);
  });
});
