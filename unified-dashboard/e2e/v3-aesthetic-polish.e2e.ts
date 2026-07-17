import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BX_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-aesthetic-polish"),
);
const allowBaseline = process.env.PR_BX_QA_ALLOW_BASELINE === "1";

test.describe.configure({ mode: "serial" });

for (const theme of ["dark", "light"] as const) {
  test(`PR-BX aesthetic surfaces stay coherent in ${theme} mode`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
      colorScheme: theme,
      reducedMotion: "reduce",
      viewport: { width: 1600, height: 1000 },
    });
    const page = await context.newPage();
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await preparePage(page, theme);

    try {
      await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText("오늘의 업무")).toBeVisible();
      await expect(page.getByTestId("v3-task-task-alpha")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("v3-session-row-run-alpha-2")).toBeVisible();
      await capture(page, theme, "01-first-screen");

      const projectButton = page.getByTestId("v3-all-projects")
        .getByRole("button", { name: fixtureTitles.project, exact: true });
      await projectButton.evaluate((element: HTMLButtonElement) => element.click());
      await expect(page.getByRole("heading", { name: fixtureTitles.project })).toBeVisible();
      await capture(page, theme, "02-project-view");

      await page.getByRole("button", { name: "오늘로 돌아가기" }).click();
      await expect(page.getByTestId("v3-task-task-alpha")).toBeVisible();
      await page.getByTestId("v3-task-task-alpha")
        .evaluate((element: HTMLElement) => element.click());
      await expect(page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask }))
        .toBeVisible();
      await capture(page, theme, "03-task-information");

      await page.getByRole("button", { name: "보드 섹션으로 이동" }).click();
      await expect(page.getByTestId("v3-inline-board")).toBeVisible();
      await capture(page, theme, "04-task-board");

      await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).click();
      const sessionRow = page.getByTestId("v3-session-row-run-alpha-2");
      await sessionRow.locator(".v3-run-open").click();
      await expect(page.getByRole("button", { name: "세션 섹션으로 이동" }))
        .toHaveAttribute("aria-current", "location");
      await expect(page.locator('.v3-detail-scroll [data-session-id="run-alpha-2"]'))
        .toHaveClass(/is-active/);
      await capture(page, theme, "05-session-focus");

      if (!allowBaseline) {
        await assertAestheticContracts(page);
        const metrics = await collectMetrics(page);
        expect(metrics.mutedContrast).toBeGreaterThanOrEqual(4.5);
        expect(metrics.sessionFontSizes.length).toBeLessThanOrEqual(3);
        expect(metrics.taskFontSizes.length).toBeLessThanOrEqual(3);
        expect(metrics.viewportOverflow).toBeLessThanOrEqual(0);
        writeMetrics(theme, metrics);
      }
      expect(browserErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

async function preparePage(page: Page, theme: "dark" | "light") {
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
  await installV3VisualQaRoutes(page);
}

async function assertAestheticContracts(page: Page) {
  const navigation = page.getByRole("navigation", { name: "업무 섹션" });
  await expect(navigation.getByRole("button")).toHaveCount(4);
  await expect(navigation.getByRole("button").evaluateAll((buttons) => (
    buttons.map((button) => button.getAttribute("aria-label"))
  ))).resolves.toEqual([
    "정보 섹션으로 이동",
    "체크리스트 섹션으로 이동",
    "보드 섹션으로 이동",
    "세션 섹션으로 이동",
  ]);
  await expect(page.locator(".v3-detail-scroll [data-task-section]").evaluateAll((sections) => (
    sections.map((section) => section.getAttribute("data-task-section"))
  ))).resolves.toEqual(["information", "checklist", "board", "sessions"]);
  await expect(page.locator(".v3-session-panel .v3-run-row:not(.liquid-glass-card)"))
    .toHaveCount(0);
  await expect(page.locator(".v3-detail-scroll .v3-run-row:not(.liquid-glass-card)"))
    .toHaveCount(0);

  await page.getByRole("button", { name: "보드 섹션으로 이동" }).click();
  await expect(page.locator(".v3-inline-board-item:not(.liquid-glass-card)"))
    .toHaveCount(0);
}

async function collectMetrics(page: Page) {
  return page.evaluate(() => {
    const color = (value: string) => {
      const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/i.exec(value);
      if (srgb) return srgb.slice(1).map((channel) => Number(channel) * 255);
      const shortHex = /^#([\da-f])([\da-f])([\da-f])$/i.exec(value);
      if (shortHex) return shortHex.slice(1).map((channel) => Number.parseInt(`${channel}${channel}`, 16));
      const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
      if (hex) return hex.slice(1).map((channel) => Number.parseInt(channel, 16));
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) throw new Error(`색상을 해석할 수 없습니다: ${value}`);
      return channels;
    };
    const luminance = (channels: number[]) => {
      const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      });
      return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
    };
    const contrast = (first: string, second: string) => {
      const firstLuminance = luminance(color(first));
      const secondLuminance = luminance(color(second));
      return (Math.max(firstLuminance, secondLuminance) + .05)
        / (Math.min(firstLuminance, secondLuminance) + .05);
    };
    const fontSizes = (selector: string) => Array.from(new Set(
      Array.from(document.querySelectorAll<HTMLElement>(selector))
        .filter((element) => element.offsetParent !== null)
        .map((element) => getComputedStyle(element).fontSize),
    )).sort();
    const mutedSample = document.querySelector<HTMLElement>(".v3-run-agent-line");
    if (!mutedSample) throw new Error("muted 텍스트 표본을 찾지 못했습니다.");
    const muted = getComputedStyle(mutedSample).color;
    const background = getComputedStyle(document.body).backgroundColor;
    return {
      muted,
      background,
      mutedContrast: contrast(muted, background),
      sessionFontSizes: fontSizes(".v3-run-open strong, .v3-run-agent-line, .v3-run-affiliation, .v3-run-open small, .v3-run-trailing time, .v3-run-status-badge"),
      taskFontSizes: fontSizes(".v3-detail-title h2, .v3-detail-section-head, .v3-description-preview, .v3-context-chips"),
      viewportOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

function writeMetrics(theme: string, metrics: unknown) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}
