import { expect, test, type Page } from "./test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { openV3Folder } from "./v3-qa-entry";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.V3_PROJECT_OUTPUT
    ?? path.join(".local", "artifacts", "screenshots", "pr-t-v3-model-correction"),
);

type Theme = "dark" | "light";

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });

for (const theme of ["dark", "light"] as const) {
  test(`PR-T · folder stars and shared folder context · ${theme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await preparePage(page, theme);
    await installV3VisualQaRoutes(page);

    await openV3Folder(page, BASE_URL);
    await expect(page.getByTestId("v3-starred-tasks")).toContainText(fixtureTitles.primaryTask);
    await capture(page, theme, "01-starred-folder-and-today");

    const folderCard = page.getByTestId("v3-task-task-alpha");
    await folderCard.getByRole("button", { name: `${fixtureTitles.primaryTask} 별표 해제` }).click();
    await expect(page.getByTestId("v3-starred-tasks")).not.toContainText(fixtureTitles.primaryTask);
    await folderCard.getByRole("button", { name: `${fixtureTitles.primaryTask} 별표 추가` }).click();
    await expect(page.getByTestId("v3-starred-tasks")).toContainText(fixtureTitles.primaryTask);
    await capture(page, theme, "02-star-round-trip");

    // 폴더 제목 h1의 접근 이름은 편집 버튼 이름이다. 제목은 버튼 텍스트로 확인한다.
    await expect(page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.project })).toBeVisible();
    await expect(page.getByTestId("v3-project-context")).toBeVisible();
    await expect(page.getByTestId("v3-child-folder-folder-dashboard")).toBeVisible();
    await capture(page, theme, "03-folder-context-and-children");
  });
}

async function preparePage(page: Page, theme: Theme): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((appearance: Theme) => {
    localStorage.setItem("soul-dashboard-theme", appearance);
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (!serviceWorker) return;
    Object.defineProperty(serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
    });
    Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
  }, theme);
}

async function capture(page: Page, theme: Theme, state: string): Promise<void> {
  const output = path.join(OUTPUT_ROOT, theme);
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `${state}.png`), animations: "disabled" });
}
