import { describe, expect, it } from "vitest";
import { RAW_USAGE_RECORDS, RAW_INPUT_MATERIAL, type RawInputMaterialRecord } from "./usage-stats-fixture-data";
import { aggregate, zeroCoverage, zeroMetrics } from "./usage-stats-fixture-aggregate";
import { formatUsageStatsValue, isUsageStatsTokenPartial, isUsageStatsCostPartial } from "./usage-stats-format";

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
  it("uses the same source estimates for the input total, shares and provider/project filters", () => {
    const all = buildUsageStatsDayDetail("2026-10-16", {}).input_material;
    const claude = buildUsageStatsDayDetail("2026-10-16", { provider: "claude" }).input_material;
    const kimi = buildUsageStatsDayDetail("2026-10-16", { provider: "kimi" }).input_material;
    expect(all).toMatchObject({ unit: "approximate_tokens", estimate_method: "utf16_chars_div4_ceil_v1", observed_approximate_tokens: 283000 });
    expect(claude.observed_approximate_tokens).toBe(218000);
    expect(kimi.observed_approximate_tokens).toBe(65000);
    expect(buildUsageStatsDayDetail("2026-10-16", { project_ids: ["project-web-dashboard"] }).input_material.observed_approximate_tokens).toBe(218000);
    expect(claude.parts.map(part => part.approximate_tokens)).toEqual([62500, 45000, 32500, 78000, null]);
    expect(claude.parts.slice(0, -1).every(part => part.measurement === "estimate")).toBe(true);
    expect(claude.parts[claude.parts.length - 1]).toMatchObject({ measurement: "unobserved", approximate_tokens: null, share: null });
    expect(claude.calibration).toEqual({ status: "not_comparable", sample_count: 0, factor: null, reasons: ["missing_source_token_breakdown"] });
    expect(all.parts.reduce((sum, part) => sum + (part.approximate_tokens ?? 0), 0)).toBe(283000);
    expect(all.parts.reduce((sum, part) => sum + (part.share ?? 0), 0)).toBeCloseTo(1);
    expect(all.parts.find(part => part.category === "harness_internal")).toMatchObject({ approximate_tokens: null, share: null });
    expect(RAW_INPUT_MATERIAL.every(part => part.estimate_source === "derived_chars" && part.approximate_tokens === Math.ceil(part.chars / 4))).toBe(true);
  });

  it("matches the canonical provider options and unknown collection fixture", () => {
    const overview = buildUsageStatsOverview({ period: "all", anchor: USAGE_STATS_FIXTURE_ANCHOR });
    expect(overview.options.providers.map(option => option.provider)).toEqual(USAGE_STATS_PROVIDERS);
    expect(overview.options.providers[USAGE_STATS_PROVIDERS.length - 1]).toEqual({ provider: "unknown", label: "공급자 미확인" });
    expect(buildUsageStatsOverview({ period: "all", anchor: USAGE_STATS_FIXTURE_ANCHOR, provider: "codex" }).options)
      .toEqual(overview.options);
    expect(overview.by_model.find(row => row.provider === "unknown")).toMatchObject({
      backend: "unknown", model: null, metrics: { total_tokens: null },
    });
    expect(overview.options.models.every(option => typeof option.backend === "string")).toBe(true);
    expect(overview.options.model_rosters.map(roster => roster.provider)).toEqual(USAGE_STATS_PROVIDERS);
  });

  it("prefers stored source estimates, rounds sources before summing and counts duplicates once", () => {
    const count = RAW_INPUT_MATERIAL.length;
    const source: RawInputMaterialRecord = { date: "2026-10-06", sample_id: "manifest", provider: "claude", model: "claude-opus-5.5", project_id: "project-docs", category: "user_prompt", source_key: "manifest", chars: 100, approximate_tokens: 7, estimate_source: "manifest" };
    RAW_INPUT_MATERIAL.push(source, source, { ...source, sample_id: "derived-one", source_key: "one", chars: 1, approximate_tokens: null, estimate_source: "derived_chars" }, { ...source, sample_id: "derived-two", source_key: "two", chars: 1, approximate_tokens: null, estimate_source: "derived_chars" });
    try {
      const material = buildUsageStatsDayDetail("2026-10-06", { provider: "claude" }).input_material;
      expect(material.observed_approximate_tokens).toBe(9);
      expect(material.parts.map(part => part.approximate_tokens)).toEqual([7, 1, 1, null]);
      expect(material.parts[0]).toMatchObject({ source_key: "manifest", approximate_tokens: 7, share: 7 / 9 });
      RAW_INPUT_MATERIAL.splice(count);
      RAW_INPUT_MATERIAL.push({ ...source, chars: 0, approximate_tokens: 0 });
      expect(buildUsageStatsDayDetail("2026-10-06", {}).input_material.observed_approximate_tokens).toBe(0);
      RAW_INPUT_MATERIAL.splice(count);
      expect(buildUsageStatsDayDetail("2026-10-06", {}).input_material.observed_approximate_tokens).toBeNull();
    } finally { RAW_INPUT_MATERIAL.splice(count); }
  });
  it("marks filtered positive subtotals uncertain without assigning missing counts to providers or models", () => {
    const query = { period: "week" as const, anchor: USAGE_STATS_FIXTURE_ANCHOR, provider: "claude" as const };
    const week = buildUsageStatsOverview(query);
    const friday = buildUsageStatsDayDetail("2026-10-16", { provider: "claude" });
    const model = buildUsageStatsOverview({ ...query, model: "claude-sonnet-5.5" });
    const modelDay = buildUsageStatsDayDetail("2026-10-16", { provider: "claude", model: "claude-sonnet-5.5" });
    const project = buildUsageStatsOverview({ ...query, project_ids: ["project-web-dashboard"] });
    const all = buildUsageStatsOverview({ period: "week", anchor: USAGE_STATS_FIXTURE_ANCHOR });
    const providerRow = all.by_model.find(row => row.provider === "claude")!;
    for (const aggregate of [week.totals, providerRow, ...week.by_model, ...week.by_project,
      friday.totals, ...friday.by_model, ...friday.by_project, model.totals, modelDay.totals,
      project.totals, ...project.by_project]) {
      expect(aggregate.coverage).toMatchObject({ unattributed_missing_usage: true,
        missing_usage_turns: 0, usage_partial_events: 0, unknown_total_token_events: 0 });
      expect(aggregate.is_partial).toBe(true);
      expect(isUsageStatsTokenPartial(aggregate.coverage)).toBe(true);
      expect(isUsageStatsCostPartial(aggregate.coverage)).toBe(true);
    }
    expect(formatUsageStatsValue(week.totals.metrics, week.totals.coverage, "tokens")).toBe("160만+");
    expect(formatUsageStatsValue(week.totals.metrics, week.totals.coverage, "cost")).toBe("$13.00+");
    expect(formatUsageStatsValue(friday.totals.metrics, friday.totals.coverage, "tokens")).toBe("60만+");
    expect(formatUsageStatsValue(friday.totals.metrics, friday.totals.coverage, "cost")).toBe("$3.00+");
    expect(all.totals.coverage).toMatchObject({ missing_usage_turns: 14, unattributed_missing_usage: false });
    const unfilteredProject = buildUsageStatsOverview({ period: "week", anchor: USAGE_STATS_FIXTURE_ANCHOR, project_ids: ["project-web-dashboard"] });
    expect(unfilteredProject.totals.coverage).toMatchObject({ missing_usage_turns: 4, unattributed_missing_usage: false });
  });

  it("keeps out-of-scope missing and pending-only scopes out of positive partials while preserving unknowns", () => {
    const empty = buildUsageStatsOverview({ period: "week", anchor: "2026-10-10", provider: "claude" });
    expect(empty.totals.coverage.unattributed_missing_usage).toBe(false);
    expect(formatUsageStatsValue(empty.totals.metrics, empty.totals.coverage, "tokens")).toBe("0");
    expect(formatUsageStatsValue(empty.totals.metrics, empty.totals.coverage, "cost")).toBe("$0.00");
    const pendingOnly = buildUsageStatsDayDetail("2026-10-18", { provider: "antigravity", project_ids: ["project-experiments"] });
    expect(pendingOnly.totals.coverage.unattributed_missing_usage).toBe(false);
    expect(pendingOnly.totals.is_partial).toBe(false);
    expect(formatUsageStatsValue(pendingOnly.totals.metrics, pendingOnly.totals.coverage, "tokens")).toBe("45만");
    expect(formatUsageStatsValue(pendingOnly.totals.metrics, pendingOnly.totals.coverage, "cost")).toBe("$2.00");
    const blockedZero = buildUsageStatsDayDetail("2026-10-18", { provider: "claude", project_ids: ["project-experiments"] });
    expect(blockedZero.totals.coverage.unattributed_missing_usage).toBe(false);
    expect(blockedZero.totals.metrics.total_tokens).toBeNull();
    const deepseek = buildUsageStatsOverview({ period: "week", anchor: USAGE_STATS_FIXTURE_ANCHOR, provider: "deepseek" });
    expect(deepseek.totals.coverage.unattributed_missing_usage).toBe(true);
    expect(formatUsageStatsValue(deepseek.totals.metrics, deepseek.totals.coverage, "tokens")).toBe("미기록");
    expect(formatUsageStatsValue(deepseek.totals.metrics, deepseek.totals.coverage, "cost")).toBe("미확인");
    expect(formatUsageStatsValue(deepseek.totals.metrics, deepseek.totals.coverage, "cost", true)).toBe("미기록");
  });

  it("never turns a null usage record into a collected zero", () => {
    RAW_USAGE_RECORDS.push({ date: "2026-10-06", provider: "codex", backend: "codex", model: "gpt-6-luna", project_id: "project-docs", input_total: null, cache_read: null, cache_write: null, output_total: null, reasoning_output: null, reference_cost_usd: null, cache_read_cost_usd: null, non_cache_cost_usd: null });
    try {
      expect(buildUsageStatsDayDetail("2026-10-06", { provider: "codex" }).totals.metrics.total_tokens).toBeNull();
    } finally { RAW_USAGE_RECORDS.pop(); }
  });
  it("derives cache-adjusted totals, provider totals, ordinary input, and component costs", () => {
    const all = aggregate(RAW_USAGE_RECORDS, [], [], false);
    expect(all.metrics.input_total).toBe(6_350_000);
    expect(all.metrics.cache_read).toBe(2_650_000);
    expect(all.metrics.total_tokens).toBe(6_070_000);
    expect(all.metrics.provider_total_tokens).toBe(8_720_000);
    expect(all.metrics.ordinary_input).toBe(3_700_000);
    expect(all.metrics.reference_cost_breakdown.cache_read.is_partial).toBe(true);
    expect(all.metrics.reference_cost_breakdown.non_cache.is_partial).toBe(true);
    expect(all.metrics.reference_cost_breakdown.cache_read.known_cost_usd).toBeCloseTo(0.2955, 6);
    expect(all.metrics.reference_cost_breakdown.non_cache.known_cost_usd).toBeCloseTo(35.4045, 6);
    expect(all.coverage.token_partials).toEqual({
      total_tokens: false, provider_total_tokens: false, ordinary_input: false, cache_read: false,
    });

    const day = buildUsageStatsDayDetail("2026-10-18", { provider: "antigravity", project_ids: ["project-experiments"] });
    expect(day.totals.metrics).toMatchObject({
      total_tokens: 450_000, provider_total_tokens: 600_000, ordinary_input: 250_000,
    });
    expect(day.totals.metrics.reference_cost_breakdown).toEqual({
      cache_read: { known_cost_usd: 0.015, is_partial: false },
      non_cache: { known_cost_usd: 1.985, is_partial: false },
    });

    expect(zeroMetrics().reference_cost_breakdown).toEqual({
      cache_read: { known_cost_usd: 0, is_partial: false },
      non_cache: { known_cost_usd: 0, is_partial: false },
    });
    expect(zeroCoverage().token_partials).toEqual({
      total_tokens: false, provider_total_tokens: false, ordinary_input: false, cache_read: false,
    });
  });

  it("keeps cache, non-cache, and ordinary partials independent", () => {
    const record = {
      ...RAW_USAGE_RECORDS[0],
      input_total: 100, cache_read: 60, cache_write: 0, output_total: 20, reasoning_output: 0,
      reference_cost_usd: 3, cache_read_cost_usd: 1, non_cache_cost_usd: 2,
    };
    const known = aggregate([record], [], [], false);
    expect(known.metrics).toMatchObject({
      total_tokens: 60, provider_total_tokens: 120, ordinary_input: 40,
    });
    expect(known.coverage.token_partials).toEqual({
      total_tokens: false, provider_total_tokens: false, ordinary_input: false, cache_read: false,
    });
    expect(known.metrics.reference_cost_breakdown).toEqual({
      cache_read: { known_cost_usd: 1, is_partial: false },
      non_cache: { known_cost_usd: 2, is_partial: false },
    });

    const ttlUnknown = aggregate([{ ...record, cache_write: null }], [], [], false);
    expect(ttlUnknown.metrics.ordinary_input).toBeNull();
    expect(ttlUnknown.coverage.token_partials).toEqual({
      total_tokens: false, provider_total_tokens: false, ordinary_input: true, cache_read: false,
    });
    expect(ttlUnknown.metrics.reference_cost_breakdown).toEqual({
      cache_read: { known_cost_usd: 1, is_partial: false },
      non_cache: { known_cost_usd: 2, is_partial: true },
    });
  });

  it("marks missing usage as partial while pending-only input stays unpartial", () => {
    const missing = aggregate([], [{
      id: "missing-1", date: "2026-10-06", project_id: "project-docs", terminal: true, ended: true,
    }], [], true);
    expect(missing.coverage.token_partials).toEqual({
      total_tokens: true, provider_total_tokens: true, ordinary_input: true, cache_read: true,
    });
    expect(missing.metrics.reference_cost_breakdown).toEqual({
      cache_read: { known_cost_usd: null, is_partial: true },
      non_cache: { known_cost_usd: null, is_partial: true },
    });

    const pending = aggregate([], [], [{ date: "2026-10-06", project_id: "project-docs" }], false);
    expect(pending.coverage.token_partials).toEqual({
      total_tokens: false, provider_total_tokens: false, ordinary_input: false, cache_read: false,
    });
    expect(pending.metrics.reference_cost_breakdown).toEqual({
      cache_read: { known_cost_usd: null, is_partial: false },
      non_cache: { known_cost_usd: null, is_partial: false },
    });
    expect(pending.is_partial).toBe(false);
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
    expect(overview.totals.metrics.total_tokens).toBe(4_250_000);
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
    expect(codex.totals.metrics.total_tokens).toBe(1_150_000);
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
    expect(day.totals.metrics.total_tokens).toBe(1_000_000);
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
    expect(claude.input_material.observed_approximate_tokens).toBe(218_000);
    expect(claude.input_material.coverage.complete_samples).toBe(1);
    expect(missingModel.input_material.observed_approximate_tokens).toBeNull();
    expect(missingModel.input_material.coverage.complete_samples).toBe(0);
    expect(missingModel.tool_calls).toBe(0);
    expect(missingModel.input_material.parts.map(row => row.category)).toContain("harness_internal");
    expect(mobileProject.tool_calls).toBe(0);
    expect(noInputRecord.input_material.observed_approximate_tokens).toBeNull();
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
      .toBe(250_000);

    const octoberProjects = projectPoints.filter(point => point.bucket_start === "2026-10-01");
    const octoberModels = modelPoints.filter(point => point.bucket_start === "2026-10-01");
    expect(sumKnownTokens(octoberProjects)).toBe(sumKnownTokens(octoberModels));
    expect(sumKnownTokens(projectPoints)).toBe(overview.totals.metrics.total_tokens);

    const day = buildUsageStatsDayDetail("2026-10-17", {}, roster);
    expect(day.by_project.map(row => row.project_id)).toEqual(["__other__"]);
    expect(day.by_project[0].metrics.total_tokens).toBe(250_000);
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
