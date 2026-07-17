import type { Browser, Locator, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Mode = "before" | "after";
type Theme = "dark" | "light";

const mode = requiredVariant<Mode>(process.env.PR_CH_QA_MODE, ["before", "after"], "PR_CH_QA_MODE");
const strict = mode === "after";
const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CH_QA_OUTPUT ?? path.join("e2e", "evidence", "pr-ch-post-deploy-defects"),
);

const result = await runPlaywrightLifecycle({
  lockName: `pr-ch-post-deploy-defects-${mode}`,
  timeoutMs: 240_000,
  launchOptions: { headless: true, args: ["--disable-dev-shm-usage"] },
}, async ({ browser }) => {
  const themes = [];
  for (const theme of ["dark", "light"] as const) {
    themes.push({
      theme,
      desktop: await verifyDesktop(browser, theme),
      mobile: await verifyMobile(browser, theme),
    });
  }
  return { themes };
});

writeMetrics(result);
console.log(JSON.stringify({ ok: true, mode, strict, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyDesktop(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  installDiagnostics(page, browserErrors);
  let runbookReads = 0;
  let runHistoryReads = 0;

  try {
    await preparePage(page, theme, {
      alphaRunHistoryPages: true,
      onRunHistoryRequest: (count) => { runHistoryReads = count; },
    });
    await page.route("**/api/runbooks/rb-alpha", async (route) => {
      runbookReads += 1;
      if (runbookReads === 1) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ detail: "creation projection pending" }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("v3-task-task-alpha").click();
    await page.locator(".v3-detail-scroll").waitFor({ state: "visible", timeout: 30_000 });
    const checklist = page.getByTestId("v3-task-runbook-checklist");
    await checklist.waitFor({ state: "visible" });
    if (strict) {
      await checklist.getByRole("button", { name: "섹션 추가", exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
    } else {
      await checklist.getByText("런북을 찾을 수 없음", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    }
    await capture(page, theme, "desktop-runbook-race");

    const loadMore = page.getByTestId("v3-load-more-runs");
    await loadMore.waitFor({ state: "visible" });
    await loadMore.scrollIntoViewIfNeeded();
    const scroller = page.locator(".v3-detail-scroll");
    const runSection = page.locator("section.v3-runs");
    const firstRun = runSection.locator(".v3-run-row").first();
    const visibleRunRowsBefore = await runSection.locator(".v3-run-row").count();
    await firstRun.evaluate((element) => element.setAttribute("data-pr-ch-stable", "true"));
    await scroller.evaluate((element) => {
      element.scrollTop = Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + 48);
    });
    const scrollTopBefore = await scroller.evaluate((element) => element.scrollTop);
    const centerDelta = await horizontalCenterDelta(loadMore, runSection);
    await capture(page, theme, "desktop-load-more-before");

    await loadMore.click();
    await page.getByText("2회", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const scrollTopAfter = await scroller.evaluate((element) => element.scrollTop);
    const stableNodeCount = await runSection.locator('[data-pr-ch-stable="true"]').count();
    const visibleRunRowsAfter = await runSection.locator(".v3-run-row").count();
    await capture(page, theme, "desktop-load-more-after");

    if (strict) {
      assert(runbookReads >= 2, `${theme}: 생성 직후 404 뒤 런북을 재조회하지 않았습니다.`);
      assert(await checklist.getByText("런북을 찾을 수 없음", { exact: true }).count() === 0, `${theme}: 정상 투영 지연이 부재 오류로 남았습니다.`);
      assert(centerDelta <= 2, `${theme}: 더 보기 버튼 중앙 오차가 큽니다: ${centerDelta}px`);
      assert(Math.abs(scrollTopAfter - scrollTopBefore) <= 1, `${theme}: 더 보기 뒤 스크롤이 이동했습니다: ${scrollTopBefore} → ${scrollTopAfter}`);
      assert(stableNodeCount === 1, `${theme}: 기존 세션 행 DOM identity가 교체되었습니다.`);
      assert(visibleRunRowsAfter === visibleRunRowsBefore + 1, `${theme}: 세션 행이 이어 붙지 않았습니다: ${visibleRunRowsBefore} → ${visibleRunRowsAfter}`);
      assert(runHistoryReads === 2, `${theme}: 다음 세션 페이지 요청 수가 다릅니다: ${runHistoryReads}`);
      assert(await page.getByTestId("v3-load-more-runs").count() === 0, `${theme}: 마지막 페이지 뒤 더 보기 버튼이 남았습니다.`);
    }
    const unexpectedBrowserErrors = browserErrors.filter(
      (message) => message !== "Failed to load resource: the server responded with a status of 404 (Not Found)",
    );
    assert(unexpectedBrowserErrors.length === 0, `${theme}: 브라우저 오류: ${unexpectedBrowserErrors.join(" | ")}`);

    return {
      runbookReads,
      runbookRecovered: await checklist.getByRole("button", { name: "섹션 추가", exact: true }).count() > 0,
      centerDelta,
      scrollTopBefore,
      scrollTopAfter,
      stableNodeCount,
      visibleRunRowsBefore,
      visibleRunRowsAfter,
      runHistoryReads,
      expectedProjection404s: browserErrors.length - unexpectedBrowserErrors.length,
    };
  } finally {
    await context.close();
  }
}

async function verifyMobile(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 390, height: 500 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  installDiagnostics(page, browserErrors);

  try {
    await preparePage(page, theme, {
      contextChainPreview: true,
      successionPickerRuns: true,
    });
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("button", { name: "새 업무", exact: true }).click();
    await page.getByLabel("프로젝트 선택").selectOption("folder-dashboard");
    const newTaskDialog = page.getByRole("dialog", { name: "새 업무" });
    await newTaskDialog.waitFor({ state: "visible" });
    const newTask = await dialogMetrics(newTaskDialog);
    await capture(page, theme, "mobile-new-task");
    await page.getByRole("button", { name: "취소", exact: true }).click();

    await page.getByTestId("v3-task-task-alpha").click();
    await page.locator(".v3-detail-scroll").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: "새 세션", exact: true }).click();
    const newSessionDialog = page.getByRole("dialog", { name: "새 세션" });
    await newSessionDialog.waitFor({ state: "visible" });
    const newSession = await dialogMetrics(newSessionDialog);
    await capture(page, theme, "mobile-new-session");

    if (strict) {
      assertDialogContract(theme, "새 업무", newTask);
      assertDialogContract(theme, "새 세션", newSession);
    }
    assert(browserErrors.length === 0, `${theme} 모바일: 브라우저 오류: ${browserErrors.join(" | ")}`);
    return { viewport: { width: 390, height: 500 }, newTask, newSession };
  } finally {
    await context.close();
  }
}

async function dialogMetrics(dialog: Locator) {
  const panelViewport = dialog.locator('[data-slot="dialog-panel-scroll"], [data-slot="scroll-area-viewport"]').first();
  await panelViewport.waitFor({ state: "attached" });
  return dialog.evaluate((popup) => {
    const viewport = popup.querySelector<HTMLElement>(
      '[data-slot="dialog-panel-scroll"], [data-slot="scroll-area-viewport"]',
    );
    if (!viewport) throw new Error("다이얼로그 내부 스크롤 viewport를 찾지 못했습니다.");
    const rect = popup.getBoundingClientRect();
    const initialScrollTop = viewport.scrollTop;
    viewport.scrollTop = Math.min(80, viewport.scrollHeight - viewport.clientHeight);
    const scrolledTop = viewport.scrollTop;
    viewport.scrollTop = initialScrollTop;
    return {
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
      viewportHeight: window.innerHeight,
      maxHeight: getComputedStyle(popup).maxHeight,
      overflow: getComputedStyle(popup).overflow,
      panelClientHeight: viewport.clientHeight,
      panelScrollHeight: viewport.scrollHeight,
      scrolledTop,
      popupChildren: Array.from(popup.children).map((candidate) => {
        const element = candidate as HTMLElement;
        const elementRect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          slot: element.dataset.slot ?? null,
          className: element.className,
          top: elementRect.top,
          bottom: elementRect.bottom,
          height: elementRect.height,
          computedHeight: style.height,
          minHeight: style.minHeight,
          overflow: style.overflow,
          flex: style.flex,
        };
      }),
    };
  });
}

function assertDialogContract(theme: Theme, label: string, metrics: Awaited<ReturnType<typeof dialogMetrics>>) {
  assert(metrics.top >= -1, `${theme} ${label}: 다이얼로그 위가 뷰포트를 벗어났습니다: ${metrics.top}`);
  assert(metrics.bottom <= metrics.viewportHeight + 1, `${theme} ${label}: 다이얼로그 아래가 뷰포트를 벗어났습니다: ${metrics.bottom}`);
  assert(metrics.maxHeight !== "none", `${theme} ${label}: dvh 최대 높이가 적용되지 않았습니다.`);
  assert(metrics.overflow === "hidden", `${theme} ${label}: popup overflow가 hidden이 아닙니다: ${metrics.overflow}`);
  assert(metrics.panelClientHeight >= 80, `${theme} ${label}: 내부 스크롤 영역이 가시 높이를 잃었습니다: ${metrics.panelClientHeight}px`);
  assert(metrics.panelScrollHeight > metrics.panelClientHeight, `${theme} ${label}: 작은 뷰포트에서 내부 overflow가 만들어지지 않았습니다: ${JSON.stringify(metrics)}`);
  assert(metrics.scrolledTop > 0, `${theme} ${label}: 내부 스크롤이 움직이지 않습니다.`);
}

async function preparePage(
  page: Page,
  theme: Theme,
  options: Parameters<typeof installV3VisualQaRoutes>[1],
) {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page, options);
}

function installDiagnostics(page: Page, browserErrors: string[]) {
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
}

async function horizontalCenterDelta(target: Locator, container: Locator): Promise<number> {
  const [targetBox, containerBox] = await Promise.all([target.boundingBox(), container.boundingBox()]);
  if (!targetBox || !containerBox) throw new Error("더 보기 버튼 중앙 정렬 측정 대상을 찾지 못했습니다.");
  return Math.abs(
    (targetBox.x + targetBox.width / 2) - (containerBox.x + containerBox.width / 2),
  );
}

async function capture(page: Page, theme: Theme, name: string) {
  const directory = path.join(outputRoot, mode, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
    fullPage: false,
  });
}

function writeMetrics(metrics: unknown) {
  const directory = path.join(outputRoot, mode);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

function requiredVariant<T extends string>(value: string | undefined, options: readonly T[], name: string): T {
  if (value && options.includes(value as T)) return value as T;
  throw new Error(`${name}은 ${options.join(" 또는 ")}여야 합니다.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
