import { expect, test, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

test("485 E1 production ConfigModal flow with controlled statistics transport", async ({ page }) => {
  test.setTimeout(120_000);
  const evidenceDir = path.resolve("../.local/artifacts/485-e1-browser");
  mkdirSync(evidenceDir, { recursive: true });
  const errors: string[] = [];
  const requests: Array<{ method: string; path: string; query: Array<[string, string]>; status: number; responseBody: string; responseSha256: string }> = [];
  let responseMode: "ok" | "server-error" | "forbidden" = "ok";
  let holdNextFilteredOverview = false;
  let markFilteredOverviewHeld: (() => void) | null = null;
  let releaseFilteredOverview: (() => void) | null = null;
  const rawErrorMarker = "485-controlled-transport-error-body";
  const saveTranscript = () => writeFileSync(path.join(evidenceDir, "api-transcript.json"), JSON.stringify({
    transport: "Playwright-controlled local response fixtures; the deployed statistics API was not contacted",
    requests,
  }, null, 2));

  await page.clock.install({ time: new Date("2026-10-20T03:00:00.000Z") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  const preferences = { appearance: "dark", chatFontSize: 17, wallpaper: { mode: "plain" } };
  await page.route("**/api/user/preferences", route => route.fulfill({ json: { preferences, hasBackground: false, backgroundUrl: null } }));
  await page.route("**/api/config/settings", route => route.fulfill({ json: { categories: [] } }));
  await page.route("**/api/session-statistics**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const isDay = /^\/api\/session-statistics\/days\/\d{4}-\d{2}-\d{2}$/.test(url.pathname);
    const status = responseMode === "forbidden" ? 403 : responseMode === "server-error" ? 503 : 200;
    const response = status === 200
      ? JSON.stringify(isDay ? dayFixture() : overviewFixture(url.searchParams))
      : JSON.stringify({ error: rawErrorMarker, detail: "controlled test fixture" });
    requests.push({
      method: request.method(),
      path: url.pathname,
      query: [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)),
      status,
      responseBody: response,
      responseSha256: createHash("sha256").update(response).digest("hex"),
    });
    saveTranscript();
    if (!isDay && holdNextFilteredOverview && url.searchParams.has("model")) {
      holdNextFilteredOverview = false;
      markFilteredOverviewHeld?.();
      await new Promise<void>(resolve => { releaseFilteredOverview = resolve; });
    }
    await route.fulfill({ status, contentType: "application/json", body: response });
  });
  page.on("pageerror", error => {
    errors.push(error.stack ?? error.message);
    writeFileSync(path.join(evidenceDir, "browser-errors.json"), JSON.stringify(errors, null, 2));
  });

  await page.goto("/");
  await expect(page.getByTestId("v3-global-toolbar")).toBeVisible();
  await page.getByTestId("v3-global-toolbar").getByRole("button", { name: "서버 설정" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "설정" })).toBeVisible();
  await dialog.getByTestId("config-category-nav").getByRole("button", { name: "세션 통계" }).click();
  await expect(dialog.getByRole("heading", { name: "세션 통계" })).toBeVisible();
  const stats = dialog.locator(".usage-stats-tab");
  await expect(stats.locator("[data-bucket-index]")).toHaveCount(7);
  await expect(stats.locator(".usage-stats-share-list")).toContainText("모델 미상");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.path).toBe("/api/session-statistics");
  expect(requests[0]?.query).toContainEqual(["anchor", "2026-10-20"]);
  expect(requests[0]?.query).toContainEqual(["timezone", "Asia/Seoul"]);
  await captureStats("1440-overview");

  holdNextFilteredOverview = true;
  const filteredOverviewHeld = new Promise<void>(resolve => { markFilteredOverviewHeld = resolve; });
  try {
    await chooseStatsOption(dialog, page, "모델", "원문 모델");
    await filteredOverviewHeld;
    expect(requests).toHaveLength(2);
    await expect(stats.getByRole("combobox", { name: "모델" })).toContainText("원문 모델");
    await stats.getByRole("combobox", { name: "모델" }).click();
    await expect(page.getByRole("option", { name: "공급자 미확인 · 원문 모델", exact: true })).toBeVisible();
    expect(requests).toHaveLength(2);
    await page.keyboard.press("Escape");
  } finally {
    releaseFilteredOverview?.();
  }
  await expect(stats.locator(".usage-stats-share-list")).toContainText("vendor/team:model:v2");
  expect(requests).toHaveLength(2);
  expect(requests[1]?.query).toContainEqual(["provider", "unknown"]);
  expect(requests[1]?.query).toContainEqual(["model", "vendor/team:model:v2"]);

  await chooseStatsOption(dialog, page, "프로젝트", "소울스트림");
  await expect(stats.locator(".usage-stats-share-list")).toContainText("vendor/team:model:v2");
  expect(requests).toHaveLength(3);
  expect(requests[2]?.query).toContainEqual(["project_ids", "folder-amber"]);

  const filterRequestCount = requests.length;
  await chooseStatsOption(dialog, page, "그래프 보기", "프로젝트별");
  const projectChart = stats.locator('.usage-stats-chart[aria-label="프로젝트별 사용량"]');
  await expect(projectChart).toHaveCount(1);
  const projectSegment = projectChart.locator(".usage-stats-stack-segment").first();
  expect(await projectSegment.evaluate(element => (element as HTMLElement).style.backgroundColor))
    .toBe("var(--usage-stats-project-1)");
  const namedProjectRow = stats.locator(".usage-stats-share-list .usage-stats-share-row").filter({ hasText: "소울스트림" });
  await expect(namedProjectRow).toHaveCount(1);
  await expect(namedProjectRow.locator(".usage-stats-share-fill")).toHaveCount(1);
  expect(await namedProjectRow.evaluate(element => (element as HTMLElement).style.getPropertyValue("--usage-stats-row-color")))
    .toBe("var(--usage-stats-project-1)");
  await dialog.getByRole("group", { name: "표시 값" }).getByRole("button", { name: "정가" }).click();
  expect(requests).toHaveLength(filterRequestCount);
  await expect(stats.getByRole("combobox", { name: "모델" })).toContainText("원문 모델");
  await expect(stats.getByRole("combobox", { name: "프로젝트" })).toContainText("소울스트림");
  const dayButton = stats.locator('[data-bucket-index="1"]');
  await expect(dayButton).toBeEnabled();
  await dayButton.click();
  await expect(stats.locator(".usage-stats-input-material")).toContainText("툴 호출 4회");
  expect(requests).toHaveLength(filterRequestCount + 1);
  expect(requests.at(-1)?.path).toBe("/api/session-statistics/days/2026-10-20");
  expect(requests.at(-1)?.query).toContainEqual(["provider", "unknown"]);
  expect(requests.at(-1)?.query).toContainEqual(["model", "vendor/team:model:v2"]);
  expect(requests.at(-1)?.query).toContainEqual(["project_ids", "folder-amber"]);
  const inputRows = stats.locator(".usage-stats-input-material .usage-stats-share-row");
  await expect(inputRows).toHaveCount(3);
  await expect(inputRows.nth(0)).toContainText("시스템 프롬프트");
  await expect(inputRows.nth(0)).toContainText("약 12+ 토큰");
  await expect(inputRows.nth(1)).toContainText("분류 미확인");
  await expect(inputRows.nth(2)).toContainText("하네스 내부 입력");
  await expect(inputRows.nth(2)).toContainText("관측 안 됨");
  await captureStats("1440-day-detail");

  await stats.locator(".usage-stats-date-chip").click();
  await expect(stats.getByText("막대에서 날짜를 고르세요", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(filterRequestCount + 1);

  responseMode = "server-error";
  await dialog.getByRole("group", { name: "통계 기간" }).getByRole("button", { name: "월간" }).click();
  await expect(stats.getByText("통계를 불러오지 못했습니다.")).toBeVisible();
  await expect(stats.getByText(rawErrorMarker)).toHaveCount(0);
  await captureStats("1440-error");
  responseMode = "ok";
  await stats.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(stats.locator("[data-bucket-index]")).toHaveCount(31);

  responseMode = "forbidden";
  await dialog.getByRole("combobox", { name: "모델" }).click();
  await page.getByRole("option", { name: "공급자 미확인", exact: true }).click();
  await expect(stats.getByText("이 통계를 볼 권한이 없습니다.")).toBeVisible();
  await expect(stats.getByText(rawErrorMarker)).toHaveCount(0);
  await expect(stats.locator(".usage-stats-share-list")).toHaveCount(0);
  await captureStats("1440-forbidden");

  await dialog.getByRole("button", { name: "완료" }).click();
  await expect(dialog).toBeHidden();
  responseMode = "ok";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("v3-global-toolbar").getByRole("button", { name: "서버 설정" }).click();
  const narrowDialog = page.getByRole("dialog");
  await expect(narrowDialog.getByRole("heading", { name: "설정" })).toBeVisible();
  await narrowDialog.getByTestId("config-category-nav").getByRole("button", { name: "세션 통계" }).click();
  const narrowStats = narrowDialog.locator(".usage-stats-tab");
  await expect(narrowStats.locator("[data-bucket-index]")).toHaveCount(7);
  await expect(narrowStats.locator(".usage-stats-share-list")).toContainText("모델 미상");
  await expectNoStatsHorizontalOverflow(narrowDialog, narrowStats);
  await captureStats("390-overview");
  await narrowStats.locator('[data-bucket-index="1"]').click();
  await expect(narrowStats.locator(".usage-stats-input-material")).toContainText("툴 호출 4회");
  await expectNoStatsHorizontalOverflow(narrowDialog, narrowStats);
  await captureStats("390-day-detail");
  await narrowDialog.getByRole("button", { name: "완료" }).click();
  await expect(narrowDialog).toBeHidden();
  expect(errors).toEqual([]);
  saveTranscript();
  writeFileSync(path.join(evidenceDir, "browser-errors.json"), JSON.stringify(errors, null, 2));

  async function captureStats(name: string) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(evidenceDir, name + ".png"), fullPage: true });
    const metrics = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        return element ? element.getBoundingClientRect().toJSON() : null;
      };
      const dialogElement = document.querySelector('[role="dialog"]');
      const statsElement = document.querySelector(".usage-stats-tab");
      return {
        viewport: { width: innerWidth, height: innerHeight },
        dialog: rect('[role="dialog"]'),
        stats: rect(".usage-stats-tab"),
        controls: rect(".usage-stats-controls"),
        chart: rect(".usage-stats-chart"),
        summary: rect(".usage-stats-summary"),
        inputMaterial: rect(".usage-stats-input-material"),
        dialogClientWidth: dialogElement?.clientWidth ?? null,
        dialogScrollWidth: dialogElement?.scrollWidth ?? null,
        statsClientWidth: statsElement?.clientWidth ?? null,
        statsScrollWidth: statsElement?.scrollWidth ?? null,
      };
    });
    writeFileSync(path.join(evidenceDir, name + "-metrics.json"), JSON.stringify(metrics, null, 2));
  }
});

function statsMetrics(totalTokens: number, cost = 0.012) {
  return {
    input_total: null, cache_read: null, cache_write: null, output_total: null,
    reasoning_output: null, total_tokens: totalTokens, reference_cost_usd: cost,
  };
}

function statsCoverage() {
  return {
    usage_complete_events: 1, usage_partial_events: 0, terminal_missing_usage: 0,
    ended_input_without_usage: 0, missing_usage_turns: 0, pending_inputs: 0,
    priced_events: 1, unpriced_events: 0, priced_total_tokens: 100,
    unpriced_total_tokens: null, unknown_total_token_events: 0,
    unattributed_missing_usage: false,
  };
}

function statsAggregate(totalTokens: number) {
  return { metrics: statsMetrics(totalTokens), coverage: statsCoverage(), is_partial: false };
}

function overviewFixture(query: URLSearchParams) {
  const period = query.get("period") ?? "week";
  const monthly = period === "month";
  const selectedModel = query.get("model");
  const since = monthly ? "2026-10-01" : "2026-10-19";
  const until = monthly ? "2026-11-01" : "2026-10-26";
  const modelRow = {
    provider: "unknown", backend: "custom", model: selectedModel,
    attribution: "model", metrics: statsMetrics(100), coverage: statsCoverage(), is_partial: false,
  };
  return {
    schema_version: 1,
    generated_at: "2026-10-20T03:00:00.000Z",
    as_of: "2026-10-20T03:00:00.000Z",
    range: { period, since, until, effective_until: "2026-10-21", timezone: "Asia/Seoul", bucket: "day" },
    policies: { date_attribution: "recorded_terminal", project_attribution: "current_folder", price_version: "api-list-usd-2026-10-19-v1" },
    projection_status: { state: "ready", covered_since: "2026-10-01" },
    totals: statsAggregate(120),
    by_model: [modelRow],
    by_project: [
      { project_id: "folder-amber", label: "소울스트림", ...statsAggregate(100) },
      { project_id: null, label: "미분류", ...statsAggregate(20) },
    ],
    series: [
      { bucket_start: "2026-10-20", provider: "unknown", model: selectedModel, label: selectedModel ?? "모델 미상", metrics: statsMetrics(100) },
      { bucket_start: "2026-10-20", project_id: "folder-amber", label: "소울스트림", metrics: statsMetrics(100) },
      { bucket_start: "2026-10-20", project_id: null, label: "미분류", metrics: statsMetrics(20) },
    ],
    options: {
      providers: [{ provider: "unknown", label: "공급자 미확인" }],
      models: [
        { provider: "unknown", model: "vendor/team:model:v2", backend: "custom", label: "원문 모델" },
        { provider: "unknown", model: null, backend: "custom", label: "모델 미상" },
      ],
      projects: [{ project_id: "folder-amber", label: "소울스트림" }],
      project_roster: [],
      model_rosters: [{ provider: "unknown", models: ["vendor/team:model:v2", null] }],
    },
  };
}

function dayFixture() {
  return {
    schema_version: 1,
    date: "2026-10-20",
    generated_at: "2026-10-20T03:00:00.000Z",
    as_of: "2026-10-20T03:00:00.000Z",
    totals: statsAggregate(100),
    by_model: [{ provider: "unknown", backend: "custom", model: "vendor/team:model:v2", attribution: "model", ...statsAggregate(100) }],
    by_project: [{ project_id: "folder-amber", label: "소울스트림", ...statsAggregate(100) }],
    input_material: {
      basis: "observed_input_material", unit: "approximate_tokens", estimate_method: "utf16_chars_div4_ceil_v1", method: "combined_visible",
      observed_approximate_tokens: 24,
      parts: [
        { category: "system_prompt", source_key: "system", approximate_tokens: 12, share: 0.5, measurement: "estimate" },
        { category: "system_prompt", source_key: "history", approximate_tokens: null, share: null, measurement: "unobserved" },
        { category: "future_payload", source_key: "future", approximate_tokens: 12, share: 0.5, measurement: "estimate" },
        { category: "harness_internal", source_key: null, approximate_tokens: null, share: null, measurement: "unobserved" },
      ],
      calibration: { status: "not_comparable", sample_count: 0, factor: null, reasons: ["missing_source_token_breakdown"] },
      coverage: { complete_samples: 1, partial_samples: 1, manifest_only_samples: 0, missing_samples: 0 },
    },
    tool_calls: 4,
  };
}

async function chooseStatsOption(dialog: Locator, page: Page, field: string, option: string) {
  await dialog.getByRole("combobox", { name: field }).click();
  await page.locator('[data-slot="select-positioner"]:not([hidden]) [data-slot="select-item"]').filter({ hasText: option }).last().click();
}

async function expectNoStatsHorizontalOverflow(dialog: Locator, stats: Locator) {
  const widths = await Promise.all([
    dialog.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth })),
    stats.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth })),
  ]);
  expect(widths[0]!.scroll).toBeLessThanOrEqual(widths[0]!.client + 1);
  expect(widths[1]!.scroll).toBeLessThanOrEqual(widths[1]!.client + 1);
}
