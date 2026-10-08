import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

export const baselineOrigin = "https://soulstream.eiaserinnys.me";
export const currentPreviewOrigin = "http://127.0.0.1:4173";
const lazyDashboardAssetPattern = /\/assets\/(?:V3DashboardLayout|v3-dialog-hierarchy)-[^/]+\.(?:js|css)$/;
const maxLazyAssetGateMs = 5_000;
const maxSavedAssetBytes = 2_000_000;
const maxSavedAssetsTotalBytes = 8_000_000;

export type Viewport = { name: string; width: number; height: number };
export type BuildLabel = "baseline" | "current";
export type DialogMode = "first" | "loaded";

export interface BuildEvidence {
  baselineBuildSha: string;
  originMainSha: string;
  currentDistSourceSha: string;
}

interface SavedAsset {
  url: string;
  bytes: number;
  sha256: string;
  file: string;
}

interface QaPage {
  context: BrowserContext;
  page: Page;
  origin: string;
  apiRequests: string[];
  unknownApiRequests: Array<{ method: string; path: string }>;
  finishAssetCapture: () => Promise<SavedAsset[]>;
}

export async function createQaPage(
  browser: Browser,
  label: BuildLabel,
  viewport: Viewport,
  assetOutput?: string,
): Promise<QaPage> {
  const origin = label === "baseline" ? baselineOrigin : currentPreviewOrigin;
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: "dark",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  await context.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.removeItem("soul-ui.dashboard.leftSidebarWidth");
    localStorage.removeItem("soulstream-v3-session-panel-width");
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
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  });

  const page = await context.newPage();
  const apiRequests: string[] = [];
  const unknownApiRequests: Array<{ method: string; path: string }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) apiRequests.push(request.method() + " " + url.pathname + url.search);
  });
  await installV3VisualQaRoutes(page, {
    abortUnknownApiRoutes: true,
    onUnknownApiRequest: (method, path) => unknownApiRequests.push({ method, path }),
  });

  const assetTasks: Array<Promise<SavedAsset>> = [];
  let savedAssetBytes = 0;
  let seenAssetResponses = 0;
  if (assetOutput) {
    page.on("response", (response) => {
      const request = response.request();
      const url = new URL(response.url());
      if (url.origin !== origin || !url.pathname.startsWith("/assets/")
        || !["script", "stylesheet"].includes(request.resourceType())) return;
      seenAssetResponses += 1;
      assetTasks.push((async () => {
        if (seenAssetResponses > 32) throw new Error("asset capture response count exceeded its limit");
        const body = await response.body();
        if (body.byteLength > maxSavedAssetBytes) throw new Error("asset capture exceeded its per-file byte limit");
        savedAssetBytes += body.byteLength;
        if (savedAssetBytes > maxSavedAssetsTotalBytes) throw new Error("asset capture exceeded its total byte limit");
        const sha256 = createHash("sha256").update(body).digest("hex");
        const file = join(assetOutput, sha256.slice(0, 12) + "-" + basename(url.pathname));
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body);
        return { url: url.pathname, bytes: body.byteLength, sha256, file };
      })());
    });
  }

  return {
    context,
    page,
    origin,
    apiRequests,
    unknownApiRequests,
    finishAssetCapture: async () => Promise.all(assetTasks),
  };
}

export async function loadDashboard(page: Page): Promise<void> {
  await page.goto("/v3", { waitUntil: "domcontentloaded" });
  await page.getByTestId("card-home").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(".v3-planner").waitFor({ state: "visible", timeout: 20_000 });
}

export async function captureDialogState(
  browser: Browser,
  label: BuildLabel,
  viewport: Viewport,
  mode: DialogMode,
  testInfo: TestInfo,
  evidence: BuildEvidence,
) {
  const session = await createQaPage(browser, label, viewport);
  let lazyGate: Awaited<ReturnType<typeof installLazyDashboardAssetGate>> | null = null;
  let healthy = mode === "loaded";
  const healthResponses: Array<{ status: number; healthy: boolean; ready: boolean }> = [];
  let initialState: {
    cardHomePresent: boolean;
    plannerPresent: boolean;
    lazyDashboardAssetsLoaded: string[];
  } | null = null;
  try {
    if (mode === "first") lazyGate = await installLazyDashboardAssetGate(session.page);
    await session.page.route("**/api/health", async (route) => {
      const status = healthy ? 200 : 503;
      const body = { healthy, ready: healthy, draining: false, build_id: "dev" };
      healthResponses.push({ status, healthy: body.healthy, ready: body.ready });
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });
    await session.page.goto("/v3", { waitUntil: "domcontentloaded" });

    if (mode === "first") {
      await expect(session.page.getByRole("dialog")).toBeVisible();
      await expect.poll(() => lazyGate!.intercepted.length, { timeout: maxLazyAssetGateMs }).toBeGreaterThan(0);
      initialState = await inspectInitialDialogState(session.page);
      expect(healthResponses[0]).toEqual({ status: 503, healthy: false, ready: false });
      expect(initialState).toMatchObject({
        cardHomePresent: false,
        plannerPresent: false,
        lazyDashboardAssetsLoaded: [],
      });
      expect(lazyGate!.expired()).toBe(false);
    } else {
      await session.page.getByTestId("card-home").waitFor({ state: "visible", timeout: 20_000 });
      await session.page.locator(".v3-planner").waitFor({ state: "visible", timeout: 20_000 });
      expect(healthResponses[0]).toEqual({ status: 200, healthy: true, ready: true });
      healthy = false;
      await session.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect.poll(() => healthResponses.some((response) => response.status === 503), { timeout: 8_000 }).toBe(true);
      await expect(session.page.getByRole("dialog")).toBeVisible();
      initialState = await inspectInitialDialogState(session.page);
      expect(initialState).toMatchObject({ cardHomePresent: true, plannerPresent: true });
    }

    const measurement = await measureDialog(session.page);
    expect(session.unknownApiRequests).toEqual([]);
    const imagePath = testInfo.outputPath("connection-" + mode + "-" + label + "-" + viewport.name + ".png");
    await capture(session.page, imagePath);
    const result = {
      label,
      origin: session.origin,
      viewport,
      mode,
      baselineBuildSha: evidence.baselineBuildSha,
      currentDistSourceSha: label === "current" ? evidence.currentDistSourceSha : null,
      apiFixture: "installV3VisualQaRoutes; unknown API routes abort",
      healthResponses,
      apiRequests: session.apiRequests.slice().sort(),
      unknownApiRequests: session.unknownApiRequests,
      initialState,
      lazyGatePaths: lazyGate?.intercepted ?? [],
      lazyGateExpired: lazyGate?.expired() ?? false,
      measurement,
      screenshot: imagePath,
    };
    await writeJson(testInfo.outputPath("connection-" + mode + "-" + label + "-" + viewport.name + ".json"), result);
    return result;
  } finally {
    lazyGate?.release();
    await session.context.close();
  }
}

export async function installLazyDashboardAssetGate(page: Page) {
  let releasePromise: () => void = () => undefined;
  let expired = false;
  const gatePromise = new Promise<void>((resolve) => { releasePromise = resolve; });
  const intercepted: string[] = [];
  await page.route(lazyDashboardAssetPattern, async (route) => {
    intercepted.push(new URL(route.request().url()).pathname);
    await gatePromise;
    await route.continue();
  });
  const timer = setTimeout(() => {
    expired = true;
    releasePromise();
  }, maxLazyAssetGateMs);
  return {
    intercepted,
    expired: () => expired,
    release: () => {
      clearTimeout(timer);
      releasePromise();
    },
  };
}

export async function inspectInitialDialogState(page: Page) {
  return page.evaluate(() => {
    const isLazyAsset = (value: string) => /\/assets\/(?:V3DashboardLayout|v3-dialog-hierarchy)-[^/]+\.(?:js|css)$/.test(value);
    const loadedStylesheets = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
      .filter((link) => link.sheet !== null)
      .map((link) => new URL(link.href).pathname);
    const lazyDashboardAssetsLoaded = [
      ...loadedStylesheets,
      ...performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname),
    ].filter(isLazyAsset);
    return {
      cardHomePresent: document.querySelector('[data-testid="card-home"]') !== null,
      plannerPresent: document.querySelector(".v3-planner") !== null,
      lazyDashboardAssetsLoaded,
    };
  });
}

export async function measureMainGrid(page: Page) {
  return page.evaluate(() => {
    const required = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error("메인 격자 측정 대상을 찾지 못했습니다: " + selector);
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

export async function measureDashboardVisuals(page: Page) {
  return page.evaluate(() => {
    const selectors = [
      ".v3-shell",
      ".v3-navigation",
      ".v3-main",
      ".v3-planner",
      ".v3-session-panel",
      ".v3-navigation-resize",
      ".v3-session-panel-resize",
    ];
    const styleProperties = [
      "display", "position", "gridTemplateColumns", "width", "height", "minWidth", "minHeight",
      "padding", "margin", "gap", "rowGap", "columnGap", "fontFamily", "fontSize", "fontWeight",
      "lineHeight", "color", "backgroundColor", "borderRadius", "boxSizing",
    ] as const;
    const box = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
    };
    const styles = (element: HTMLElement) => {
      const computed = getComputedStyle(element);
      return Object.fromEntries(styleProperties.map((property) => [property, computed[property]]));
    };
    const roots = Object.fromEntries(selectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      return [selector, element ? { box: box(element), style: styles(element) } : null];
    }));
    const shell = document.querySelector<HTMLElement>(".v3-shell");
    if (!shell) throw new Error("메인 화면 측정 대상을 찾지 못했습니다.");
    const visibleText = Array.from(shell.querySelectorAll<HTMLElement>("*"))
      .filter((element) => element instanceof HTMLElement && element.children.length === 0
        && Boolean(element.textContent?.trim()))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none"
          && style.visibility !== "hidden" && style.opacity !== "0";
      })
      .map((element) => ({
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className : "",
        text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160),
        box: box(element),
        style: styles(element),
      }));
    return { roots, visibleText };
  });
}

export async function measureStylesheetOrder(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
    .map((link) => {
      const path = new URL(link.href).pathname;
      const basename = path.split("/").pop() ?? path;
      return {
        role: path.includes("/assets/index-") ? "entry" : path.includes("/assets/v3-dialog-hierarchy-") ? "lazy-dashboard" : basename,
        path,
      };
    }));
}

export function assertExpectedLayout(name: Viewport["name"], layout: Awaited<ReturnType<typeof measureMainGrid>>): void {
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
    expect(layout.shell).toEqual({
      display: "block",
      grid: "242px 16px minmax(0px, 1fr) 16px 322px",
      paddingBottom: "58px",
    });
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

export async function reverseBuiltCssOrder(page: Page): Promise<{ indexCssAfterDashboardCss: boolean; order: string[] }> {
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

export async function measureDialog(page: Page) {
  return page.evaluate(() => {
    const required = (selector: string): HTMLElement => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error("연결 안내 측정 대상을 찾지 못했습니다: " + selector);
      return element;
    };
    const styleProperties = [
      "display", "position", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight",
      "color", "backgroundColor", "padding", "margin", "gap", "borderRadius", "boxSizing",
    ] as const;
    const measure = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      const computed = getComputedStyle(element);
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        style: Object.fromEntries(styleProperties.map((property) => [property, computed[property]])),
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

export async function capture(page: Page, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await page.screenshot({ path: outputPath, animations: "disabled", fullPage: true });
}

export async function writeJson(outputPath: string, value: unknown): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(value, null, 2) + "\n", "utf8");
}
