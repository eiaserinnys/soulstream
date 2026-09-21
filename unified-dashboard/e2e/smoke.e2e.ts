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
  await expect(page.getByTestId("v3-task-task-alpha")).toBeVisible();
});
