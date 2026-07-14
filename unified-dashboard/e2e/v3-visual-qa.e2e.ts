import { expect, test, type Page, type Request } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.V3_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-visual-qa"),
);
const ALLOW_DEFECTS = process.env.V3_QA_ALLOW_DEFECTS === "1";
const WEBGL_OVERRIDE = process.env.V3_QA_WEBGL_OVERRIDE ?? null;

type Theme = "dark" | "light";

interface Diagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  requestFailures: string[];
  expectedNavigationAborts: string[];
  overflow: Array<{ state: string; scrollWidth: number; innerWidth: number }>;
  contentOverflow: Array<{ state: string; selector: string; scrollWidth: number; clientWidth: number }>;
  fontFamily: string;
}

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });

for (const theme of ["dark", "light"] as const) {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ] as const) {
    test(`v3 visual sweep · ${theme} · ${viewport.width}px`, async ({ page }) => {
      test.setTimeout(240_000);
      const outputDir = path.join(OUTPUT_ROOT, `${theme}-${viewport.width}`);
      mkdirSync(outputDir, { recursive: true });
      const diagnostics: Diagnostics = {
        consoleErrors: [],
        pageErrors: [],
        requestFailures: [],
        expectedNavigationAborts: [],
        overflow: [],
        contentOverflow: [],
        fontFamily: "",
      };

      page.on("console", (message) => {
        if (message.type() === "error") {
          diagnostics.consoleErrors.push(message.text());
          console.log(`[browser console] ${message.text()}`);
        }
      });
      page.on("pageerror", (error) => {
        diagnostics.pageErrors.push(error.message);
        console.log(`[browser pageerror] ${error.stack ?? error.message}`);
      });
      let navigationInProgress = false;
      page.on("requestfailed", (request) => {
        const failure = formatRequestFailure(request);
        if (navigationInProgress && request.failure()?.errorText === "net::ERR_ABORTED") {
          diagnostics.expectedNavigationAborts.push(failure);
        } else {
          diagnostics.requestFailures.push(failure);
        }
      });

      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript(({ appearance, webglOverride }: { appearance: Theme; webglOverride: string | null }) => {
        localStorage.setItem("soul-dashboard-theme", appearance);
        if (webglOverride !== null) localStorage.setItem("ls.webglGlass", webglOverride);
        const serviceWorker = navigator.serviceWorker;
        if (serviceWorker) {
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
        }
      }, { appearance: theme, webglOverride: WEBGL_OVERRIDE });
      await installV3VisualQaRoutes(page);
      await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText("오늘의 업무")).toBeVisible();
      await expect(page.getByTestId("v3-task-task-alpha")).toBeVisible({ timeout: 20_000 });
      await page.waitForLoadState("networkidle");
      diagnostics.fontFamily = await page.locator(".v3-emoji").first().evaluate((element) => (
        getComputedStyle(element).fontFamily
      ));

      await capture(page, outputDir, "01-today-planner", diagnostics);
      await page.getByRole("button", { name: "＋ 새 업무" }).hover();
      await capture(page, outputDir, "01b-today-primary-hover", diagnostics);

      if (viewport.name === "desktop") {
        await page.getByTestId("v3-all-projects")
          .getByRole("button", { name: fixtureTitles.project, exact: true })
          .click();
      } else {
        await page.getByRole("button", { name: "아카이브 보기 ›" }).first().click();
      }
      await expect(page.getByRole("heading", { name: fixtureTitles.project })).toBeVisible({ timeout: 20_000 });
      await capture(page, outputDir, "02-project-view", diagnostics);

      await page.getByRole("button", { name: "＋ 새 업무" }).click();
      await expect(page.getByRole("group", { name: "새 업무 만들기" })).toBeVisible();
      await capture(page, outputDir, "03-new-task-form-focus", diagnostics);
      await page.getByRole("button", { name: "취소" }).click();

      await page.getByTestId("v3-task-task-alpha").click();
      await expect(page.getByRole("heading", { name: fixtureTitles.primaryTask, level: 2 })).toBeVisible();
      await capture(page, outputDir, "04-task-detail-rendered", diagnostics);
      await page.locator(".v3-description-preview").click();
      await expect(page.getByRole("textbox", { name: "업무 설명 마크다운" })).toBeFocused();
      await capture(page, outputDir, "04b-task-detail-editing", diagnostics);
      await page.getByRole("button", { name: "완료", exact: true }).click();

      await page.getByRole("button", { name: "＋ 컨텍스트" }).click();
      await expect(page.getByRole("tablist", { name: "컨텍스트 종류" })).toBeVisible();
      for (const tab of ["페이지", "atom", "이전 세션", "guidance"]) {
        await page.getByRole("tab", { name: new RegExp(tab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
        await capture(page, outputDir, `05-context-${slug(tab)}`, diagnostics);
      }
      await page.getByRole("button", { name: "＋ 컨텍스트" }).click();

      await page.locator(".v3-run-open").filter({ hasText: "run #2" }).click();
      await expect(page.getByRole("region", { name: "Run 채팅" })).toBeVisible();
      await capture(page, outputDir, "06-chat-open", diagnostics);
      if (viewport.name === "desktop") {
        await dragDivider(page, 0.6);
        await capture(page, outputDir, "06b-chat-split-dragged-60", diagnostics);
        await dragDivider(page, 0);
        await expect(page.getByRole("separator", { name: "상세와 채팅 너비 조절" })).toHaveAttribute("aria-valuenow", "25");
        await capture(page, outputDir, "06c-chat-split-min-25", diagnostics);
        await dragDivider(page, 1);
        await expect(page.getByRole("separator", { name: "상세와 채팅 너비 조절" })).toHaveAttribute("aria-valuenow", "75");
        await capture(page, outputDir, "06d-chat-split-max-75", diagnostics);
        await page.waitForLoadState("networkidle");
        navigationInProgress = true;
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.getByText("오늘의 업무")).toBeVisible();
        await page.waitForLoadState("networkidle");
        navigationInProgress = false;
        await page.getByTestId("v3-all-projects")
          .getByRole("button", { name: fixtureTitles.project, exact: true })
          .click();
        await page.getByTestId("v3-task-task-alpha").click();
        await page.locator(".v3-run-open").filter({ hasText: "run #2" }).click();
        await expect(page.getByRole("separator", { name: "상세와 채팅 너비 조절" })).toHaveAttribute("aria-valuenow", "60");
        await capture(page, outputDir, "06e-chat-split-after-reload-60", diagnostics);
      }

      await page.getByRole("button", { name: "채팅 닫기" }).click();
      await page.getByRole("button", { name: "＋ 새 세션" }).click();
      await expect(page.getByRole("dialog", { name: "새 세션 · 승계 미리보기" })).toBeVisible();
      await capture(page, outputDir, "07-session-succession", diagnostics);
      await page.getByRole("button", { name: "승계 닫기" }).click();

      await returnToPlanner(page, viewport.name);
      const ritualTrigger = page.getByRole("button", { name: /아침 정리/ });
      await expect(ritualTrigger).toBeVisible();
      await ritualTrigger.click();
      await expect(page.getByRole("dialog", { name: "어제에서 넘어온 것" })).toBeVisible();
      await expect(page.locator(".v3-ritual-card")).toBeVisible();
      await capture(page, outputDir, "08-ritual-in-progress", diagnostics);
      for (let count = 0; count < 6; count += 1) {
        if (await page.locator(".v3-ritual-done").isVisible().catch(() => false)) break;
        await page.getByRole("button", { name: "미루기" }).click();
      }
      await expect(page.locator(".v3-ritual-done")).toBeVisible();
      await capture(page, outputDir, "08b-ritual-complete", diagnostics);
      await page.getByRole("button", { name: "플래너 열기" }).click();

      if (viewport.name === "mobile") {
        await expect(page.getByTestId("v3-mobile-tab-today")).toBeVisible();
        await capture(page, outputDir, "09a-mobile-today", diagnostics);
        await page.getByTestId("v3-mobile-tab-task").click();
        await capture(page, outputDir, "09b-mobile-task", diagnostics);
        await page.getByTestId("v3-mobile-tab-chat").click();
        await capture(page, outputDir, "09c-mobile-chat", diagnostics);
      } else {
        await expect(page.getByTestId("v3-mobile-tab-today")).toBeHidden();
      }

      await page.waitForLoadState("networkidle");
      navigationInProgress = true;
      await page.goto(`${BASE_URL}/v2`, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(`${BASE_URL}/v3`);
      await expect(page.getByText("오늘의 업무")).toBeVisible();
      await page.waitForLoadState("networkidle");
      navigationInProgress = false;
      await capture(page, outputDir, "10-v2-redirected-to-v3", diagnostics);

      writeFileSync(
        path.join(outputDir, "diagnostics.json"),
        `${JSON.stringify(diagnostics, null, 2)}\n`,
        "utf8",
      );

      if (!ALLOW_DEFECTS) {
        expect(diagnostics.consoleErrors, "console errors").toEqual([]);
        expect(diagnostics.pageErrors, "page errors").toEqual([]);
        expect(diagnostics.requestFailures, "network request failures").toEqual([]);
        expect(diagnostics.overflow, "horizontal viewport overflow").toEqual([]);
        expect(diagnostics.contentOverflow, "workspace content overflow").toEqual([]);
        expect(diagnostics.fontFamily).toMatch(/Apple Color Emoji|Segoe UI Emoji|Noto Color Emoji/);
      }
    });
  }
}

async function capture(
  page: Page,
  outputDir: string,
  state: string,
  diagnostics: Diagnostics,
): Promise<void> {
  await page.waitForTimeout(120);
  const viewport = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  if (viewport.scrollWidth > viewport.innerWidth + 1) {
    diagnostics.overflow.push({ state, ...viewport });
  }
  const contentOverflow = await page.locator(".v3-workspace-detail, .v3-chat-pane, .v3-chat-content").evaluateAll((elements) => (
    elements.flatMap((element) => element.scrollWidth > element.clientWidth + 1
      ? [{ selector: `.${element.className.toString().trim().replace(/\s+/g, ".")}`, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }]
      : [])
  ));
  diagnostics.contentOverflow.push(...contentOverflow.map((item) => ({ state, ...item })));
  await page.screenshot({
    path: path.join(outputDir, `${state}.png`),
    fullPage: false,
    animations: "disabled",
  });
}

async function dragDivider(page: Page, ratio: number): Promise<void> {
  const workspace = await page.locator(".v3-workspace").boundingBox();
  const divider = await page.getByRole("separator", { name: "상세와 채팅 너비 조절" }).boundingBox();
  if (!workspace || !divider) throw new Error("workspace divider bounds unavailable");
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await page.mouse.down();
  await page.mouse.move(workspace.x + workspace.width * ratio, divider.y + divider.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function returnToPlanner(page: Page, viewport: "desktop" | "mobile"): Promise<void> {
  if (viewport === "mobile") {
    await page.getByTestId("v3-mobile-tab-today").click();
  } else {
    await page.getByRole("button", { name: "← 오늘로" }).click();
  }
  await expect(page.getByText("오늘의 업무")).toBeVisible();
}

function slug(label: string): string {
  return label.replace(/[^a-zA-Z0-9가-힣]+/g, "-").replace(/^-|-$/g, "");
}

function formatRequestFailure(request: Request): string {
  return `${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`;
}
