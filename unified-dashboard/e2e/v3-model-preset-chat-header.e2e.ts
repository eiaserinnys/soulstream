import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.MODEL_PRESET_QA_OUTPUT
    ?? path.join("e2e", "screenshots", "v3-model-preset-chat-header"),
);

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });

for (const theme of ["dark", "light"] as const) {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1000 },
    { name: "mobile", width: 390, height: 844 },
  ] as const) {
    test(`selected model preset in chat header · ${theme} · ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await disableServiceWorker(page, theme);
      await installV3VisualQaRoutes(page, {
        sessionModelPresets: { "run-alpha-2": "qa-standard" },
      });

      await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("v3-task-task-alpha").click();
      const taskRuns = page.locator(".v3-detail-pane .v3-run-open");
      await taskRuns.filter({ hasText: "시각 QA 순회" }).click();

      const badge = page.getByTestId("session-model-preset");
      await expect(badge).toHaveText("QA 표준 모델");
      await expect(badge).toHaveAttribute("title", "QA 표준 모델");
      await capture(page, theme, viewport.name, "selected");

      if (viewport.name === "mobile") {
        await page.getByTestId("v3-mobile-tab-task").click();
      }
      await taskRuns.filter({ hasText: "밀도 기준 정리" }).click();
      await expect(page.getByTestId("session-model-preset")).toHaveCount(0);
      await capture(page, theme, viewport.name, "unspecified");
    });
  }
}

async function disableServiceWorker(page: Page, theme: "dark" | "light"): Promise<void> {
  await page.addInitScript((appearance) => {
    localStorage.setItem("soul-dashboard-theme", appearance);
    localStorage.setItem("ls.webglGlass", "0");
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
}

async function capture(
  page: Page,
  theme: "dark" | "light",
  viewport: string,
  state: string,
): Promise<void> {
  const outputDir = path.join(OUTPUT_ROOT, `${theme}-${viewport}`);
  mkdirSync(outputDir, { recursive: true });
  await page.screenshot({
    path: path.join(outputDir, `${state}.png`),
    fullPage: false,
    animations: "disabled",
  });
}
