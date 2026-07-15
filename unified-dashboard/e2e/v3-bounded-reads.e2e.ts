import { expect, test, type Page, type Request } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.PR_R_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-bounded-reads"),
);

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });

for (const theme of ["dark", "light"] as const) {
  test(`v3 bounded reads and lazy run history · ${theme}`, async ({ page }) => {
    test.setTimeout(120_000);
    const outputDir = path.join(OUTPUT_ROOT, theme);
    mkdirSync(outputDir, { recursive: true });
    const requests: string[] = [];
    const browserErrors: string[] = [];
    const failedRequests: string[] = [];

    page.on("request", (request) => requests.push(request.url()));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("requestfailed", (request) => failedRequests.push(formatFailure(request)));

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.addInitScript((appearance: "dark" | "light") => {
      localStorage.setItem("soul-dashboard-theme", appearance);
      localStorage.setItem("ls.webglGlass", "false");
      if (navigator.serviceWorker) {
        Object.defineProperty(navigator.serviceWorker, "register", {
          configurable: true,
          value: async () => ({
            update: async () => undefined,
            active: null,
            installing: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          }),
        });
        Object.defineProperty(navigator.serviceWorker, "controller", {
          configurable: true,
          get: () => null,
        });
      }
    }, theme);
    await installV3VisualQaRoutes(page, { alphaRunHistoryPages: true });

    await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("v3-task-task-alpha")).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState("networkidle");
    await capture(page, outputDir, "01-entry");

    expect(apiRequests(requests, "/api/planner/starred-tasks")).toHaveLength(1);
    expect(requests.some((url) => /\/api\/pages\?.*limit=/.test(url))).toBe(false);
    expect(apiRequests(requests, "/api/nodes")).toHaveLength(0);
    expect(requests.some((url) => /\/api\/sessions\?.*(?:limit=0|sessionScope=all)/.test(url))).toBe(false);
    expect(apiRequests(requests, "/api/planner/tasks/task-alpha/runs")).toHaveLength(0);

    await page.getByTestId("v3-all-projects")
      .getByRole("button", { name: fixtureTitles.project, exact: true })
      .click();
    await expect(page.getByRole("heading", { name: fixtureTitles.project })).toBeVisible();
    await capture(page, outputDir, "02-project");

    await page.getByTestId("v3-task-task-alpha").click();
    await expect(page.getByRole("heading", { name: fixtureTitles.primaryTask, level: 2 })).toBeVisible();
    await expect(page.getByText("1/2회", { exact: true })).toBeVisible();
    await expect(page.getByTestId("v3-load-more-runs")).toBeVisible();
    expect(apiRequests(requests, "/api/planner/tasks/task-alpha/runs")).toHaveLength(1);
    await capture(page, outputDir, "03-task-latest-run");

    await page.getByTestId("v3-load-more-runs").click();
    await expect(page.getByText("2회", { exact: true })).toBeVisible();
    await expect(page.getByTestId("v3-load-more-runs")).toBeHidden();
    expect(apiRequests(requests, "/api/planner/tasks/task-alpha/runs")).toHaveLength(2);
    await capture(page, outputDir, "04-task-full-history");

    await page.getByRole("button", { name: "← 오늘로" }).click();
    await expect(page.getByText("오늘의 업무")).toBeVisible();
    await page.getByTestId("v3-global-toolbar")
      .getByRole("button", { name: "아침 정리", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "어제에서 넘어온 것" })).toBeVisible();
    await expect(page.locator(".v3-ritual-card")).toBeVisible();
    expect(apiRequests(requests, "/api/planner/daily-history")).toHaveLength(1);
    await capture(page, outputDir, "05-ritual");

    expect(browserErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
}

async function capture(page: Page, outputDir: string, name: string): Promise<void> {
  await page.screenshot({ path: path.join(outputDir, `${name}.png`) });
}

function apiRequests(requests: readonly string[], pathname: string): string[] {
  return requests.filter((raw) => new URL(raw).pathname === pathname);
}

function formatFailure(request: Request): string {
  return `${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`;
}
