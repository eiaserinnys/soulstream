import type { Browser, BrowserContext, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BF_QA_OUTPUT ?? "/home/eias/workspace/.local/artifacts/main-pane-width-261006/web",
);

const result = await runPlaywrightLifecycle({
  lockName: "v3-main-columns-free-resize",
  timeoutMs: 180_000,
}, async ({ browser }) => verifyColumns(browser));

console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;

async function verifyColumns(browser: Browser) {
  const defaultDashboard = await openDashboard(browser, 1440, 900);
  try {
    const defaults = await measureLayout(defaultDashboard.page);
    assertLayout(defaults, { navigationWidth: 336, sessionPanelWidth: 500, contentWidth: 528 });
    await capture(defaultDashboard.page, "01-default-1440x900");
    assertNoHorizontalOverflow(await measureOverflowSurfaces(defaultDashboard.page), "기본 화면");
  } finally {
    await defaultDashboard.context.close();
  }

  const maximumNavigation = await openDashboard(browser, 1440, 900);
  try {
    await dragBy(maximumNavigation.page, "v3-navigation-resize-handle", 260);
    const layout = await measureLayout(maximumNavigation.page);
    assertLayout(layout, { navigationWidth: 544, sessionPanelWidth: 500, contentWidth: 320 });
    await capture(maximumNavigation.page, "02-navigation-max-home-1440x900");
    const gate = await inspectMinimumContent(maximumNavigation.page, "home", layout);
    if (!gate.passed) {
      const probes = await probeMinimumContent(browser, "home");
      return { passed: false, stopCondition: gate, probes };
    }
    await assertPersisted(maximumNavigation.page, 544, 500);
    await maximumNavigation.page.reload({ waitUntil: "domcontentloaded" });
    await maximumNavigation.page.getByTestId("v3-session-panel").waitFor({ state: "visible" });
    await maximumNavigation.page.getByTestId("card-home").waitFor({ state: "visible" });
    assertLayout(await measureLayout(maximumNavigation.page), {
      navigationWidth: 544,
      sessionPanelWidth: 500,
      contentWidth: 320,
    });
  } finally {
    await maximumNavigation.context.close();
  }

  const folderAtMaximum = await openDashboard(browser, 1440, 900);
  try {
    await dragBy(folderAtMaximum.page, "v3-navigation-resize-handle", 260);
    await openFixtureFolderSession(folderAtMaximum.page);
    const layout = await measureLayout(folderAtMaximum.page);
    assertLayout(layout, { navigationWidth: 544, sessionPanelWidth: 500, contentWidth: 320 });
    await capture(folderAtMaximum.page, "03-navigation-max-folder-open-1440x900");
    const gate = await inspectMinimumContent(folderAtMaximum.page, "folder", layout);
    if (!gate.passed) {
      const probes = await probeMinimumContent(browser, "folder");
      return { passed: false, stopCondition: gate, probes };
    }
    assertNoPageErrors(folderAtMaximum.pageErrors);
  } finally {
    await folderAtMaximum.context.close();
  }

  const feedMaximum = await openDashboard(browser, 1440, 900);
  try {
    await dragBy(feedMaximum.page, "v3-session-panel-resize-handle", -260);
    const layout = await measureLayout(feedMaximum.page);
    assertLayout(layout, { navigationWidth: 336, sessionPanelWidth: 708, contentWidth: 320 });
    await capture(feedMaximum.page, "04-feed-max-1440x900");
    assertNoHorizontalOverflow(await measureOverflowSurfaces(feedMaximum.page), "피드 최대 화면");
    assertPersisted(feedMaximum.page, 336, 708);
  } finally {
    await feedMaximum.context.close();
  }

  const minimumColumns = await openDashboard(browser, 1440, 900);
  try {
    await dragBy(minimumColumns.page, "v3-navigation-resize-handle", -200);
    await dragBy(minimumColumns.page, "v3-session-panel-resize-handle", 300);
    const layout = await measureLayout(minimumColumns.page);
    assertLayout(layout, { navigationWidth: 220, sessionPanelWidth: 240, contentWidth: 584 });
    await capture(minimumColumns.page, "05-both-min-1440x900");
    assertNoHorizontalOverflow(await measureOverflowSurfaces(minimumColumns.page), "두 칸 최소 화면");
    assertPersisted(minimumColumns.page, 220, 240);
  } finally {
    await minimumColumns.context.close();
  }

  const wideFeed = await openDashboard(browser, 1920, 1080);
  try {
    await dragBy(wideFeed.page, "v3-session-panel-resize-handle", -300);
    const layout = await measureLayout(wideFeed.page);
    assertLayout(layout, { navigationWidth: 336, sessionPanelWidth: 800, contentWidth: 708 });
    await capture(wideFeed.page, "06-feed-800-1920x1080");
    assertNoHorizontalOverflow(await measureOverflowSurfaces(wideFeed.page), "1920 화면");
  } finally {
    await wideFeed.context.close();
  }

  const defaultFolderWorkspace = await openDashboard(browser, 1440, 900);
  try {
    await openFixtureFolderSession(defaultFolderWorkspace.page);
    assertLayout(await measureLayout(defaultFolderWorkspace.page), {
      navigationWidth: 336,
      sessionPanelWidth: 500,
      contentWidth: 528,
    });
    await capture(defaultFolderWorkspace.page, "07-default-folder-workspace-chat-1440x900");
    assertNoHorizontalOverflow(await measureOverflowSurfaces(defaultFolderWorkspace.page), "기본 폴더 작업 겹침 화면");
    assertNoPageErrors(defaultFolderWorkspace.pageErrors);
  } finally {
    await defaultFolderWorkspace.context.close();
  }

  const savedNarrow = await openDashboard(browser, 1200, 900, { navigationWidth: 400, sessionPanelWidth: 900 });
  try {
    const layout = await measureLayout(savedNarrow.page);
    assertLayout(layout, { navigationWidth: 400, sessionPanelWidth: 404, contentWidth: 320 });
    assertNoHorizontalOverflow(await measureOverflowSurfaces(savedNarrow.page), "저장 폭이 좁은 화면에 맞지 않는 상태");
  } finally {
    await savedNarrow.context.close();
  }

  const savedWidths = await openDashboard(browser, 1440, 900, { navigationWidth: 400, sessionPanelWidth: 900 });
  try {
    assertLayout(await measureLayout(savedWidths.page), {
      navigationWidth: 400,
      sessionPanelWidth: 644,
      contentWidth: 320,
    });
    await dragBy(savedWidths.page, "v3-navigation-resize-handle", -100);
    const afterDrag = await measureLayout(savedWidths.page);
    assertLayout(afterDrag, { navigationWidth: 300, sessionPanelWidth: 644, contentWidth: 420 });
    assertPersisted(savedWidths.page, 300, 644);
    assertNoHorizontalOverflow(await measureOverflowSurfaces(savedWidths.page), "한 칸 드래그 뒤 반대편 폭 고정 화면");
  } finally {
    await savedWidths.context.close();
  }

  return {
    passed: true,
    default1440: defaults,
    navigationMaximum: { navigationWidth: 544, contentWidth: 320 },
    feedMaximum: { sessionPanelWidth: 708, contentWidth: 320 },
    minimumColumns: { navigationWidth: 220, sessionPanelWidth: 240 },
    wideFeed: { sessionPanelWidth: 800 },
    narrowSavedWidths: { navigationWidth: 400, sessionPanelWidth: 404, contentWidth: 320 },
    oppositeColumnFrozen: { navigationWidth: 300, sessionPanelWidth: 644, contentWidth: 420 },
    screenshots: outputRoot,
  };
}

async function openDashboard(
  browser: Browser,
  width: number,
  height: number,
  savedWidths?: { navigationWidth: number; sessionPanelWidth: number },
): Promise<{ context: BrowserContext; page: Page; pageErrors: string[] }> {
  const context = await browser.newContext({
    colorScheme: "dark",
    reducedMotion: "reduce",
    viewport: { width, height },
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const savedWidthsInit = savedWidths ? `
    localStorage.setItem("soul-ui.dashboard.leftSidebarWidth", "${savedWidths.navigationWidth}");
    localStorage.setItem("soulstream-v3-session-panel-width", "${savedWidths.sessionPanelWidth}");
  ` : "";
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    ${savedWidthsInit}
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page);
  await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("v3-session-panel").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("card-home").waitFor({ state: "visible", timeout: 20_000 });
  return { context, page, pageErrors };
}

async function openFixtureFolderSession(page: Page): Promise<void> {
  await page.locator('[data-session-id="run-alpha-2"]').click();
  await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask }).first().waitFor({ state: "visible" });
  await page.locator('.v3-chat-pane[aria-label="세션 채팅"]').waitFor({ state: "visible" });
}

async function dragBy(page: Page, testId: string, deltaPx: number): Promise<void> {
  const handle = page.getByTestId(testId).locator(":scope > div");
  const box = await handle.boundingBox();
  assert(box !== null, `${testId} 손잡이 위치를 읽지 못했습니다.`);
  const current = await measureLayout(page);
  const budget = current.viewportWidth - 44 - 32 - 320;
  const expectedWidth = testId === "v3-navigation-resize-handle"
    ? Math.max(220, Math.min(current.navigationWidth + deltaPx, Math.max(220, budget - current.sessionPanelWidth)))
    : Math.max(240, Math.min(current.sessionPanelWidth - deltaPx, Math.max(240, budget - current.navigationWidth)));
  const startX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(startX, centerY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaPx, centerY, { steps: Math.max(1, Math.ceil(Math.abs(deltaPx) / 32)) });
  await page.mouse.up();
  await page.waitForFunction(({ testId: targetId, expectedWidth }) => {
    const element = targetId === "v3-navigation-resize-handle"
      ? document.querySelector<HTMLElement>(".v3-navigation")
      : document.querySelector<HTMLElement>('[data-testid="v3-session-panel"]');
    return element !== null && Math.abs(element.getBoundingClientRect().width - expectedWidth) <= 1;
  }, {
    testId,
    expectedWidth,
  }, { timeout: 8_000 });
}

async function measureLayout(page: Page) {
  return page.evaluate(() => {
    const navigation = document.querySelector<HTMLElement>(".v3-navigation");
    const main = document.querySelector<HTMLElement>(".v3-main");
    const panel = document.querySelector<HTMLElement>('[data-testid="v3-session-panel"]');
    if (!navigation || !main || !panel) throw new Error("메인 3열 측정 대상을 찾지 못했습니다.");
    const navigationBox = navigation.getBoundingClientRect();
    const mainBox = main.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    return {
      navigationWidth: navigationBox.width,
      contentWidth: mainBox.width,
      sessionPanelWidth: panelBox.width,
      leftGap: mainBox.left - navigationBox.right,
      rightGap: panelBox.left - mainBox.right,
      viewportWidth: document.documentElement.clientWidth,
      viewportScrollWidth: document.documentElement.scrollWidth,
    };
  });
}

async function measureOverflowSurfaces(page: Page) {
  return page.evaluate(() => {
    const planner = document.querySelector<HTMLElement>(".v3-planner-scroll");
    const header = planner?.querySelector<HTMLElement>(".v3-folder-header, .v3-detail-section-head");
    const composer = document.querySelector<HTMLElement>('[data-slot="chat-input-composer"]');
    return [
      planner ? { name: ".v3-planner-scroll", scrollWidth: planner.scrollWidth, clientWidth: planner.clientWidth } : null,
      header ? { name: "planner header row", scrollWidth: header.scrollWidth, clientWidth: header.clientWidth } : null,
      composer ? { name: "bottom input row", scrollWidth: composer.scrollWidth, clientWidth: composer.clientWidth } : null,
    ].filter((item): item is { name: string; scrollWidth: number; clientWidth: number } => item !== null);
  });
}

async function inspectMinimumContent(
  page: Page,
  surface: "home" | "folder",
  layout: Awaited<ReturnType<typeof measureLayout>>,
): Promise<{ passed: boolean; surface: string; layout: Awaited<ReturnType<typeof measureLayout>>; overflowSurfaces: Awaited<ReturnType<typeof measureOverflowSurfaces>> }> {
  const overflowSurfaces = await measureOverflowSurfaces(page);
  assert(overflowSurfaces.length >= (surface === "home" ? 3 : 2), `${surface} 폭 검사 대상이 누락됐습니다: ${JSON.stringify(overflowSurfaces)}`);
  const failed = overflowSurfaces.filter((item) => item.scrollWidth > item.clientWidth);
  return { passed: failed.length === 0, surface, layout, overflowSurfaces };
}

async function probeMinimumContent(browser: Browser, surface: "home" | "folder") {
  const measurements = [];
  for (const contentWidth of [360, 400, 440]) {
    const dashboard = await openDashboard(browser, 1440, 900);
    try {
      await dragBy(dashboard.page, "v3-navigation-resize-handle", -200);
      const sessionWidth = 1044 - 220 - contentWidth;
      await dragBy(dashboard.page, "v3-session-panel-resize-handle", 500 - sessionWidth);
      if (surface === "folder") await openFixtureFolderSession(dashboard.page);
      const layout = await measureLayout(dashboard.page);
      const overflowSurfaces = await measureOverflowSurfaces(dashboard.page);
      await capture(dashboard.page, `stop-${surface}-content-${contentWidth}-1440x900`);
      measurements.push({ contentWidth, layout, overflowSurfaces });
    } finally {
      await dashboard.context.close();
    }
  }
  return measurements;
}

function assertLayout(
  layout: Awaited<ReturnType<typeof measureLayout>>,
  expected: { navigationWidth: number; sessionPanelWidth: number; contentWidth: number },
): void {
  assert(Math.abs(layout.navigationWidth - expected.navigationWidth) <= 1, `왼쪽 폭 ${layout.navigationWidth}px, 기대 ${expected.navigationWidth}px`);
  assert(Math.abs(layout.sessionPanelWidth - expected.sessionPanelWidth) <= 1, `피드 폭 ${layout.sessionPanelWidth}px, 기대 ${expected.sessionPanelWidth}px`);
  assert(Math.abs(layout.contentWidth - expected.contentWidth) <= 1, `가운데 폭 ${layout.contentWidth}px, 기대 ${expected.contentWidth}px`);
  assert(layout.viewportScrollWidth <= layout.viewportWidth, `화면 가로 넘침 ${layout.viewportScrollWidth - layout.viewportWidth}px`);
  assert(Math.abs(layout.leftGap - 16) <= 1, `왼쪽 칸 사이 간격 ${layout.leftGap}px`);
  assert(Math.abs(layout.rightGap - 16) <= 1, `오른쪽 칸 사이 간격 ${layout.rightGap}px`);
}

function assertNoHorizontalOverflow(
  overflowSurfaces: Awaited<ReturnType<typeof measureOverflowSurfaces>>,
  state: string,
): void {
  const failed = overflowSurfaces.filter((item) => item.scrollWidth > item.clientWidth);
  assert(failed.length === 0, `${state} 넘침: ${JSON.stringify(failed)}`);
}

async function assertPersisted(page: Page, navigationWidth: number, sessionPanelWidth: number): Promise<void> {
  const stored = await page.evaluate(() => ({
    navigationWidth: localStorage.getItem("soul-ui.dashboard.leftSidebarWidth"),
    sessionPanelWidth: localStorage.getItem("soulstream-v3-session-panel-width"),
  }));
  assert(stored.navigationWidth === String(navigationWidth), `저장된 왼쪽 폭 ${stored.navigationWidth}, 기대 ${navigationWidth}`);
  assert(stored.sessionPanelWidth === String(sessionPanelWidth), `저장된 피드 폭 ${stored.sessionPanelWidth}, 기대 ${sessionPanelWidth}`);
}

function assertNoPageErrors(errors: string[]): void {
  assert(errors.length === 0, `브라우저 오류: ${errors.join(" | ")}`);
}

async function capture(page: Page, name: string): Promise<void> {
  mkdirSync(outputRoot, { recursive: true });
  await page.screenshot({
    path: path.join(outputRoot, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
