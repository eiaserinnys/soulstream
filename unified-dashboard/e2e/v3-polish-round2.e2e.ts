import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.V3_POLISH_OUTPUT ?? path.join("e2e", "screenshots", "v3-polish-round2"),
);

type Theme = "dark" | "light";
type ButtonChrome = {
  height: string;
  borderRadius: string;
  backgroundImage: string;
  borderColor: string;
  boxShadow: string;
};

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });

for (const theme of ["dark", "light"] as const) {
  test(`v3 polish round 2 · ${theme} · desktop`, async ({ context, page }) => {
    test.setTimeout(180_000);
    const v1Page = await context.newPage();
    await preparePage(v1Page, theme, false);
    await v1Page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await expect(v1Page.getByTestId("dashboard-layout")).toBeVisible();
    await expect(v1Page.locator(".dashboard-floating-toolbar")).toBeVisible();
    await setWebgl(v1Page, true);
    await expect(v1Page.locator(".dashboard-toolbar-brand")).toHaveAttribute("data-liquid-glass-webgl", "true");
    const v1NewSession = v1Page.locator('[data-slot="button"]').filter({ hasText: "새 세션" }).first();
    await expect(v1NewSession).toBeVisible();
    const v1NewSessionChrome = await readButtonChrome(v1NewSession);
    await capture(v1Page, theme, "00-v1-dashboard-reference");
    await v1Page.close();

    await preparePage(page, theme, false);
    await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("오늘의 업무")).toBeVisible();
    await expect(page.getByTestId("v3-task-task-alpha")).toBeVisible({ timeout: 30_000 });

    await setWebgl(page, true);
    await expectGlobalToolbarChrome(page, v1NewSessionChrome);
    await capture(page, theme, "00-v3-dashboard-toolbar");

    await expect(page.locator(".v3-daily-memo")).toHaveAttribute("data-liquid-glass-webgl", "true");
    await expect(page.getByTestId("v3-task-task-alpha")).toHaveAttribute("data-liquid-glass-webgl", "true");
    await expect(page.locator(".v3-daily-memo")).toHaveCSS("border-radius", "18px");
    await expect(page.getByTestId("v3-task-task-alpha")).toHaveCSS("border-radius", "18px");
    await expect(page.locator(".v3-date-head h1")).toHaveCSS("font-weight", /7\d\d|8\d\d|900/);
    await expect(page.locator(".v3-section-head h2").first()).toHaveCSS("font-weight", /6\d\d|7\d\d|8\d\d|900/);
    await expectReviewStripSpacing(page);
    await capture(page, theme, "01-today-planner");
    await setWebgl(page, false);

    await page.getByTestId("v3-all-projects")
      .getByRole("button", { name: fixtureTitles.project, exact: true })
      .click();
    await expect(page.getByRole("heading", { name: fixtureTitles.project })).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("v3-task-task-alpha").click();
    await expect(page.getByRole("heading", { name: fixtureTitles.primaryTask, level: 2 })).toBeVisible({ timeout: 30_000 });

    const description = page.locator(".v3-description-preview");
    await expect(description).toHaveCSS("text-align", "left");
    await expect(description).toHaveCSS("align-items", "flex-start");
    await expect(description).toHaveCSS("justify-content", "flex-start");
    await expectMatchingContextControlHeight(page);
    await expect(page.getByRole("button", { name: "＋ 문서" })).toBeVisible();
    await page.getByRole("button", { name: "＋ 문서" }).click();
    await expect(page.getByRole("searchbox", { name: "페이지 검색" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "첨부할 새 페이지 제목" })).toBeVisible();
    await expect(page.getByRole("button", { name: "＋ 새 페이지 만들며 첨부" })).toBeVisible();
    await page.getByRole("button", { name: "＋ 문서" }).click();
    await expect(page.getByRole("button", { name: "재개" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /요약$/ })).toHaveCount(0);
    await setWebgl(page, true);
    await expect(page.locator(".v3-detail-pane")).toHaveAttribute("data-liquid-glass-webgl", "true");
    await capture(page, theme, "02-task-detail");
    await setWebgl(page, false);

    await closeWorkspaceFromScrim(page);
    await expect(page.getByRole("heading", { name: fixtureTitles.project })).toBeVisible();
    await page.getByTestId("v3-task-task-alpha").click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".v3-workspace-scrim")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: fixtureTitles.project })).toBeVisible();

    await page.getByTestId("v3-task-task-alpha").click();
    await page.locator(".v3-run-open").filter({ hasText: "run #2" }).click();
    await expect(page.getByRole("region", { name: "Run 채팅" })).toBeVisible();
    await setWebgl(page, true);
    const scrim = page.locator(".v3-workspace-scrim");
    await expect(scrim).toHaveCSS("backdrop-filter", /blur\(/);
    const scrimBackground = await scrim.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(scrimBackground).not.toBe("rgba(0, 0, 0, 0)");
    const chatSurface = await page.locator(".v3-chat-pane").evaluate((element) => ({
      actual: getComputedStyle(element).getPropertyValue("--glass-chrome-surface-strong").trim(),
      expected: getComputedStyle(document.documentElement).getPropertyValue("--lg-chat-panel").trim(),
    }));
    expect(chatSurface.actual).toBe(chatSurface.expected);
    await capture(page, theme, "03-chat-expanded");
  });
}

async function setWebgl(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate((nextEnabled) => {
    localStorage.setItem("ls.webglGlass", nextEnabled ? "1" : "0");
    window.dispatchEvent(new Event("ls.webglGlass:change"));
  }, enabled);
}

test("v3 global toolbar reuses live search, config, and theme controls", async ({ page }) => {
  test.setTimeout(90_000);
  await preparePage(page, "dark", false);
  await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText("오늘의 업무")).toBeVisible();
  await expectGlobalToolbarInteractions(page);
});

async function preparePage(page: Page, theme: Theme, webgl = true): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(({ appearance, webglEnabled }: { appearance: Theme; webglEnabled: boolean }) => {
    localStorage.setItem("soul-dashboard-theme", appearance);
    localStorage.setItem("ls.webglGlass", webglEnabled ? "1" : "0");
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
  }, { appearance: theme, webglEnabled: webgl });
  await installV3VisualQaRoutes(page);
}

async function expectReviewStripSpacing(page: Page): Promise<void> {
  const spacing = await page.locator(".v3-review-strip").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
    };
  });
  expect(spacing.marginTop).toBe("22px");
  expect(spacing.marginBottom).toBe("22px");
  expect(spacing.paddingTop).toBe("8px");
  expect(spacing.paddingBottom).toBe("8px");
}

async function expectGlobalToolbarChrome(page: Page, v1NewSessionChrome: ButtonChrome): Promise<void> {
  const toolbar = page.getByTestId("v3-global-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByText("Soulstream", { exact: true })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Open session search" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Open server configuration" })).toBeVisible();

  for (const name of ["아침 정리", "새 업무"]) {
    const action = toolbar.getByRole("button", { name });
    await expect(action).toHaveAttribute("data-slot", "button");
    expect(await readButtonChrome(action)).toEqual(v1NewSessionChrome);
  }

}

async function expectGlobalToolbarInteractions(page: Page): Promise<void> {
  const toolbar = page.getByTestId("v3-global-toolbar");
  await toolbar.getByRole("button", { name: "Open session search" }).click();
  await expect(page.getByRole("heading", { name: "세션 기록 검색" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("heading", { name: "세션 기록 검색" })).toBeVisible();
  await page.keyboard.press("Escape");

  await toolbar.getByRole("button", { name: "Open server configuration" }).click();
  await expect(page.getByRole("heading", { name: "⚙️ 서버 설정" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toolbar).toBeVisible();

  const html = page.locator("html");
  const wasDark = await html.evaluate((element) => element.classList.contains("dark"));
  const themeToggle = toolbar.getByRole("button", { name: /Switch to (light|dark) mode/ });
  await themeToggle.dispatchEvent("click");
  await expect.poll(() => html.evaluate((element) => element.classList.contains("dark"))).toBe(!wasDark);
  await toolbar.getByRole("button", { name: /Switch to (light|dark) mode/ }).dispatchEvent("click");
  await expect.poll(() => html.evaluate((element) => element.classList.contains("dark"))).toBe(wasDark);
}

async function readButtonChrome(locator: Locator): Promise<ButtonChrome> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: style.height,
      borderRadius: style.borderRadius,
      backgroundImage: style.backgroundImage,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
    };
  });
}

async function expectMatchingContextControlHeight(page: Page): Promise<void> {
  const heights = await page.locator(".v3-context-chips").evaluate((container) => {
    const chip = container.querySelector(":scope > span");
    const button = container.querySelector(":scope > button");
    return {
      chip: chip?.getBoundingClientRect().height ?? 0,
      button: button?.getBoundingClientRect().height ?? 0,
    };
  });
  expect(heights.chip).toBeGreaterThan(0);
  expect(Math.abs(heights.chip - heights.button)).toBeLessThanOrEqual(1);
}

async function closeWorkspaceFromScrim(page: Page): Promise<void> {
  const scrim = page.locator(".v3-workspace-scrim");
  await scrim.click({ position: { x: 8, y: 500 } });
  await expect(scrim).toHaveCount(0);
}

async function capture(page: Page, theme: Theme, state: string): Promise<void> {
  const outputDir = path.join(OUTPUT_ROOT, theme);
  mkdirSync(outputDir, { recursive: true });
  await page.screenshot({
    path: path.join(outputDir, `${state}.png`),
    fullPage: false,
    animations: "disabled",
  });
}
