import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

// These are web host viewports, not inferred iPhone/iPad logical resolutions.
const output = path.resolve("../../.local/artifacts/20261001-ios-components-host");
const bundleIndex = "/assets/ios-components/index.html";
// Public test content only. This fixture is never shipped as an app sample.
const fixture = '<!doctype html><html lang="ko"><meta charset="utf-8"><title>공개 호스트 검증 fixture</title><body><button onclick="this.textContent=\'로컬 조작 확인\'">호스트 fixture 조작</button></body></html>';

async function prepare(page: Page, width: number) {
  mkdirSync(output, { recursive: true });
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-10-01T00:00:00Z") });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", { configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }) });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/cards?**", route => route.fulfill({ contentType: "application/json", body: '{"cards":[]}' }));
  await page.route("**/api/auth/config", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ authEnabled: true, devModeEnabled: false }) }));
  await page.route("**/api/auth/status", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } }) }));
}

async function capture(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
}

for (const width of [1440, 390]) {
  test(`web host preparation, iframe and existing routes ${width}`, async ({ page }) => {
    await prepare(page, width);
    let bundleReady = false;
    await page.route(`**${bundleIndex}`, route => route.fulfill({
      status: bundleReady ? 200 : 404, contentType: bundleReady ? "text/html" : "application/json",
      headers: { "cache-control": "no-cache" }, body: bundleReady ? fixture : '{"detail":"Not Found"}',
    }));
    await page.goto("/components");
    await expect(page.getByTestId("components-review")).toBeVisible();
    const before = await capture(page, `components-before-${width}`);

    const reads: string[] = [], writes: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (/^\/api\/(planner|sessions|folders|pages|cards|catalog)(\/|$)/.test(pathname)
        || /^\/api\/nodes(\/stream)?$/.test(pathname)) reads.push(pathname);
      if (pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())
        && !pathname.includes("ui-events")) writes.push(`${request.method()} ${pathname}`);
    });
    await page.goto(width === 1440 ? "/components/ios" : "/components/ios/");
    const review = page.getByTestId("ios-components-review");
    await expect(review).toBeVisible();
    await expect(review.getByRole("heading", { name: "소울앱 컴포넌트" })).toBeVisible();
    await expect(review.getByRole("status")).toHaveText("앱 검수 화면을 준비 중입니다");
    await expect(review.locator("iframe")).toHaveCount(0);
    await expect(page.locator(".v3-navigation, .v3-session-panel, .v3-planner, .v3-global-toolbar")).toHaveCount(0);
    await capture(page, `preparing-${width}`);
    await page.reload();
    await expect(review.getByRole("status")).toHaveText("앱 검수 화면을 준비 중입니다");

    bundleReady = true;
    await page.reload();
    const frame = review.locator("iframe");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("src", bundleIndex);
    await expect(frame).toHaveAttribute("title", "소울앱 컴포넌트 브라우저 미리보기");
    const localButton = page.frameLocator("iframe").getByRole("button", { name: "호스트 fixture 조작" });
    await localButton.click();
    await expect(page.frameLocator("iframe").getByRole("button", { name: "로컬 조작 확인" })).toBeVisible();
    const metrics = await review.evaluate(el => {
      const box = (node: Element) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
      };
      const main = el.closest("main")!, body = el.querySelector(".v3-ios-components-body")!;
      const header = el.querySelector("header")!, title = el.querySelector("h1")!, cap = el.querySelector(".dashboard-icon-cap")!;
      return { main: box(main), article: box(el), header: box(header), title: box(title), cap: box(cap),
        body: box(body), frame: box(el.querySelector("iframe")!), notice: box(body.firstElementChild!),
        viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth };
    });
    expect(metrics.main).toMatchObject({ x: 0, y: 0, width, height: 1000 });
    expect(metrics.documentWidth).toBe(width);
    expect(Math.abs(metrics.frame.x - metrics.header.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.frame.right - metrics.header.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.title.y + metrics.title.height / 2 - metrics.cap.y - metrics.cap.height / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(metrics.frame.bottom - metrics.article.bottom)).toBeLessThanOrEqual(1);
    expect(metrics.frame.y).toBeGreaterThanOrEqual(metrics.notice.bottom);
    expect(metrics.frame.height).toBeGreaterThan(0);
    await capture(page, `fixture-${width}`);
    writeFileSync(path.join(output, `metrics-${width}.json`), JSON.stringify({ metrics, reads, writes, errors }, null, 2));
    expect(reads).toEqual([]); expect(writes).toEqual([]); expect(errors).toEqual([]);
    await review.getByRole("button", { name: "컴포넌트 검수로 돌아가기" }).click();
    await expect(page).toHaveURL(/\/components$/);
    await expect(page.getByTestId("components-review")).toBeVisible();
    const after = await capture(page, `components-after-${width}`);
    expect(after.equals(before)).toBe(true);
    await page.goto("/");
    await expect(page.locator(".v3-shell")).toBeVisible();
    await expect(page.getByTestId("ios-components-review")).toHaveCount(0);
    await expect(page.getByTestId("components-review")).toHaveCount(0);
    await capture(page, `dashboard-${width}`);
  });
}

test("inherits authentication before probing the bundle on direct entry and refresh", async ({ page }) => {
  await prepare(page, 390);
  let authenticated = false, probes = 0;
  await page.route("**/api/auth/status", route => route.fulfill({ contentType: "application/json",
    body: JSON.stringify({ authenticated, user: authenticated ? { email: "qa@example.test", name: "QA" } : null }) }));
  await page.route(`**${bundleIndex}`, route => { probes++; return route.fulfill({ status: 404, body: "" }); });
  await page.goto("/components/ios");
  await expect(page.getByRole("button", { name: /Google/ })).toBeVisible();
  await expect(page.getByTestId("ios-components-review")).toHaveCount(0);
  expect(probes).toBe(0);
  await capture(page, "login-390");
  await page.reload();
  await expect(page.getByRole("button", { name: /Google/ })).toBeVisible();
  expect(probes).toBe(0);
  authenticated = true;
  await page.reload();
  await expect(page.getByTestId("ios-components-review").getByRole("status")).toBeVisible();
  expect(probes).toBeGreaterThan(0);
});
