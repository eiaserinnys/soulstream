import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.V3_PARITY_OUTPUT ?? path.join("e2e", "screenshots", "v3-liquid-glass-parity"),
);
const CHROME_CLASSES = ["glass-strong", "glass-chrome", "lg-rim", "border-glass-border"];

type Theme = "dark" | "light";

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });
test.setTimeout(120_000);

for (const theme of ["dark", "light"] as const) {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ] as const) {
    test(`v1 liquid glass reference · ${theme} · ${viewport.width}px`, async ({ page }) => {
      const errors = collectErrors(page);
      await preparePage(page, theme, viewport);
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("dashboard-layout")).toBeVisible();
      await page.waitForTimeout(500);

      await expect(page.locator("[data-liquid-glass-webgl-provider=true]")).toHaveCount(1);
      if (viewport.name === "desktop") {
        await expectChromeClasses(page.getByTestId("session-panel"));
        await expect(page.getByTestId("left-navigation-feed")).toHaveCSS("font-size", "14px");
      } else {
        const mobileHeader = page.getByTestId("dashboard-layout").locator("header").first();
        await expect(mobileHeader).toHaveClass(/(?:^|\s)glass-strong(?:\s|$)/);
        await expect(mobileHeader).toHaveClass(/(?:^|\s)glass-chrome(?:\s|$)/);
        await expect(mobileHeader).toHaveClass(/(?:^|\s)border-glass-border(?:\s|$)/);
      }
      await assertNoHorizontalOverflow(page);
      await capture(page, `v1-${theme}-${viewport.width}.png`);
      expect(errors).toEqual([]);
    });

    test(`v3 liquid glass parity · ${theme} · ${viewport.width}px`, async ({ page }) => {
      const errors = collectErrors(page);
      await preparePage(page, theme, viewport);
      await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText("오늘의 업무")).toBeVisible();
      await page.waitForTimeout(500);

      await expect(page.locator("[data-liquid-glass-webgl-provider=true]")).toHaveCount(1);
      await expectChromeClasses(page.locator(".v3-navigation"));
      await expectChromeClasses(page.locator(".v3-planner"));
      await expect(page.locator(".v3-shell")).toHaveCSS(
        "font-family",
        /-apple-system|BlinkMacSystemFont|Segoe UI|Roboto/,
      );
      if (viewport.name === "desktop") {
        const navigation = page.locator(".v3-navigation");
        await expect(navigation).toHaveCSS("width", "264px");
        await expect(navigation.locator(".v3-nav-list button").first()).toHaveCSS("font-size", "14px");
      }
      await assertNoHorizontalOverflow(page);
      await capture(page, `v3-${theme}-${viewport.width}.png`);
      if (viewport.name === "desktop") {
        await resizeNavigationAndAssertPersistence(page);
      }
      expect(errors).toEqual([]);
    });
  }
}

async function resizeNavigationAndAssertPersistence(page: Page): Promise<void> {
  const handle = page.getByTestId("v3-navigation-resize-handle");
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 120);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 72, box!.y + 120, { steps: 5 });
  await page.mouse.up();

  await expect(page.locator(".v3-navigation")).toHaveCSS("width", "336px");
  await expect.poll(() => page.evaluate(() => (
    localStorage.getItem("soul-ui.dashboard.leftSidebarWidth")
  ))).toBe("336");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".v3-navigation")).toHaveCSS("width", "336px");
  await assertNoHorizontalOverflow(page);
}

async function preparePage(
  page: Page,
  theme: Theme,
  viewport: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((appearance: Theme) => {
    localStorage.setItem("soul-dashboard-theme", appearance);
    localStorage.setItem("soul-wallpaper", JSON.stringify({ mode: "bokeh" }));
    localStorage.setItem("ls.webglGlass", "1");
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
  }, theme);
  await installV3VisualQaRoutes(page);
  await page.route("**/api/runbooks/*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    if (["rb-alpha", "rb-beta", "rb-done", "rb-carry"].includes(id)) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runbook: { id, title: id, status: "open", archived: false, version: 1 },
        sections: [],
        items: [],
      }),
    });
  });
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectChromeClasses(locator: ReturnType<Page["locator"]>): Promise<void> {
  await expect(locator).toHaveCount(1);
  for (const className of CHROME_CLASSES) {
    await expect(locator).toHaveClass(new RegExp(`(?:^|\\s)${className}(?:\\s|$)`));
  }
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const sizes = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.innerWidth + 1);
}

async function capture(page: Page, filename: string): Promise<void> {
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  await page.screenshot({
    path: path.join(OUTPUT_ROOT, filename),
    fullPage: false,
    animations: "disabled",
  });
}
