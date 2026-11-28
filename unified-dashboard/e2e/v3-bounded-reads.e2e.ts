import { expect, test, type Page, type Request } from "./test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { openV3Folder } from "./v3-qa-entry";
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

    await openV3Folder(page, BASE_URL);
    await page.waitForLoadState("networkidle");
    await capture(page, outputDir, "01-entry");

    expect(apiRequests(requests, "/api/planner/starred-folders")).toHaveLength(1);
    expect(requests.some((url) => /\/api\/pages\?.*limit=/.test(url))).toBe(false);
    expect(apiRequests(requests, "/api/nodes")).toHaveLength(0);
    expect(apiRequests(requests, "/api/planner/folders/rb-alpha/sessions")).toHaveLength(0);

    // 폴더 제목 h1의 접근 이름은 편집 버튼 이름이다. 제목은 버튼 텍스트로 확인한다.
    await expect(page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.project })).toBeVisible();
    await capture(page, outputDir, "02-project");

    await page.getByTestId("v3-task-task-alpha").click();
    await expect(page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask })).toBeVisible();
    await expect(page.getByText("1회", { exact: true })).toBeVisible();
    // 이전 세션은 '더 보기' 버튼 대신 스크롤 감지 로더가 이어서 불러온다.
    await expect(page.getByTestId("v3-run-history-auto-loader")).toBeVisible();
    await capture(page, outputDir, "03-task-latest-run");

    await page.getByTestId("v3-planner-scroll").evaluate((element) => {
      element.scrollTo({ top: element.scrollHeight });
    });
    await expect(page.getByText("2회", { exact: true })).toBeVisible();
    await expect(page.getByTestId("v3-run-history-auto-loader")).toBeHidden();
    // 다음 페이지는 정확히 한 번만 요청한다.
    expect(apiRequests(requests, "/api/planner/folders/rb-alpha/sessions")).toHaveLength(1);
    await capture(page, outputDir, "04-task-full-history");

    await page.getByRole("button", { name: "상위 폴더로 이동" }).click();
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
