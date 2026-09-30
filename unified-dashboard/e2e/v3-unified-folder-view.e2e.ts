import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const outputRoot = path.resolve(process.env.CARD_FOLDER_CAPTURE_OUTPUT ?? ".local/artifacts/cards-p1-folder-captures");

test("folder card section appears with cards and keeps add action when empty", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true });

  await openFolder(page, "소울스트림");
  const section = page.getByTestId("folder-card-section");
  await expect(section).toBeVisible();
  await expect(section.getByRole("heading", { name: "카드" })).toBeVisible();
  await expect(section.getByText("P1 카드 표시", { exact: true })).toBeVisible();
  mkdirSync(outputRoot, { recursive: true });
  await section.screenshot({ path: path.join(outputRoot, "folder-with-cards.png"), animations: "disabled" });

  await openFolder(page, "Soulstream 운영");
  const emptySection = page.getByTestId("folder-card-section");
  await expect(emptySection).toBeVisible();
  await expect(emptySection.getByRole("heading", { name: "카드" })).toBeVisible();
  await expect(emptySection.getByRole("button", { name: "카드 추가" })).toBeVisible();
  await expect(emptySection.locator(".v3-run-list").locator("[data-card-id]")).toHaveCount(0);
  await emptySection.screenshot({ path: path.join(outputRoot, "folder-without-cards.png"), animations: "disabled" });
});

async function openFolder(page: Page, name: string) {
  await page.goto("http://127.0.0.1:4173/v3", { waitUntil: "domcontentloaded" });
  await page.getByTestId("v3-all-projects").getByRole("button", { name, exact: true }).click();
  await expect(page.getByTestId("v3-planner-scroll").locator(".v3-detail-pane--inline")).toBeVisible();
}
