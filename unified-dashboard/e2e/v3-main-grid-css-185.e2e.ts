import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1180x900", width: 1180, height: 900 },
  { name: "390x844", width: 390, height: 844 },
] as const;

test.describe.configure({ mode: "serial", timeout: 30_000 });

for (const viewport of viewports) {
  test(`production main grid ${viewport.name} survives reversed CSS order`, async ({ page }, testInfo) => {
    await prepareDashboard(page, viewport.width, viewport.height);

    const before = await measureMainGrid(page);
    assertExpectedLayout(viewport.name, before);
    await capture(page, testInfo.outputPath(`${viewport.name}-before.png`));

    const order = await reverseBuiltCssOrder(page);
    expect(order.indexCssAfterDashboardCss).toBe(true);

    const after = await measureMainGrid(page);
    expect(after).toEqual(before);
    assertExpectedLayout(viewport.name, after);
    await capture(page, testInfo.outputPath(`${viewport.name}-reversed.png`));
    await page.close();
  });
}

for (const viewport of [viewports[0], viewports[3]]) {
  test(`production connection dialog at ${viewport.name} keeps its first-failure layout`, async ({ page }, testInfo) => {
    await prepareDialogPage(page, viewport.width, viewport.height, false);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const measured = await measureDialog(page);
    expect(measured).toMatchObject(FIRST_FAILURE_DIALOG_BASELINE[viewport.width as 1440 | 390]);
    expect(measured.title.fontSize).toBe(viewport.width === 390 ? "21px" : "20px");
    expect(measured.description.fontSize).toBe(viewport.width === 390 ? "15px" : "14px");
    expect(measured.summary.padding).toBe("16px");
    expect(measured.footer.padding).toBe("12px 24px 24px");
    expect(measured.title.color).toBe(measured.summary.color);
    expect(measured.title.fontFamily).toContain("Pretendard");
    await capture(page, testInfo.outputPath(`connection-fresh-${viewport.name}.png`));
    await page.close();
  });

  test(`production connection dialog at ${viewport.name} keeps its loaded-failure styles`, async ({ page }, testInfo) => {
    await prepareDialogPage(page, viewport.width, viewport.height, true);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const measured = await measureDialog(page);
    expect(measured.title.fontSize).toBe(viewport.width === 390 ? "21px" : "20px");
    expect(measured.description.fontSize).toBe(viewport.width === 390 ? "15px" : "14px");
    expect(measured.summary.padding).toBe("16px");
    expect(measured.footer.padding).toBe("12px 24px 24px");
    expect(measured.title.color).toBe(measured.summary.color);
    expect(measured.title.fontFamily).toContain("Pretendard");
    await capture(page, testInfo.outputPath(`connection-loaded-${viewport.name}.png`));
    await page.close();
  });
}

async function prepareDashboard(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.removeItem("soul-ui.dashboard.leftSidebarWidth");
    localStorage.removeItem("soulstream-v3-session-panel-width");
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  });
  await installV3VisualQaRoutes(page);
  await page.goto("/v3", { waitUntil: "domcontentloaded" });
  await page.getByTestId("card-home").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".v3-planner").waitFor({ state: "visible", timeout: 20_000 });
}

async function measureMainGrid(page: Page) {
  return page.evaluate(() => {
    const required = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`메인 격자 측정 대상을 찾지 못했습니다: ${selector}`);
      return element;
    };
    const box = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
      };
    };
    const shell = required(".v3-shell");
    const navigation = required(".v3-navigation");
    const main = required(".v3-main");
    const planner = required(".v3-planner");
    const sessionPanel = required(".v3-session-panel");
    const navigationResize = required(".v3-navigation-resize");
    const sessionResize = required(".v3-session-panel-resize");
    return {
      viewport: { width: document.documentElement.clientWidth, height: innerHeight },
      shell: {
        display: getComputedStyle(shell).display,
        grid: getComputedStyle(shell).gridTemplateColumns,
        paddingBottom: getComputedStyle(shell).paddingBottom,
      },
      navigation: { ...box(navigation), display: getComputedStyle(navigation).display },
      main: box(main),
      planner: box(planner),
      sessionPanel: { ...box(sessionPanel), display: getComputedStyle(sessionPanel).display },
      navigationResizeDisplay: getComputedStyle(navigationResize).display,
      sessionResizeDisplay: getComputedStyle(sessionResize).display,
      documentScrollWidth: document.documentElement.scrollWidth,
    };
  });
}

function assertExpectedLayout(name: (typeof viewports)[number]["name"], layout: Awaited<ReturnType<typeof measureMainGrid>>): void {
  if (name === "1440x900") {
    expect(layout.shell).toEqual({ display: "grid", grid: "358px 16px 528px 16px 522px", paddingBottom: "0px" });
    expect(layout.navigation).toMatchObject({ x: 22, y: 76, width: 336, bottom: 878, display: "flex" });
    expect(layout.planner).toMatchObject({ x: 374, y: 76, width: 528, bottom: 878 });
    expect(layout.sessionPanel).toMatchObject({ x: 918, y: 76, width: 500, right: 1418, bottom: 878, display: "block" });
  } else if (name === "1920x1080") {
    expect(layout.shell).toEqual({ display: "grid", grid: "358px 16px 1008px 16px 522px", paddingBottom: "0px" });
    expect(layout.navigation).toMatchObject({ x: 22, y: 76, width: 336, bottom: 1058, display: "flex" });
    expect(layout.planner).toMatchObject({ x: 374, y: 76, width: 1008, bottom: 1058 });
    expect(layout.sessionPanel).toMatchObject({ x: 1398, y: 76, width: 500, right: 1898, bottom: 1058, display: "block" });
  } else if (name === "1180x900") {
    expect(layout.shell).toEqual({ display: "grid", grid: "358px 16px 384px 16px 406px", paddingBottom: "0px" });
    expect(layout.navigation).toMatchObject({ x: 22, y: 76, width: 336, bottom: 878, display: "flex" });
    expect(layout.planner).toMatchObject({ x: 374, y: 76, width: 384, bottom: 878 });
    expect(layout.sessionPanel).toMatchObject({ width: 0, display: "none" });
    expect(layout.sessionResizeDisplay).toBe("none");
  } else {
    expect(layout.shell).toEqual({ display: "block", grid: "none", paddingBottom: "58px" });
    expect(layout.navigation).toMatchObject({ width: 0, display: "none" });
    expect(layout.planner).toMatchObject({ x: 14, y: 72, width: 362, height: 698 });
    expect(layout.sessionPanel).toMatchObject({ width: 0, display: "none" });
    expect(layout.navigationResizeDisplay).toBe("none");
    expect(layout.sessionResizeDisplay).toBe("none");
  }

  if (layout.sessionPanel.display !== "none") {
    expect(layout.sessionPanel.right).toBeLessThanOrEqual(layout.viewport.width);
  }
}

async function reverseBuiltCssOrder(page: Page): Promise<{ indexCssAfterDashboardCss: boolean; order: string[] }> {
  return page.evaluate(async () => {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
    const pathOf = (link: HTMLLinkElement) => new URL(link.href).pathname;
    const indexCss = links.find((link) => /\/assets\/index-[^/]+\.css$/.test(pathOf(link)));
    const dashboardCss = links.find((link) => /\/assets\/v3-dialog-hierarchy-[^/]+\.css$/.test(pathOf(link)));
    if (!indexCss || !dashboardCss) throw new Error("production entry와 lazy dashboard CSS 링크를 찾지 못했습니다.");

    dashboardCss.after(indexCss);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const order = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map(pathOf);
    return {
      indexCssAfterDashboardCss: order.indexOf(pathOf(indexCss)) > order.indexOf(pathOf(dashboardCss)),
      order,
    };
  });
}

async function prepareDialogPage(page: Page, width: number, height: number, initiallyHealthy: boolean): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await installV3VisualQaRoutes(page);

  let healthy = initiallyHealthy;
  await page.route("**/api/health", (route) => route.fulfill({
    status: healthy ? 200 : 503,
    contentType: "application/json",
    body: JSON.stringify({ healthy, ready: true, draining: false, build_id: "dev" }),
  }));
  const firstHealth = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/health");
  await page.goto("/v3", { waitUntil: "domcontentloaded" });
  await page.getByTestId("card-home").waitFor({ state: "visible", timeout: 20_000 });
  await firstHealth;

  if (initiallyHealthy) {
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    healthy = false;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(async () => page.getByRole("dialog").count(), { timeout: 8_000 }).toBe(1);
  }
}

async function measureDialog(page: Page) {
  return page.evaluate(() => {
    const required = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`연결 안내 측정 대상을 찾지 못했습니다: ${selector}`);
      return element;
    };
    const measure = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        color: style.color,
        background: style.backgroundColor,
        padding: style.padding,
        gap: style.gap,
      };
    };
    return {
      dialog: measure(required(".approved-dialog")),
      title: measure(required('[data-slot="dialog-title"]')),
      description: measure(required('[data-slot="dialog-description"]')),
      summary: measure(required(".dialog-confirm-summary")),
      strong: measure(required(".dialog-confirm-summary strong")),
      footer: measure(required('[data-slot="dialog-footer"]')),
      buttons: document.querySelectorAll('[role="dialog"] button').length,
    };
  });
}

async function capture(page: Page, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await page.screenshot({ path: outputPath, animations: "disabled", fullPage: true });
}

const FIRST_FAILURE_DIALOG_BASELINE = {
  1440: {
    dialog: { x: 528, y: 284.5, width: 384, height: 331 },
    title: { x: 553, y: 365.5, width: 334, height: 40 },
    description: { x: 553, y: 413.5, width: 334, height: 20 },
    summary: { x: 553, y: 449.5, width: 334, height: 105 },
    strong: { x: 570, y: 466.5, width: 300, height: 21 },
    footer: { x: 529, y: 558.5, width: 382, height: 56 },
    buttons: 0,
  },
  390: {
    dialog: { x: 16, y: 268.5, width: 358, height: 363 },
    title: { x: 41, y: 349.5, width: 308, height: 42 },
    description: { x: 41, y: 399.5, width: 308, height: 44 },
    summary: { x: 41, y: 463.5, width: 308, height: 105 },
    strong: { x: 58, y: 480.5, width: 274, height: 21 },
    footer: { x: 17, y: 572.5, width: 356, height: 58 },
    buttons: 0,
  },
} as const;
