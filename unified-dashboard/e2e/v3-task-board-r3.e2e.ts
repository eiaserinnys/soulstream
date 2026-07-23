import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

test("keeps the r3 task-board resources, canvas, chat, and document overlay boundaries", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => "Playwright jsdom local-board-yjs",
    });
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
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
    }
  });
  await installV3VisualQaRoutes(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("http://127.0.0.1:4173/v3", { waitUntil: "domcontentloaded" });

  await page.getByTestId("v3-task-task-alpha").click();
  await page.getByRole("button", { name: "업무 보드 열기" }).click();
  const resources = page.getByTestId("v3-task-board-resources");
  const canvas = page.getByTestId("v3-task-board-canvas");
  const chat = page.getByTestId("v3-task-board-chat");
  await expect(resources).toBeVisible();
  await expect(canvas).toBeVisible();
  await expect(chat).toBeVisible();
  await expect(resources.getByTestId("task-card")).toBeVisible();
  await expect(resources.getByRole("tab", { name: "PR-O 결정 로그" })).toHaveCount(0);
  await expect(resources.getByRole("tab", { name: "검증 현황" })).toHaveCount(0);
  await expect(canvas.getByTestId("task-board-fixed-card")).toHaveCount(0);
  await expect(canvas.getByTestId("board-session-tile")).toHaveCount(0);
  await expect(canvas.locator('[data-board-tile="true"]')).toHaveCount(3);
  const leftEdgeStack = await page.evaluate(() => (
    document.elementsFromPoint(20, 100).map((element) => ({
      tag: element.tagName,
      className: element.getAttribute("class"),
      testId: element.getAttribute("data-testid"),
    }))
  ));
  expect(leftEdgeStack[0], JSON.stringify(leftEdgeStack)).toMatchObject({
    testId: "v3-task-board-resources",
  });

  const wideRegions = await regionBounds(resources, canvas, chat);
  expect(wideRegions.resources.x + wideRegions.resources.width).toBeLessThanOrEqual(wideRegions.canvas.x);
  expect(wideRegions.canvas.x + wideRegions.canvas.width).toBeLessThanOrEqual(wideRegions.chat.x);

  await resources.getByRole("tab", { name: "위임 관계" }).click();
  await expect(resources.locator(".v3-run-row")).toHaveCount(2);
  await resources.locator(".v3-run-open").first().click();
  await expect(chat).not.toContainText("선택된 세션 없음");

  await canvas.getByTestId("board-declutter-button").click();
  await canvas.getByTestId("board-custom-view-tile").click();
  const fluxTab = resources.getByRole("tab", { name: "검증 현황" });
  await expect(fluxTab).toHaveAttribute("aria-selected", "true");
  await expect(resources.getByTestId("custom-view-panel")).toBeVisible();
  await expect(resources.frameLocator("iframe").getByText("Sandbox custom view")).toBeVisible();
  await expect(chat).toContainText("시각 QA 순회");
  await expect(chat.getByTestId("custom-view-panel")).toHaveCount(0);

  await canvas.getByTestId("board-markdown-tile").click();
  const documentTab = resources.getByRole("tab", { name: "PR-O 결정 로그" });
  await expect(documentTab).toHaveAttribute("aria-selected", "true");
  await expect(fluxTab).toHaveCount(1);
  await expect(page.getByTestId("v3-task-board-document-overlay")).toHaveCount(0);
  await expect(chat).toContainText("시각 QA 순회");

  await resources.getByRole("button", { name: "PR-O 결정 로그 편집기 열기" }).click();
  const overlay = page.getByTestId("v3-task-board-document-overlay");
  await expect(overlay).toBeVisible();
  const titleInput = overlay.getByRole("textbox", { name: "Document title" });
  await expect(titleInput).toHaveValue("PR-O 결정 로그");
  await titleInput.fill("PR-O 결정 로그 · r3");
  await titleInput.blur();
  await expect(overlay.getByTestId("markdown-save-status")).toHaveText("동기화됨");
  await overlay.getByTestId("markdown-read-body").click();
  const bodyEditor = overlay.getByRole("textbox", { name: "Document body" });
  await bodyEditor.fill("# r3 검증\n\n문서 저장 흐름까지 연결됨");
  await bodyEditor.blur();
  await expect(overlay.getByTestId("markdown-read-body")).toContainText("문서 저장 흐름까지 연결됨");
  const wideOverlay = await requiredBounds(overlay);
  expect(wideOverlay.x).toBeGreaterThanOrEqual(wideRegions.canvas.x);
  expect(wideOverlay.x + wideOverlay.width).toBeLessThanOrEqual(wideRegions.canvas.x + wideRegions.canvas.width);
  expect(wideOverlay.x + wideOverlay.width).toBeLessThanOrEqual(wideRegions.chat.x);
  await captureEvidence(page, "wide");

  await page.setViewportSize({ width: 1024, height: 900 });
  const narrowRegions = await regionBounds(resources, canvas, chat);
  const narrowOverlay = await requiredBounds(overlay);
  expect(narrowOverlay.x).toBeLessThan(narrowRegions.canvas.x);
  expect(narrowOverlay.x + narrowOverlay.width).toBeLessThanOrEqual(narrowRegions.chat.x);
  await captureEvidence(page, "narrow");

  await overlay.getByRole("button", { name: "문서 편집기 접기" }).click();
  await expect(overlay).toBeHidden();
  await expect(canvas).toBeVisible();
});

async function regionBounds(
  resources: Locator,
  canvas: Locator,
  chat: Locator,
) {
  return {
    resources: await requiredBounds(resources),
    canvas: await requiredBounds(canvas),
    chat: await requiredBounds(chat),
  };
}

async function requiredBounds(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

async function captureEvidence(page: Page, name: string) {
  const evidenceDir = process.env.TASK_BOARD_R3_EVIDENCE_DIR;
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  const screenshot = await page.screenshot({ animations: "disabled" });
  await writeFile(path.join(evidenceDir, `${name}.png`), screenshot);
}
