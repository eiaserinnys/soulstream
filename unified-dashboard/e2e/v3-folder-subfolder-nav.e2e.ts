import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const output = path.resolve(process.env.V3_FOLLOWUP_OUTPUT ?? ".local/artifacts/unify-folder-view-web/followup");

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`folder parent card and child management · ${viewport.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
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
    await installV3VisualQaRoutes(page, { unifiedFolderView: true, nestedSubfolder: true });
    await page.goto("http://127.0.0.1:4173/v3", { waitUntil: "domcontentloaded" });
    await openNestedFolder(page, viewport.name);

    const section = page.locator(".v3-child-folders");
    const parent = section.getByTestId("v3-parent-folder-folder-amber");
    const child = section.getByTestId("v3-child-folder-rb-beta");
    const manage = child.locator('button[aria-label$="관리 메뉴"]');
    await expect(section.locator(".v3-task-list > div").first()).toHaveAttribute("data-testid", "v3-parent-folder-folder-amber");
    await expect(parent.getByText("상위 폴더")).toBeVisible();
    await expect(parent.getByRole("heading", { name: "소울스트림" })).toBeVisible();
    await expect(child).toBeVisible();
    if (viewport.name === "mobile") {
      await section.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await expect(parent).toBeInViewport();
      await expect(child).toBeInViewport();
    }
    mkdirSync(output, { recursive: true });
    if (viewport.name === "mobile") {
      await page.screenshot({ path: path.join(output, "mobile-card.png"), animations: "disabled", fullPage: true });
    }
    await manage.click();
    await expect(page.getByText("이름 변경", { exact: true })).toBeVisible();
    await expect(page.getByText("다른 폴더로 이동", { exact: true })).toBeVisible();
    await expect(page.getByText("폴더 보관", { exact: true })).toBeVisible();
    await expect(page.getByText("체크리스트 끄기", { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(output, `${viewport.name}.png`), animations: "disabled", fullPage: true });

    await page.getByText("체크리스트 끄기", { exact: true }).click();
    await manage.click();
    await expect(page.getByText("체크리스트 켜기", { exact: true })).toBeVisible();
    await page.getByText("이름 변경", { exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "프로젝트 설정" })).toBeVisible();
    await page.keyboard.press("Escape");

    await manage.click();
    await page.getByText("다른 폴더로 이동", { exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");

    await manage.click();
    await page.getByText("폴더 보관", { exact: true }).click();
    await expect(child).toHaveCount(0);

    await section.getByRole("button", { name: "새 폴더" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "새 폴더" })).toBeVisible();
    await page.keyboard.press("Escape");
    await section.getByRole("button", { name: "새 업무" }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "새 업무" })).toBeVisible();
    await page.keyboard.press("Escape");

    await parent.click();
    await expect(page.getByTestId("v3-project-row-folder-amber")).toHaveAttribute("data-selected", "true");
  });
}

async function openNestedFolder(page: Page, viewport: "desktop" | "mobile") {
  if (viewport === "mobile") {
    await page.getByTestId("v3-mobile-tab-projects").click();
    await page.getByTestId("v3-mobile-project-list").getByRole("button", { name: "소울스트림" }).click();
    await page.getByTestId("v3-child-folder-folder-dashboard").click();
  } else {
    await page.getByRole("button", { name: "소울스트림 펼치기" }).click();
    await page.getByTestId("v3-project-row-folder-dashboard").click();
  }
  await expect(page.getByTestId("v3-project-row-folder-dashboard")).toHaveAttribute("data-selected", "true");
  await expect(page.locator(".v3-planner-scroll .v3-detail-pane--inline")).toBeVisible();
}
