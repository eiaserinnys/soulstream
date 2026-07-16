import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.PR_Y_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-new-task-inherit-preview"),
);

type Theme = "dark" | "light";

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });

test("PR-Y · one Chromium · inherited values, empty values, and project switching", async ({ browser }) => {
  test.setTimeout(120_000);

  for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({
      colorScheme: theme,
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    try {
      await preparePage(page, theme);
      const projectPageReads = new Map<string, number>();
      page.on("request", (request) => {
        const pathName = new URL(request.url()).pathname;
        if (["/api/pages/project-amber", "/api/pages/project-dashboard", "/api/pages/project-ops"].includes(pathName)) {
          projectPageReads.set(pathName, (projectPageReads.get(pathName) ?? 0) + 1);
        }
      });

      await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("v3-global-toolbar")).toBeVisible();
      await expect(page.getByTestId("v3-task-task-alpha")).toBeVisible();
      await page.getByRole("button", { name: "새 업무" }).click();
      await page.getByLabel("프로젝트 선택").selectOption("folder-dashboard");

      const preview = page.getByTestId("new-task-inheritance-preview");
      await expect(preview).toContainText("컨텍스트 미리보기 · 대시보드");
      await expect(page.getByTestId("inheritance-guidance-preview")).toContainText("프로젝트의 결정을 실제 근거와 함께 기록하고");
      await expect(page.getByTestId("inheritance-guidance-preview")).toHaveCSS("-webkit-line-clamp", "3");
      await expect(page.getByTestId("inheritance-guidance")).toContainText("소울스트림에서 상속");
      await expect(page.getByTestId("inheritance-atom")).toContainText("⚛ soulstream · depth 5 · titlesOnly off");
      await expect(page.getByTestId("inheritance-defaults")).toContainText("👤 roselin_codex@eiaserinnys");
      await expect.poll(() => projectPageReads.get("/api/pages/project-amber") ?? 0).toBe(1);
      await expect.poll(() => projectPageReads.get("/api/pages/project-dashboard") ?? 0).toBe(1);
      await expect(preview.locator("details")).toHaveCount(0);
      await capture(page, theme, "01-with-context");

      await page.getByLabel("프로젝트 선택").selectOption("folder-ops");
      await expect(preview).toContainText("컨텍스트 미리보기 · Soulstream 운영");
      await expect(page.getByTestId("inheritance-guidance")).toContainText("없음");
      await expect(page.getByTestId("inheritance-atom")).toContainText("없음");
      await expect(page.getByTestId("inheritance-defaults")).toContainText("없음");
      await expect.poll(() => projectPageReads.get("/api/pages/project-ops") ?? 0).toBe(1);
      await capture(page, theme, "02-without-context");
    } finally {
      await context.close();
    }
  }
});

async function preparePage(page: Page, theme: Theme) {
  await page.addInitScript((appearance: Theme) => {
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
  await installV3VisualQaRoutes(page, { contextChainPreview: true });
}

async function capture(page: Page, theme: Theme, state: string) {
  const output = path.join(OUTPUT_ROOT, theme);
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `${state}.png`), animations: "disabled" });
}
