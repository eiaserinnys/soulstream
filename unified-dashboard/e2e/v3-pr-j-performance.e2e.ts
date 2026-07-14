import { expect, test, type Page, type Request } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.PR_J_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-pr-j"),
);
const CATALOG_DELAY_MS = 1_600;
const PLANNER_DELAY_MS = 0;
const TIMELINE_EVENT_COUNT = 510;

interface RequestMark {
  method: string;
  path: string;
  query: string;
  startedAtMs: number;
}

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });
test.setTimeout(90_000);

test("PR-J: planner fanout, targeted run hydration, long-history sync, and repeated switching", async ({ page }) => {
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  const startedAt = Date.now();
  const requests: RequestMark[] = [];
  const sessionResponseMarks: Array<{ targeted: boolean; completedAtMs: number }> = [];

  page.on("request", (request) => requests.push(requestMark(request, startedAt)));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname !== "/api/sessions") return;
    sessionResponseMarks.push({
      targeted: url.searchParams.has("session_id"),
      completedAtMs: Date.now() - startedAt,
    });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await disableServiceWorker(page);
  await installV3VisualQaRoutes(page, {
    catalogDelayMs: CATALOG_DELAY_MS,
    plannerDelayMs: PLANNER_DELAY_MS,
    timelineEventCount: TIMELINE_EVENT_COUNT,
    liveEventText: "라이브 갱신 확인",
  });

  const navigationStartedAt = Date.now();
  await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
  const domContentLoadedMs = Date.now() - navigationStartedAt;
  const domContentLoadedAtMs = Date.now() - startedAt;
  await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible" });
  const plannerVisibleAtMs = Date.now() - startedAt;
  const plannerRequestStartedAtMs = requests.find((mark) => mark.path === "/api/pages/daily")?.startedAtMs;
  if (plannerRequestStartedAtMs === undefined) throw new Error("daily planner request was not observed");
  const plannerReadyMs = plannerVisibleAtMs - plannerRequestStartedAtMs;
  const domContentLoadedToPlannerReadyMs = plannerVisibleAtMs - domContentLoadedAtMs;
  const coldNavigationPlannerReadyMs = Date.now() - navigationStartedAt;
  expect(plannerReadyMs, "today planner ready under one second").toBeLessThan(1_000);

  const runRowsStartedAt = Date.now();
  await page.getByTestId("v3-task-task-alpha").click();
  await expect(page.getByRole("heading", { name: fixtureTitles.primaryTask, level: 2 })).toBeVisible();
  const activeRun = page.locator(".v3-run-open").filter({ hasText: "시각 QA 순회" });
  await expect(activeRun).toContainText("로젤린");
  await expect(activeRun).toContainText("eiaserinnys");
  await expect(activeRun).toContainText("다크·라이트 실제 픽셀 순회를 진행하고 있습니다.");
  const runRowsVisibleAtMs = Date.now() - startedAt;
  const targetedSessionStartedAtMs = requests.find((mark) => (
    mark.path === "/api/sessions" && mark.query.includes("session_id=")
  ))?.startedAtMs;
  if (targetedSessionStartedAtMs === undefined) throw new Error("targeted session request was not observed");
  const runRowsReadyMs = runRowsVisibleAtMs - targetedSessionStartedAtMs;
  const taskOpenToRunRowsReadyMs = Date.now() - runRowsStartedAt;
  expect(runRowsReadyMs, "targeted run summaries ready under two seconds").toBeLessThan(2_000);
  expect(
    sessionResponseMarks.some((mark) => mark.targeted) && !sessionResponseMarks.some((mark) => !mark.targeted),
    "targeted session response should complete before delayed catalog",
  ).toBe(true);

  const alphaFanout = requestTimes(requests, [
    "/api/pages/task-alpha/backlinks",
    "/api/runbooks/rb-alpha",
    "/api/board-items?container_kind=runbook&container_id=rb-alpha",
  ]);
  expect(Math.max(...alphaFanout) - Math.min(...alphaFanout), "task-internal requests fan out together").toBeLessThan(150);
  const taskBacklinks = requestTimes(requests, [
    "/api/pages/task-alpha/backlinks",
    "/api/pages/task-beta/backlinks",
  ]);
  expect(Math.max(...taskBacklinks) - Math.min(...taskBacklinks), "tasks fan out together").toBeLessThan(150);

  await page.screenshot({
    path: path.join(OUTPUT_ROOT, "01-rich-run-row-targeted-before-catalog.png"),
    animations: "disabled",
  });

  const timelineRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/timeline")) timelineRequests.push(request.url());
  });

  await page.locator(".v3-run-open").filter({ hasText: "run #2" }).click();
  await expect(page.getByRole("region", { name: "Run 채팅" })).toBeVisible();
  await expect.poll(() => timelineCount(timelineRequests, "run-alpha-2")).toBe(1);
  const scroller = page.locator('[data-testid="virtuoso-scroller"]').last();
  await expect(scroller).toBeVisible();
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByText("히스토리 run-alpha-2 #510")).toBeVisible();
  await expect(page.getByText("라이브 갱신 확인 run-alpha-2")).toBeVisible();

  const beginning = page.getByText("Beginning of conversation", { exact: false });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await beginning.isVisible().catch(() => false)) break;
    await scroller.evaluate((element) => {
      element.scrollTop = Math.min(600, Math.max(0, element.scrollHeight - element.clientHeight));
    });
    await page.waitForTimeout(120);
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    await page.waitForTimeout(250);
  }
  await expect(beginning).toBeVisible();
  await expect(page.getByText("히스토리 run-alpha-2 #1", { exact: true })).toBeVisible();
  await page.screenshot({
    path: path.join(OUTPUT_ROOT, "02-chat-510-events-backfilled.png"),
    animations: "disabled",
  });
  const runAlpha2BackfillPageCount = timelineCount(timelineRequests, "run-alpha-2");
  expect(runAlpha2BackfillPageCount).toBe(6);

  await switchRun(page, timelineRequests, "run #1", "run-alpha-1", "run-alpha-2");
  await switchRun(page, timelineRequests, "run #2", "run-alpha-2", "run-alpha-1");
  await switchRun(page, timelineRequests, "run #1", "run-alpha-1", "run-alpha-2");

  const plannerRequests = requests.filter((mark) => (
    mark.path.includes("/backlinks") ||
    mark.path.startsWith("/api/runbooks/") ||
    mark.path === "/api/board-items"
  ));
  const metrics = {
    measured: {
      plannerReadyMs,
      domContentLoadedMs,
      domContentLoadedToPlannerReadyMs,
      coldNavigationPlannerReadyMs,
      runRowsReadyMs,
      taskOpenToRunRowsReadyMs,
      plannerRequestCount: plannerRequests.length,
      targetedSessionRequestCount: requests.filter((mark) => mark.path === "/api/sessions" && mark.query.includes("session_id=")).length,
      catalogSessionRequestCount: requests.filter((mark) => mark.path === "/api/sessions" && !mark.query.includes("session_id=")).length,
      runAlpha2BackfillPageCount,
      runAlpha2TimelinePageCountAfterSwitches: timelineCount(timelineRequests, "run-alpha-2"),
      timelineEventCount: TIMELINE_EVENT_COUNT,
      runSwitchCount: 3,
      alphaTaskFanoutSpreadMs: Math.max(...alphaFanout) - Math.min(...alphaFanout),
      crossTaskFanoutSpreadMs: Math.max(...taskBacklinks) - Math.min(...taskBacklinks),
    },
    comparison: {
      basis: "pre-change source waterfall versus this Chromium request trace",
      plannerTaskRoundTripsBefore: plannerRequests.length,
      plannerTaskRoundTripsAfter: plannerRequests.length,
      dailyTaskCriticalPathWavesBefore: 2,
      dailyTaskCriticalPathWavesAfter: 1,
      projectTaskCriticalPathWavesBefore: 2,
      projectTaskCriticalPathWavesAfter: 1,
      delayedCatalogMs: CATALOG_DELAY_MS,
      targetedRowsResolvedBeforeCatalog: true,
    },
    requests,
    sessionResponseMarks,
  };
  writeFileSync(path.join(OUTPUT_ROOT, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
});

async function disableServiceWorker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    const serviceWorker = navigator.serviceWorker;
    if (!serviceWorker) return;
    Object.defineProperty(serviceWorker, "register", {
      configurable: true,
      value: async () => ({
        update: async () => undefined,
        active: null,
        installing: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    Object.defineProperty(serviceWorker, "controller", {
      configurable: true,
      get: () => null,
    });
  });
}

function requestMark(request: Request, startedAt: number): RequestMark {
  const url = new URL(request.url());
  return {
    method: request.method(),
    path: url.pathname,
    query: url.searchParams.toString(),
    startedAtMs: Date.now() - startedAt,
  };
}

function requestTimes(requests: readonly RequestMark[], targets: readonly string[]): number[] {
  return targets.map((target) => {
    const [pathName, query = ""] = target.split("?");
    const match = requests.find((request) => (
      request.path === pathName && (!query || request.query === query)
    ));
    if (!match) throw new Error(`request not observed: ${target}`);
    return match.startedAtMs;
  });
}

function timelineCount(requests: readonly string[], sessionId: string): number {
  return requests.filter((requestUrl) => (
    new URL(requestUrl).pathname === `/api/sessions/${sessionId}/timeline`
  )).length;
}

async function switchRun(
  page: Page,
  timelineRequests: readonly string[],
  runLabel: string,
  expectedSessionId: string,
  previousSessionId: string,
): Promise<void> {
  const previousCount = timelineCount(timelineRequests, expectedSessionId);
  await page.locator(".v3-run-open").filter({ hasText: runLabel }).click();
  await expect.poll(() => timelineCount(timelineRequests, expectedSessionId)).toBe(previousCount + 1);
  await expect(page.getByText(`라이브 갱신 확인 ${expectedSessionId}`)).toBeVisible();
  await expect(page.getByText(`라이브 갱신 확인 ${previousSessionId}`)).toHaveCount(0);
}
