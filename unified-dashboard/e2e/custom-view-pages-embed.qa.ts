import type { Browser, Frame, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const pagesUrl = "https://pages.eiaserinnys.me/p/2fe932cbc926/";
const pagesTitle = "caller_info 종합 cover audit — R-2 머지 후 (2026-05-11)";
const pagesHeading = "caller_info 종합 cover audit — R-2 머지 후";
const outputRoot = path.resolve(
  process.env.PR_AY_QA_OUTPUT ?? path.join("e2e", "screenshots", "custom-view-pages-embed"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-ay-custom-view-pages-embed",
  timeoutMs: 180_000,
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const diagnostics = await preparePage(page, theme);

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("v3-task-task-alpha").click();
    await page.getByRole("button", { name: /검증 현황/ }).click();

    const customView = page.getByTitle("검증 현황");
    await customView.waitFor({ state: "visible" });
    assert(await customView.getAttribute("sandbox") === "allow-scripts", "custom_view sandbox가 변경되었습니다.");

    const pagesFrame = await waitForFrame(page, pagesUrl, browserErrors);
    await pagesFrame.waitForLoadState("domcontentloaded");
    const actualTitle = await pagesFrame.title();
    assert(actualTitle === pagesTitle, `pages 문서 제목이 다릅니다: ${actualTitle}`);
    const heading = pagesFrame.locator("h1").filter({ hasText: pagesHeading });
    await heading.waitFor({ state: "visible", timeout: 30_000 });
    await heading.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1_000);
    await capture(page, pagesFrame, theme);
    assert(
      !browserErrors.some((message) => /content security policy|frame-src/i.test(message)),
      `pages iframe이 CSP로 차단되었습니다: ${browserErrors.join(" | ")}`,
    );
    assert(browserErrors.length === 0, `브라우저 오류가 발생했습니다: ${browserErrors.join(" | ")}`);
    return {
      pagesUrl: pagesFrame.url(),
      pagesTitle: actualTitle,
      pagesHeadingVisible: await heading.isVisible(),
      sandbox: await customView.getAttribute("sandbox"),
      browserErrors: browserErrors.length,
      pagesTelemetryRequests: diagnostics.pagesTelemetryRequests(),
    };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: "dark" | "light") {
  let pagesTelemetryRequestCount = 0;
  await page.addInitScript({ content: `
    if (window === window.top) {
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
    }
  ` });
  await installV3VisualQaRoutes(page);
  await page.route("https://pages.eiaserinnys.me/cdn-cgi/rum?*", async (route) => {
    pagesTelemetryRequestCount += 1;
    await route.fulfill({
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: "",
    });
  });
  await page.route("**/api/custom-views/view-inline", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "view-inline",
        boardItemId: "custom_view:view-inline",
        folderId: "folder-amber",
        title: "검증 현황",
        html: `<iframe title="pages 문서" src="${pagesUrl}" style="border:0;width:100%;height:560px"></iframe>`,
        revision: 4,
      }),
    });
  });
  return {
    pagesTelemetryRequests: () => pagesTelemetryRequestCount,
  };
}

async function waitForFrame(page: Page, url: string, browserErrors: readonly string[]) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => candidate.url() === url);
    if (frame) return frame;
    await page.waitForTimeout(100);
  }
  throw new Error(`pages iframe을 찾지 못했습니다: ${url}; console=${browserErrors.join(" | ")}`);
}

async function capture(page: Page, pagesFrame: Frame, theme: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, "01-pages-embedded.png"),
    animations: "disabled",
    fullPage: true,
  });
  await pagesFrame.locator("html").screenshot({
    path: path.join(directory, "02-pages-document.png"),
    animations: "disabled",
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
