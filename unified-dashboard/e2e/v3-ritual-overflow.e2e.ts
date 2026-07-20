import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.PR_S_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-ritual-overflow"),
);

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });

for (const theme of ["dark", "light"] as const) {
  test(`keeps carryover ritual bounded and moves long review previews to the queue · ${theme}`, async ({ page }) => {
    test.setTimeout(120_000);
    const outputDir = path.join(OUTPUT_ROOT, theme);
    mkdirSync(outputDir, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.addInitScript((appearance: "dark" | "light") => {
      localStorage.setItem("soul-dashboard-theme", appearance);
      localStorage.setItem("ls.webglGlass", "false");
      if (navigator.serviceWorker) {
        Object.defineProperty(navigator.serviceWorker, "register", {
          configurable: true,
          value: async () => ({
            update: async () => undefined,
            active: null,
            installing: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          }),
        });
        Object.defineProperty(navigator.serviceWorker, "controller", {
          configurable: true,
          get: () => null,
        });
      }
    }, theme);
    await installV3VisualQaRoutes(page);

    await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("오늘의 업무")).toBeVisible();
    await page.getByRole("button", { name: "아침 정리", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "어제에서 넘어온 것" })).toBeVisible();

    await expect(page.getByText("미완 업무", { exact: true })).toBeVisible();
    await expect(page.getByText("검수 대기 세션", { exact: true })).toHaveCount(0);
    const title = page.locator(".v3-ritual-card h3");
    const footer = page.locator(".v3-ritual-footer");
    await expect(title).toBeVisible();

    const bounds = await page.evaluate(() => {
      const modal = document.querySelector<HTMLElement>(".v3-ritual-modal")!;
      const body = document.querySelector<HTMLElement>(".v3-ritual-body")!;
      const card = document.querySelector<HTMLElement>(".v3-ritual-card")!;
      const titleElement = card.querySelector<HTMLElement>("h3")!;
      const description = card.querySelector<HTMLElement>("p")!;
      const footerElement = document.querySelector<HTMLElement>(".v3-ritual-footer")!;
      return {
        viewportHeight: window.innerHeight,
        modal: modal.getBoundingClientRect().toJSON(),
        body: body.getBoundingClientRect().toJSON(),
        card: card.getBoundingClientRect().toJSON(),
        footer: footerElement.getBoundingClientRect().toJSON(),
        modalDisplay: getComputedStyle(modal).display,
        bodyOverflowY: getComputedStyle(body).overflowY,
        titleLineClamp: getComputedStyle(titleElement).webkitLineClamp,
        descriptionLineClamp: getComputedStyle(description).webkitLineClamp,
      };
    });
    expect(bounds.modal.height).toBeLessThanOrEqual(bounds.viewportHeight - 40);
    expect(bounds.card.height).toBeLessThanOrEqual(260);
    expect(bounds.footer.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    expect(bounds.body.bottom).toBeLessThanOrEqual(bounds.footer.top + 1);
    expect(bounds.modalDisplay).toBe("flex");
    expect(bounds.bodyOverflowY).toBe("auto");
    expect(bounds.titleLineClamp).toBe("2");
    expect(bounds.descriptionLineClamp).toBe("3");

    writeFileSync(
      path.join(outputDir, "metrics.json"),
      `${JSON.stringify({ ritualTitleCodePoints: Array.from(await title.innerText()).length, ...bounds }, null, 2)}\n`,
      "utf8",
    );

    await page.screenshot({
      path: path.join(outputDir, "01-long-prompt-footer-visible.png"),
      animations: "disabled",
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const remove = page.getByRole("button", { name: "데일리에서 내리기", exact: true });
      if (await remove.count() === 0) break;
      await remove.click();
    }
    const finishAction = page.getByRole("button", { name: "플래너 열기", exact: true });
    await expect(finishAction).toBeVisible();
    const reviewLink = page.getByRole("button", { name: "검수 대기 6건 → 우측 세션" });
    await expect(reviewLink).toBeVisible();
    await expect(footer).toBeVisible();
    await page.screenshot({
      path: path.join(outputDir, "02-complete-button-visible.png"),
      animations: "disabled",
    });
    await reviewLink.click();
    const reviewPanel = page.getByTestId("v3-session-group-review");
    await expect(page.getByTestId("v3-session-panel")).toBeFocused();
    await expect(reviewPanel.locator(".v3-session-row")).toHaveCount(6);
    const reviewTitle = await reviewPanel.locator(".v3-session-open > span:last-child").first().innerText();
    expect(reviewTitle).not.toContain("\n");
    expect(Array.from(reviewTitle).length).toBeLessThanOrEqual(80);
    await page.screenshot({
      path: path.join(outputDir, "03-review-panel-long-preview-clamped.png"),
      animations: "disabled",
    });
  });
}
