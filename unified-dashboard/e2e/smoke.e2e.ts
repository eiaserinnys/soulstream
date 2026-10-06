import { expect, test } from "@playwright/test";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

test("renders the built v3 dashboard with its deterministic API fixture", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
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
  });
  await installV3VisualQaRoutes(page);

  await page.goto("/v3", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("textbox", { name: "세션 첫 메시지" })).toBeVisible();
  const inbox = page.locator(".v3-card-inbox");
  await expect(inbox.locator("[data-board-column]")).toHaveCount(0);
  await expect(inbox.locator(".v3-card-board-empty")).toHaveText("카드가 없습니다");
  await expect(inbox.locator('[data-board-column="done"]')).toHaveCount(0);
  await expect(inbox.getByRole("button", { name: "새 카드", exact: true })).toBeVisible();
  await expect(inbox.getByRole("button", { name: "보드 확대", exact: true })).toBeVisible();
  await inbox.getByRole("button", { name: "기록", exact: true }).click();
  await expect(page.locator(".v3-date-head")).toBeVisible();
  await expect(page.getByTestId("persistent-session-entry")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
