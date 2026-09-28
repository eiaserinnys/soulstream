import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.PR_O_QA_OUTPUT ?? path.join("e2e", "screenshots", "resume-after-limit-qa"),
);
const INELIGIBLE_REASON = "사용량 제한으로 중단된 세션이 아닙니다.";

test.use({ serviceWorkers: "allow" });
test.describe.configure({ mode: "serial" });

for (const theme of ["dark", "light"] as const) {
  test(`resume-after-limit session menu · desktop · ${theme}`, async ({ page }) => {
    test.setTimeout(60_000);
    await preparePage(page, theme, { width: 1440, height: 1000 });
    await openSessionMenu(page, "desktop");

    const action = page.getByRole("menuitem", { name: /리밋이 풀릴 때 재개/ });
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText(INELIGIBLE_REASON, { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await capture(page, `${theme}-desktop-session-menu`);
  });
}

test("resume-after-limit session menu · mobile · dark · 390px", async ({ page }) => {
  test.setTimeout(60_000);
  await preparePage(page, "dark", { width: 390, height: 844 });
  await openSessionMenu(page, "mobile");

  await expect(page.getByRole("dialog")).toBeVisible();
  const action = page.getByRole("button", { name: /리밋이 풀릴 때 재개/ });
  await expect(action).toBeVisible();
  await expect(action).toBeDisabled();
  await expect(page.getByText(INELIGIBLE_REASON, { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, "dark-mobile-390-session-menu");
});

async function preparePage(
  page: Page,
  theme: "dark" | "light",
  viewport: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((appearance: "dark" | "light") => {
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
    Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
  }, theme);
  await installV3VisualQaRoutes(page);
}

async function openSessionMenu(page: Page, surface: "desktop" | "mobile"): Promise<void> {
  await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
  const task = page.getByTestId("v3-task-task-alpha");
  await expect(task).toBeVisible();
  await task.click();
  const session = page.locator('.v3-runs .v3-run-row[data-session-id="run-alpha-2"]');
  await expect(session).toBeVisible();
  await session.click({ button: "right" });
  await expect(surface === "desktop" ? page.getByRole("menu") : page.getByRole("dialog"))
    .toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )).toBeLessThanOrEqual(0);
}

async function capture(page: Page, name: string): Promise<void> {
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  await page.screenshot({ path: path.join(OUTPUT_ROOT, `${name}.png`), animations: "disabled" });
}
