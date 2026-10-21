/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usageStatsFilterKey } from "@seosoyoung/soul-ui";
import type { UsageStatsAggregate, UsageStatsDayDetail, UsageStatsMetrics, UsageStatsOverview } from "@seosoyoung/soul-ui";
import { UsageStatsTab } from "./UsageStatsTab";
import { ALL_USAGE_STATS_FILTER, useUsageStats, type UsageStatsFilter } from "./useUsageStats";

let root: Root;
const request = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { supports: () => false });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-19T16:00:00.000Z"));
  request.mockReset();
  request.mockImplementation(() => new Promise<Response>(() => undefined));
  root = createRoot(document.body.appendChild(document.createElement("div")));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("starts with the current Korea calendar date and makes one overview request", async () => {
  await act(async () => root.render(<UsageStatsTab request={request} />));

  expect(request).toHaveBeenCalledTimes(1);
  const [input] = request.mock.calls[0]!;
  const query = new URL(String(input), "https://soulstream.test").searchParams;
  expect(query.get("period")).toBe("week");
  expect(query.get("anchor")).toBe("2026-10-20");
  expect(query.get("timezone")).toBe("Asia/Seoul");
  expect(document.querySelectorAll("[data-bucket-index]")).toHaveLength(0);
  const summary = document.querySelector(".usage-stats-summary");
  expect(summary).not.toBeNull();
  const [tokenMetric, costMetric] = summary?.querySelectorAll(".usage-stats-summary-metric") ?? [];
  expect(tokenMetric?.lastElementChild?.textContent).toBe("캐시 읽기 제외");
  expect(costMetric?.lastElementChild?.textContent).toBe("캐시 읽기 포함");
  expect(summary?.querySelector(".usage-stats-share-list")).toBeNull();
  expect(summary?.querySelectorAll("details")).toHaveLength(0);
  expect(summary?.textContent).not.toContain("비캐시");
  expect(summary?.textContent).not.toContain("토큰 상세");
  expect(summary?.textContent).not.toContain("집계 기준");
});

function aggregate(totalTokens: number | null): UsageStatsAggregate {
  const metrics: UsageStatsMetrics = {
    input_total: null,
    cache_read: null,
    cache_write: null,
    output_total: null,
    reasoning_output: null,
    total_tokens: totalTokens,
    provider_total_tokens: totalTokens,
    ordinary_input: null,
    reference_cost_usd: null,
    reference_cost_breakdown: {
      cache_read: { known_cost_usd: null, is_partial: false },
      non_cache: { known_cost_usd: null, is_partial: false },
    },
  };
  return {
    metrics,
    coverage: {
      usage_complete_events: totalTokens === null || totalTokens === 0 ? 0 : 1,
      usage_partial_events: 0,
      terminal_missing_usage: 0,
      ended_input_without_usage: 0,
      missing_usage_turns: 0,
      pending_inputs: 0,
      priced_events: 0,
      unpriced_events: 0,
      priced_total_tokens: null,
      unpriced_total_tokens: null,
      unknown_total_token_events: 0,
      unattributed_missing_usage: false,
      token_partials: {
        total_tokens: false,
        provider_total_tokens: false,
        ordinary_input: false,
        cache_read: false,
      },
    },
    is_partial: false,
  };
}

function cacheSplitAggregate(
  metricOverrides: Partial<UsageStatsMetrics> = {},
  coverageOverrides: Partial<UsageStatsAggregate["coverage"]> = {},
): UsageStatsAggregate {
  const totalTokens = metricOverrides.total_tokens === undefined ? 100 : metricOverrides.total_tokens;
  const zero = totalTokens === 0;
  const base = aggregate(totalTokens);
  return {
    ...base,
    metrics: {
      ...base.metrics,
      input_total: zero ? 0 : 110,
      cache_read: zero ? 0 : 60,
      cache_write: zero ? 0 : 10,
      output_total: zero ? 0 : 50,
      provider_total_tokens: zero ? 0 : 160,
      ordinary_input: zero ? 0 : 40,
      reference_cost_usd: zero ? 0 : 123.45,
      reference_cost_breakdown: zero ? {
        cache_read: { known_cost_usd: 0, is_partial: false },
        non_cache: { known_cost_usd: 0, is_partial: false },
      } : {
        cache_read: { known_cost_usd: 45, is_partial: false },
        non_cache: { known_cost_usd: 78.45, is_partial: false },
      },
      ...metricOverrides,
    },
    coverage: {
      ...base.coverage,
      priced_total_tokens: zero ? 0 : 80,
      ...coverageOverrides,
    },
  };
}

function chartAggregate(
  totalTokens: number,
  providerTokens: number,
  totalCost: number,
  nonCacheCost: number,
  cacheReadCost: number,
): UsageStatsAggregate {
  return cacheSplitAggregate({
    total_tokens: totalTokens,
    provider_total_tokens: providerTokens,
    reference_cost_usd: totalCost,
    reference_cost_breakdown: {
      non_cache: { known_cost_usd: nonCacheCost, is_partial: false },
      cache_read: { known_cost_usd: cacheReadCost, is_partial: false },
    },
  });
}

function overview(
  totalTokens: number | null,
  options: Partial<UsageStatsOverview["options"]> = {},
  totals: UsageStatsAggregate = aggregate(totalTokens),
): UsageStatsOverview {
  return {
    schema_version: 1,
    generated_at: "2026-10-20T03:00:00.000Z",
    as_of: "2026-10-20T03:00:00.000Z",
    range: {
      period: "week",
      since: "2026-10-19",
      until: "2026-10-26",
      effective_until: "2026-10-21",
      timezone: "Asia/Seoul",
      bucket: "day",
    },
    policies: {
      date_attribution: "recorded_terminal",
      project_attribution: "current_folder",
      price_version: "api-list-usd-2026-10-19-v1",
    },
    projection_status: { state: "ready", covered_since: "2026-10-01" },
    totals,
    by_model: [],
    by_project: [],
    series: [],
    options: {
      providers: [{ provider: "unknown", label: "공급자 미확인" }],
      models: [{ provider: "unknown", model: "vendor/team:model:v2", backend: "custom", label: "원문 모델" }],
      projects: [],
      project_roster: [],
      model_rosters: [{ provider: "unknown", models: ["vendor/team:model:v2"] }],
      ...options,
    },
  };
}

it("shows the cache split and uses provider tokens for the coverage denominator", async () => {
  request.mockResolvedValue(jsonResponse(overview(100, {}, cacheSplitAggregate())));

  await act(async () => root.render(<UsageStatsTab request={request} />));

  const summary = document.querySelector(".usage-stats-summary")!;
  const [tokenMetric, costMetric] = summary.querySelectorAll(".usage-stats-summary-metric");
  expect(tokenMetric.lastElementChild?.textContent).toBe("캐시 읽기 60 제외");
  expect(costMetric?.lastElementChild?.textContent).toBe("캐시 읽기 $45.00 포함");
  expect(summary.querySelector(".usage-stats-share-list")).toBeNull();
  expect(summary.querySelectorAll("details")).toHaveLength(0);
  expect(summary.textContent).not.toContain("비캐시");
  expect(summary.textContent).not.toContain("토큰 상세");
  expect(summary.textContent).not.toContain("집계 기준");
  expect(summary.textContent).toContain("기록 토큰 50% 환산");
});

it("switches only graph and comparison values between cache-excluded and included metrics", async () => {
  const first = chartAggregate(100, 160, 4, 2, 2);
  const second = chartAggregate(100, 240, 8, 3, 5);
  const totals = chartAggregate(200, 400, 12, 5, 7);
  const data = overview(200, {
    providers: [
      { provider: "claude", label: "Claude" },
      { provider: "codex", label: "Codex" },
    ],
    projects: [
      { project_id: "project-one", label: "Project One" },
      { project_id: "project-two", label: "Project Two" },
    ],
    project_roster: ["project-one", "project-two"],
  }, totals);
  data.by_model = [
    { provider: "claude", backend: "claude", model: null, attribution: "provider", ...first },
    { provider: "codex", backend: "codex", model: null, attribution: "provider", ...second },
  ];
  data.by_project = [
    { project_id: "project-one", label: "Project One", ...first },
    { project_id: "project-two", label: "Project Two", ...second },
  ];
  data.series = [
    { bucket_start: "2026-10-19", provider: "claude", model: null, label: "Claude", metrics: first.metrics },
    { bucket_start: "2026-10-19", provider: "codex", model: null, label: "Codex", metrics: second.metrics },
    { bucket_start: "2026-10-19", project_id: "project-one", label: "Project One", metrics: first.metrics },
    { bucket_start: "2026-10-19", project_id: "project-two", label: "Project Two", metrics: second.metrics },
  ];
  request.mockResolvedValue(jsonResponse(data));

  await act(async () => root.render(<UsageStatsTab request={request} />));

  const summary = document.querySelector(".usage-stats-summary")!;
  const summaryBefore = summary.textContent;
  expect(summary.querySelectorAll(".usage-stats-summary-metric")[1]?.textContent).toContain("$12.00");
  const comparisonList = () => [...document.querySelectorAll(".usage-stats-share-list")]
    .find(list => list.textContent?.includes("Claude"))!;
  const comparisonValues = () => [...comparisonList().querySelectorAll(".usage-stats-share-row")]
    .map(row => row.querySelector(".usage-stats-share-value")?.textContent);
  const comparisonShares = () => [...comparisonList().querySelectorAll(".usage-stats-share-row")]
    .map(row => row.querySelector(".usage-stats-share-percent")?.textContent);
  const chartAxis = () => document.querySelector(".usage-stats-axis-label")?.textContent;

  expect(cacheToggle("캐시 제외").getAttribute("aria-pressed")).toBe("true");
  expect(cacheToggle("캐시 포함").getAttribute("aria-pressed")).toBe("false");
  expect(chartAxis()).toBe("200");
  expect(comparisonValues()).toEqual(["100", "100"]);
  expect(comparisonShares()).toEqual(["50%", "50%"]);

  await act(async () => cacheToggle("캐시 포함").click());
  expect(request).toHaveBeenCalledTimes(1);
  expect(cacheToggle("캐시 포함").getAttribute("aria-pressed")).toBe("true");
  expect(chartAxis()).toBe("400");
  expect(comparisonValues()).toEqual(["160", "240"]);
  expect(comparisonShares()).toEqual(["40%", "60%"]);
  expect(summary.textContent).toBe(summaryBefore);

  const costButton = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="표시 값"] button')]
    .find(button => button.textContent?.trim() === "정가")!;
  await act(async () => costButton.click());
  expect(request).toHaveBeenCalledTimes(1);
  expect(cacheToggle("캐시 포함").getAttribute("aria-pressed")).toBe("true");
  expect(chartAxis()).toBe("$12.00");
  expect(comparisonValues()).toEqual(["$4.00", "$8.00"]);
  expect(comparisonShares()).toEqual(["33%", "67%"]);
  expect(summary.textContent).toBe(summaryBefore);

  await act(async () => cacheToggle("캐시 제외").click());
  expect(chartAxis()).toBe("$5.00");
  expect(comparisonValues()).toEqual(["$2.00", "$3.00"]);
  expect(comparisonShares()).toEqual(["40%", "60%"]);
  await act(async () => cacheToggle("캐시 포함").click());
  await chooseTabOption("그래프 보기", "프로젝트별");
  expect(request).toHaveBeenCalledTimes(1);
  expect(cacheToggle("캐시 포함").getAttribute("aria-pressed")).toBe("true");
  expect(chartAxis()).toBe("$12.00");
  const projectList = [...document.querySelectorAll(".usage-stats-share-list")]
    .find(list => list.textContent?.includes("Project One"))!;
  expect([...projectList.querySelectorAll(".usage-stats-share-value")].map(value => value.textContent))
    .toEqual(["$4.00", "$8.00"]);
  expect([...projectList.querySelectorAll(".usage-stats-share-percent")].map(value => value.textContent))
    .toEqual(["33%", "67%"]);
  expect(summary.textContent).toBe(summaryBefore);
});

it("marks partial cache split values and coverage", async () => {
  const totals = cacheSplitAggregate({
    reference_cost_breakdown: {
      cache_read: { known_cost_usd: 45, is_partial: true },
      non_cache: { known_cost_usd: 78.45, is_partial: true },
    },
  }, {
    usage_partial_events: 1,
    unpriced_events: 1,
    priced_total_tokens: 50,
    token_partials: {
      total_tokens: true,
      provider_total_tokens: true,
      ordinary_input: true,
      cache_read: true,
    },
  });
  request.mockResolvedValue(jsonResponse(overview(100, {}, totals)));

  await act(async () => root.render(<UsageStatsTab request={request} />));

  const summary = document.querySelector(".usage-stats-summary")!;
  expect(summary.querySelectorAll(".usage-stats-summary-metric")[0]?.lastElementChild?.textContent).toBe("캐시 읽기 60+ 제외");
  expect(summary.querySelectorAll(".usage-stats-summary-metric")[1]?.lastElementChild?.textContent).toBe("캐시 읽기 $45.00+ 포함");
  expect(summary.querySelector(".usage-stats-share-list")).toBeNull();
  expect(summary.textContent).toContain("일부만 환산");
});

function dayDetail(totalTokens: number): UsageStatsDayDetail {
  return {
    schema_version: 1,
    date: "2026-10-20",
    generated_at: "2026-10-20T03:00:00.000Z",
    as_of: "2026-10-20T03:00:00.000Z",
    totals: aggregate(totalTokens),
    by_model: [],
    by_project: [],
    input_material: {
      basis: "observed_input_material",
      unit: "approximate_tokens",
      estimate_method: "utf16_chars_div4_ceil_v1",
      method: "combined_visible",
      observed_approximate_tokens: 20,
      parts: [
        { category: "system_prompt", source_key: "system", approximate_tokens: 12, share: 0.6, measurement: "reported" },
        { category: "harness_internal", source_key: null, approximate_tokens: null, share: null, measurement: "unobserved" },
      ],
      calibration: { status: "not_comparable", sample_count: 0, factor: null, reasons: [] },
      coverage: { complete_samples: 0, partial_samples: 0, manifest_only_samples: 0, missing_samples: 0 },
    },
    tool_calls: 0,
  };
}

function jsonResponse<T>(value: T): Response {
  return { status: 200, ok: true, json: async () => value } as Response;
}

function forbiddenResponse(): Response {
  return { status: 403, ok: false, json: async () => ({ error: "controlled forbidden" }) } as Response;
}

function selectTrigger(label: string): HTMLButtonElement {
  const trigger = [...document.querySelectorAll<HTMLButtonElement>('button[role="combobox"]')]
    .find(candidate => candidate.getAttribute("aria-label") === label);
  if (!trigger) throw new Error(`Could not find the ${label} selection field.`);
  return trigger;
}

function cacheToggle(label: "캐시 제외" | "캐시 포함"): HTMLButtonElement {
  const group = document.querySelector<HTMLElement>('[role="group"][aria-label="캐시 읽기"]');
  const button = [...(group?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find(candidate => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Could not find the ${label} graph setting.`);
  return button;
}

function activeSelectItems(field: string): HTMLElement[] {
  const listboxId = selectTrigger(field).getAttribute("aria-controls");
  if (!listboxId) throw new Error(`The ${field} selection field has no active listbox control.`);
  const listbox = document.getElementById(listboxId);
  if (!listbox || listbox.getAttribute("role") !== "listbox") {
    throw new Error(`The ${field} selection field does not point to an active listbox.`);
  }
  return [...listbox.querySelectorAll<HTMLElement>('[data-slot="select-item"]')];
}

function activeSelectOptionLabels(field: string): string[] {
  return activeSelectItems(field).map(option => option.textContent?.trim() ?? "");
}

async function chooseTabOption(field: string, label: string): Promise<void> {
  await act(async () => selectTrigger(field).click());
  const option = activeSelectItems(field).find(candidate => candidate.textContent?.trim() === label);
  if (!option) throw new Error(`Could not find the ${label} option in the ${field} field.`);
  await act(async () => option.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
  await act(async () => option.click());
}

function optionsOverview(totalTokens: number, overrides: Partial<UsageStatsOverview["options"]> = {}): UsageStatsOverview {
  return overview(totalTokens, {
    models: [
      { provider: "unknown", model: "vendor/team:model:v2", backend: "custom", label: "원문 모델" },
      { provider: "unknown", model: "old-unselected-model", backend: "custom", label: "이전 모델" },
    ],
    projects: [
      { project_id: "folder-current", label: "현재 프로젝트" },
      { project_id: "folder-old", label: "이전 프로젝트" },
    ],
    project_roster: ["folder-current", "folder-old"],
    model_rosters: [{ provider: "unknown", models: ["vendor/team:model:v2", "old-unselected-model"] }],
    ...overrides,
  });
}

function withChartData(data: UsageStatsOverview, model: string, totalTokens: number): UsageStatsOverview {
  const row = {
    provider: "unknown" as const,
    backend: "custom",
    model,
    attribution: "model" as const,
    ...aggregate(totalTokens),
  };
  return {
    ...data,
    by_model: [row],
    series: [
      { bucket_start: "2026-10-19", provider: "unknown", model, label: model, metrics: aggregate(totalTokens).metrics },
      { bucket_start: "2026-10-20", provider: "unknown", model, label: model, metrics: aggregate(totalTokens).metrics },
    ],
  };
}

function responseQuery(index: number): URLSearchParams {
  const input = request.mock.calls[index]?.[0];
  if (!input) throw new Error(`Request ${index + 1} was not sent.`);
  return new URL(String(input), "https://soulstream.test").searchParams;
}

function UsageStatsRequestProbe() {
  const [filter, setFilter] = useState<UsageStatsFilter>(ALL_USAGE_STATS_FILTER);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const result = useUsageStats({
    request,
    period: "week",
    anchor: "2026-10-20",
    filter,
    projectId: null,
    selectedDate,
  });
  const selectRawModel = () => {
    setSelectedDate(null);
    setFilter({
      kind: "model",
      id: usageStatsFilterKey("model", "unknown", "vendor/team:model:v2"),
      label: "공급자 미확인 · 원문 모델",
      provider: "unknown",
      model: "vendor/team:model:v2",
    });
  };
  return <>
    <button type="button" id="select-date" onClick={() => setSelectedDate("2026-10-20")}>날짜</button>
    <button type="button" id="select-model" onClick={selectRawModel}>모델</button>
    <output data-testid="overview">{result.overview?.totals.metrics.total_tokens ?? "none"}</output>
    <output data-testid="detail">{result.detail?.totals.metrics.total_tokens ?? "none"}</output>
    <output data-testid="state">{result.state}</output>
  </>;
}

it("keeps raw model identity in requests and hides an obsolete day response after scope changes", async () => {
  let resolveOldDay: ((response: Response) => void) | undefined;
  let resolveFilteredOverview: ((response: Response) => void) | undefined;
  request.mockImplementation(input => {
    const url = new URL(String(input), "https://soulstream.test");
    const model = url.searchParams.get("model");
    if (url.pathname.endsWith("/days/2026-10-20")) {
      if (model) return Promise.resolve(jsonResponse(dayDetail(30)));
      return new Promise<Response>(resolve => { resolveOldDay = resolve; });
    }
    if (model) return new Promise<Response>(resolve => { resolveFilteredOverview = resolve; });
    return Promise.resolve(jsonResponse(overview(10)));
  });

  await act(async () => root.render(<UsageStatsRequestProbe />));
  expect(document.querySelector('[data-testid="overview"]')?.textContent).toBe("10");
  expect(request).toHaveBeenCalledTimes(1);

  await act(async () => document.querySelector<HTMLButtonElement>("#select-date")!.click());
  expect(request).toHaveBeenCalledTimes(2);
  const dayUrl = new URL(String(request.mock.calls[1]![0]), "https://soulstream.test");
  expect(dayUrl.pathname).toBe("/api/session-statistics/days/2026-10-20");
  expect(dayUrl.searchParams.get("anchor")).toBe("2026-10-20");
  expect(dayUrl.searchParams.get("timezone")).toBe("Asia/Seoul");

  await act(async () => document.querySelector<HTMLButtonElement>("#select-model")!.click());
  expect(request).toHaveBeenCalledTimes(3);
  expect(document.querySelector('[data-testid="overview"]')?.textContent).toBe("none");
  expect(document.querySelector('[data-testid="detail"]')?.textContent).toBe("none");
  const filteredUrl = new URL(String(request.mock.calls[2]![0]), "https://soulstream.test");
  expect(filteredUrl.searchParams.get("provider")).toBe("unknown");
  expect(filteredUrl.searchParams.get("model")).toBe("vendor/team:model:v2");
  expect(filteredUrl.searchParams.has("project_roster")).toBe(false);

  if (!resolveOldDay || !resolveFilteredOverview) throw new Error("Deferred request handlers were not registered.");
  await act(async () => {
    resolveOldDay!(jsonResponse(dayDetail(999)));
    await Promise.resolve();
  });
  expect(document.querySelector('[data-testid="detail"]')?.textContent).toBe("none");

  await act(async () => {
    resolveFilteredOverview!(jsonResponse(overview(20)));
    await Promise.resolve();
  });
  expect(document.querySelector('[data-testid="overview"]')?.textContent).toBe("20");

  await act(async () => document.querySelector<HTMLButtonElement>("#select-date")!.click());
  expect(request).toHaveBeenCalledTimes(4);
  const filteredDayUrl = new URL(String(request.mock.calls[3]![0]), "https://soulstream.test");
  expect(filteredDayUrl.searchParams.get("provider")).toBe("unknown");
  expect(filteredDayUrl.searchParams.get("model")).toBe("vendor/team:model:v2");
  expect(document.querySelector('[data-testid="detail"]')?.textContent).toBe("30");
});

it("keeps real model and project selections through pending requests and replaces only stale catalog options", async () => {
  let resolveFilteredOverview: ((response: Response) => void) | undefined;
  let resolveProjectOverview: ((response: Response) => void) | undefined;
  let resolveMonthOverview: ((response: Response) => void) | undefined;
  const serverMonth = withChartData(overview(60, {
    models: [{ provider: "unknown", model: "server-month-model", backend: "custom", label: "새 기간 모델" }],
    projects: [{ project_id: "folder-new", label: "새 기간 프로젝트" }],
    project_roster: ["folder-new"],
    model_rosters: [{ provider: "unknown", models: ["server-month-model"] }],
  }), "server-month-model", 60);
  serverMonth.range = { ...serverMonth.range, period: "month", since: "2026-10-01", until: "2026-11-01", bucket: "day" };
  request.mockImplementation((input) => {
    const url = new URL(String(input), "https://soulstream.test");
    if (url.pathname.endsWith("/days/2026-10-20")) return Promise.resolve(jsonResponse(dayDetail(20)));
    const count = request.mock.calls.length;
    if (count === 1) return Promise.resolve(jsonResponse(optionsOverview(10)));
    if (count === 2) return new Promise<Response>(resolve => { resolveFilteredOverview = resolve; });
    if (count === 3) return new Promise<Response>(resolve => { resolveProjectOverview = resolve; });
    if (count === 4) return new Promise<Response>(resolve => { resolveMonthOverview = resolve; });
    return Promise.resolve(jsonResponse(url.searchParams.get("period") === "month" ? serverMonth : optionsOverview(20)));
  });

  await act(async () => root.render(<UsageStatsTab request={request} />));
  await act(async () => cacheToggle("캐시 포함").click());
  expect(cacheToggle("캐시 포함").getAttribute("aria-pressed")).toBe("true");
  await chooseTabOption("모델", "공급자 미확인 · 원문 모델");
  expect(request).toHaveBeenCalledTimes(2);
  expect(cacheToggle("캐시 포함").getAttribute("aria-pressed")).toBe("true");
  expect(responseQuery(1).get("provider")).toBe("unknown");
  expect(responseQuery(1).get("model")).toBe("vendor/team:model:v2");
  expect(selectTrigger("모델").textContent).toContain("원문 모델");
  await act(async () => selectTrigger("모델").click());
  const pendingModelOptions = activeSelectOptionLabels("모델");
  expect(pendingModelOptions.filter(option => option === "모든 모델")).toHaveLength(1);
  expect(pendingModelOptions.filter(option => option === "공급자 미확인 · 원문 모델")).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => selectTrigger("모델").click());

  if (!resolveFilteredOverview) throw new Error("The filtered overview request was not registered.");
  await act(async () => { resolveFilteredOverview!(jsonResponse(optionsOverview(20))); await Promise.resolve(); });
  await chooseTabOption("프로젝트", "현재 프로젝트");
  expect(request).toHaveBeenCalledTimes(3);
  expect(cacheToggle("캐시 포함").getAttribute("aria-pressed")).toBe("true");
  expect(responseQuery(2).get("provider")).toBe("unknown");
  expect(responseQuery(2).get("model")).toBe("vendor/team:model:v2");
  expect(responseQuery(2).get("project_ids")).toBe("folder-current");
  expect(selectTrigger("프로젝트").textContent).toContain("현재 프로젝트");

  if (!resolveProjectOverview) throw new Error("The project overview request was not registered.");
  await act(async () => { resolveProjectOverview!(jsonResponse(optionsOverview(30))); await Promise.resolve(); });
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "월간")!.click());
  expect(request).toHaveBeenCalledTimes(4);
  expect(cacheToggle("캐시 포함").getAttribute("aria-pressed")).toBe("true");
  expect(responseQuery(3).get("period")).toBe("month");
  expect(responseQuery(3).get("provider")).toBe("unknown");
  expect(responseQuery(3).get("model")).toBe("vendor/team:model:v2");
  expect(responseQuery(3).get("project_ids")).toBe("folder-current");
  expect(selectTrigger("모델").textContent).toContain("원문 모델");
  expect(selectTrigger("프로젝트").textContent).toContain("현재 프로젝트");
  expect(request).toHaveBeenCalledTimes(4);

  if (!resolveMonthOverview) throw new Error("The month overview request was not registered.");
  await act(async () => { resolveMonthOverview!(jsonResponse(serverMonth)); await Promise.resolve(); });
  await act(async () => selectTrigger("모델").click());
  const modelOptions = activeSelectOptionLabels("모델");
  expect(modelOptions).toEqual(["모든 모델", "공급자 미확인", "공급자 미확인 · 새 기간 모델", "공급자 미확인 · 원문 모델"]);
  await act(async () => selectTrigger("모델").click());
  await act(async () => selectTrigger("프로젝트").click());
  const projectOptions = activeSelectOptionLabels("프로젝트");
  expect(projectOptions).toEqual(["모든 프로젝트", "새 기간 프로젝트", "미분류", "현재 프로젝트"]);
  expect(projectOptions).not.toContain("이전 프로젝트");
  expect(modelOptions).not.toContain("이전 모델");
  expect([...document.querySelectorAll<HTMLElement>(".usage-stats-share-row")]
    .filter(row => row.querySelector(".usage-stats-share-name")?.textContent === "server-month-model")).toHaveLength(1);
  const modelChart = document.querySelector<HTMLElement>(".usage-stats-chart");
  expect(modelChart?.getAttribute("aria-label")).toBe("모델별 사용량");
  const modelShareList = [...document.querySelectorAll(".usage-stats-share-list")]
    .find(list => list.textContent?.includes("server-month-model"));
  expect(modelShareList?.textContent).toContain("server-month-model");
  const modelSegment = modelChart?.querySelector<HTMLElement>(".usage-stats-stack-segment");
  expect(modelSegment?.style.backgroundColor).toBe("var(--v3-text-tertiary)");
  await act(async () => document.querySelector<HTMLButtonElement>('[data-bucket-index="19"]')!.click());
  expect(request).toHaveBeenCalledTimes(5);
  expect(cacheToggle("캐시 포함").getAttribute("aria-pressed")).toBe("true");
  await chooseTabOption("그래프 보기", "프로젝트별");
  expect(request).toHaveBeenCalledTimes(5);
  expect(cacheToggle("캐시 포함").getAttribute("aria-pressed")).toBe("true");
});

it("clears displayed selections and data and disables both filters after an overview 403", async () => {
  request.mockImplementation((_input) => {
    return Promise.resolve(request.mock.calls.length === 3
      ? forbiddenResponse()
      : jsonResponse(optionsOverview(10)));
  });

  await act(async () => root.render(<UsageStatsTab request={request} />));
  await chooseTabOption("모델", "공급자 미확인 · 원문 모델");
  await chooseTabOption("프로젝트", "현재 프로젝트");

  expect(request).toHaveBeenCalledTimes(3);
  expect(document.body.textContent).toContain("이 통계를 볼 권한이 없습니다.");
  expect(document.querySelector(".usage-stats-summary")).toBeNull();
  expect(document.querySelector(".usage-stats-share-list")).toBeNull();
  expect(document.querySelector(".usage-stats-input-material")).toBeNull();
  expect(selectTrigger("모델").textContent).toContain("모든 모델");
  expect(selectTrigger("프로젝트").textContent).toContain("모든 프로젝트");
  expect(selectTrigger("모델").disabled).toBe(true);
  expect(selectTrigger("프로젝트").disabled).toBe(true);
  await act(async () => selectTrigger("모델").click());
  await act(async () => selectTrigger("프로젝트").click());
  expect(request).toHaveBeenCalledTimes(3);
});

it("removes successful day details and selection labels after a later day 403", async () => {
  const initial = withChartData(optionsOverview(10), "vendor/team:model:v2", 10);
  request.mockImplementation((input) => {
    const url = new URL(String(input), "https://soulstream.test");
    if (url.pathname.endsWith("/days/2026-10-19")) return Promise.resolve(forbiddenResponse());
    if (url.pathname.endsWith("/days/2026-10-20")) return Promise.resolve(jsonResponse(dayDetail(50)));
    return Promise.resolve(jsonResponse(initial));
  });

  await act(async () => root.render(<UsageStatsTab request={request} />));
  await chooseTabOption("모델", "공급자 미확인 · 원문 모델");
  await chooseTabOption("프로젝트", "현재 프로젝트");
  await act(async () => document.querySelector<HTMLButtonElement>('[data-bucket-index="1"]')!.click());
  expect(document.querySelector(".usage-stats-input-material")?.textContent).toContain("툴 호출");
  const inputRows = [...document.querySelectorAll(".usage-stats-input-material .usage-stats-share-row")];
  expect(inputRows).toHaveLength(2);
  expect(inputRows.every(row => row.querySelector(".usage-stats-share-percent") !== null)).toBe(true);
  expect(inputRows[0]?.querySelector(".usage-stats-share-percent")?.textContent).toBe("60%");
  expect(inputRows[1]?.querySelector(".usage-stats-share-percent")?.textContent).toBe("");
  await act(async () => document.querySelector<HTMLButtonElement>('[data-bucket-index="0"]')!.click());

  expect(request).toHaveBeenCalledTimes(5);
  expect(document.body.textContent).toContain("이 통계를 볼 권한이 없습니다.");
  expect(document.querySelector(".usage-stats-summary")).toBeNull();
  expect(document.querySelector(".usage-stats-share-list")).toBeNull();
  expect(document.querySelector(".usage-stats-input-material")).toBeNull();
  expect(selectTrigger("모델").textContent).toContain("모든 모델");
  expect(selectTrigger("프로젝트").textContent).toContain("모든 프로젝트");
  expect(selectTrigger("모델").disabled).toBe(true);
  expect(selectTrigger("프로젝트").disabled).toBe(true);
  await act(async () => selectTrigger("모델").click());
  await act(async () => selectTrigger("프로젝트").click());
  expect(request).toHaveBeenCalledTimes(5);
});

it("distinguishes an unknown empty range from explicit zero without input guidance", async () => {
  const explicitZero = cacheSplitAggregate({ total_tokens: 0 });
  request.mockImplementation(input => {
    const url = new URL(String(input), "https://soulstream.test");
    return Promise.resolve(jsonResponse(url.searchParams.get("period") === "week"
      ? overview(null)
      : overview(0, {}, explicitZero)));
  });

  await act(async () => root.render(<UsageStatsTab request={request} />));

  const summary = document.querySelector(".usage-stats-summary-values")?.textContent ?? "";
  expect(summary).toContain("미기록");
  expect(summary).toContain("미확인");
  const unknownSummary = document.querySelector(".usage-stats-summary")!;
  expect(unknownSummary.querySelector(".usage-stats-summary-metric")?.lastElementChild?.textContent).toBe("캐시 읽기 미기록");
  expect(unknownSummary.querySelectorAll(".usage-stats-summary-metric")[1]?.lastElementChild?.textContent).toBe("캐시 읽기 미확인");
  expect(unknownSummary.querySelector(".usage-stats-share-list")).toBeNull();
  expect(document.querySelector(".usage-stats-chart-message")?.textContent).toBe("미기록");
  expect(document.querySelector(".usage-stats-input-material")).toBeNull();
  expect(document.body.textContent).not.toContain("입력 자료 구성");
  expect(document.body.textContent).not.toContain("막대에서 날짜를 고르세요");

  const costButton = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="표시 값"] button')]
    .find(button => button.textContent?.trim() === "정가");
  if (!costButton) throw new Error("Could not find the cost metric control.");
  await act(async () => costButton.click());
  expect(document.querySelector(".usage-stats-chart-message")?.textContent).toBe("정가 미확인");
  expect(request).toHaveBeenCalledTimes(1);

  const monthButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.trim() === "월간");
  if (!monthButton) throw new Error("Could not find the month period control.");
  await act(async () => monthButton.click());
  expect(request).toHaveBeenCalledTimes(2);
  expect(responseQuery(1).get("period")).toBe("month");
  expect(document.querySelector(".usage-stats-chart-message")?.textContent).toBe("이 기간에 기록이 없습니다");
  const zeroSummary = document.querySelector(".usage-stats-summary")!;
  expect(zeroSummary.querySelector(".usage-stats-summary-metric")?.lastElementChild?.textContent).toBe("캐시 읽기 0 제외");
  expect(zeroSummary.querySelectorAll(".usage-stats-summary-metric")[1]?.lastElementChild?.textContent).toBe("캐시 읽기 $0.00 포함");
  expect(zeroSummary.querySelector(".usage-stats-share-list")).toBeNull();
  expect(document.querySelector(".usage-stats-input-material")).toBeNull();
  expect(document.body.textContent).not.toContain("입력 자료 구성");
  expect(document.body.textContent).not.toContain("막대에서 날짜를 고르세요");
});
