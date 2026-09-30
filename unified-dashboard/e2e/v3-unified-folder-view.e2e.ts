import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const phase = process.env.V3_UNIFY_PHASE === "before" ? "before" : "after";
const outputRoot = path.resolve(process.env.V3_UNIFY_OUTPUT ?? ".local/artifacts/unify-folder-view-web");

test.use({ timezoneId: "Asia/Seoul" });

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`folder workspace · ${viewport.name} · ${phase}`, async ({ page }) => {
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
    await installV3VisualQaRoutes(page, { unifiedFolderView: true });

    await openFolder(page, viewport.name, "소울스트림");
    if (phase === "after") {
      await expect(page.locator(".v3-workspace-scrim")).toHaveCount(0);
      await expect(page.getByTestId("v3-planner-scroll").locator(".v3-detail-pane--inline")).toBeVisible();
      await expect(page.getByText("화면 점검")).toBeVisible();
      await page.getByTestId("v3-task-checklist").scrollIntoViewIfNeeded();
    }
    await capture(page, viewport.name, "a-checklist-on");
    if (phase === "after") {
      await expect(page.getByTestId("v3-task-checklist")).toBeVisible();
      await expect(page.getByTestId("v3-project-context")).toBeVisible();
    }

    await openFolder(page, viewport.name, "Soulstream 운영");
    if (phase === "after") await expect(page.getByTestId("v3-project-context")).toBeVisible();
    await capture(page, viewport.name, "b-checklist-off");
    if (phase === "after") await expect(page.getByTestId("v3-task-checklist")).toHaveCount(0);

    await openFolder(page, viewport.name, "소울스트림");
    if (phase === "after") await page.getByTestId("v3-child-folder-folder-dashboard").scrollIntoViewIfNeeded();
    await capture(page, viewport.name, "c-child-folder-card");
    if (phase === "after") {
      await page.getByTestId("v3-child-folder-folder-dashboard").click();
      await expect(page.getByTestId("v3-project-row-folder-dashboard")).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("v3-project-context")).toBeVisible();
    } else {
      await openFolder(page, viewport.name, "대시보드");
    }
    await capture(page, viewport.name, "d-child-selected-in-tree");

    if (phase === "after") {
      await page.getByRole("button", { name: "상위 폴더로 이동" }).click();
      await expect(page.getByTestId("v3-project-row-folder-amber")).toHaveAttribute("data-selected", "true");
      await expect(page.getByTestId("v3-project-context")).toBeVisible();
    } else {
      await openFolder(page, viewport.name, "소울스트림");
    }
    await capture(page, viewport.name, "e-parent-folder");

    await openFolder(page, viewport.name, "소울스트림");
    if (phase === "after") {
      await expect(page.getByRole("button", { name: "이전 세션 더 보기" })).toBeVisible();
      await page.locator('[data-task-section="sessions"]').evaluate((element) => element.scrollIntoView({ block: "start" }));
    }
    await capture(page, viewport.name, "f-many-sessions-first-page");
    if (phase === "after") {
      await expect(page.getByRole("heading", { name: "세션 히스토리" })).toBeVisible();
      await expect(page.getByRole("button", { name: "이전 세션 더 보기" })).toBeVisible();
      await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).click();
      await expect(page.getByText("오늘의 업무")).toBeVisible();
    }
  });
}

test("folder rows stay inline while sessions open the existing overlay", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, addEventListener: () => undefined }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", { configurable: true, get: () => null });
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true });
  await openFolder(page, "desktop", "소울스트림");

  await page.locator('.v3-planner-scroll .v3-run-list .v3-run-open').first().click();
  await expect(page.locator(".v3-workspace-scrim")).toBeVisible();
  await expect(page.locator(".v3-workspace-scrim .v3-detail-pane")).toBeVisible();
  await expect(page.locator(".v3-workspace-scrim .v3-chat-pane")).toBeVisible();
  await page.locator(".v3-workspace-scrim").click({ position: { x: 5, y: 500 } });
  await expect(page.locator(".v3-workspace-scrim")).toHaveCount(0);
  await expect(page.getByTestId("v3-planner-scroll").locator(".v3-detail-pane--inline")).toBeVisible();

  await page.getByTestId("v3-session-panel").locator(".v3-run-open").first().click();
  await expect(page.locator(".v3-workspace-scrim .v3-chat-pane")).toBeVisible();
});

async function openFolder(page: Page, viewport: "desktop" | "mobile", name: string) {
  await page.goto("http://127.0.0.1:4173/v3", { waitUntil: "domcontentloaded" });
  if (viewport === "mobile") {
    await page.getByTestId("v3-mobile-tab-projects").click();
    await page.getByTestId("v3-mobile-project-list").getByRole("button", { name }).click();
  } else {
    if (name === "대시보드") {
      await page.getByRole("button", { name: "소울스트림 펼치기" }).click();
    }
    await page.getByTestId("v3-all-projects").getByRole("button", { name, exact: true }).click();
  }
  await page.waitForLoadState("networkidle");
  if (phase === "after") {
    await expect(page.getByTestId("v3-project-context")).toBeVisible();
    await expect(page.locator(".v3-workspace-scrim")).toHaveCount(0);
    await expect(page.getByTestId("v3-planner-scroll").locator(".v3-detail-pane--inline")).toBeVisible();
    await expect(page.locator(".v3-documents")).toHaveCount(0);
    await expect(page.locator(".v3-child-folders")).toHaveCount(1);
    await expect(page.locator('[data-task-section="information"]')).toHaveCount(1);
    await expect(page.locator('[data-task-section="checklist"]')).toHaveCount(name === "소울스트림" ? 1 : 0);
    await expect(page.locator('[data-task-section="board"]')).toHaveCount(1);
    await expect(page.locator('[data-task-section="sessions"]')).toHaveCount(1);
    if (viewport === "desktop") {
      await expect(page.locator(".v3-navigation")).toBeVisible();
      await expect(page.getByTestId("v3-session-panel")).toBeVisible();
    }
  }
}

async function capture(page: Page, viewport: string, name: string) {
  const directory = path.join(outputRoot, phase, viewport);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), animations: "disabled", fullPage: true });
}
