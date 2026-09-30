import { expect, test } from "@playwright/test";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

test("renders the built v3 dashboard with its deterministic API fixture", async ({ page }) => {
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
  await expect(page.getByRole("textbox", { name: "무엇을 맡길까요" })).toBeVisible();
  const inbox = page.locator(".v3-card-inbox");
  await expect(inbox.locator("[data-card-group]")).toHaveCount(0);
  await expect(inbox.getByText("지금은 확인할 것이 없습니다", { exact: true })).toBeVisible();
});
