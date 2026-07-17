import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BY_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-session-affiliation-focus"),
);

test.describe.configure({ mode: "serial" });

for (const theme of ["dark", "light"] as const) {
  test(`cached affiliation and session-row focus stay aligned in ${theme} mode`, async ({ browser }) => {
    const context = await browser.newContext({
      colorScheme: theme,
      reducedMotion: "reduce",
      viewport: { width: 1600, height: 1000 },
    });
    const page = await context.newPage();
    const browserErrors: string[] = [];
    const sessionRequests: string[] = [];
    let folderBoardRequests = 0;
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/sessions") sessionRequests.push(url.search);
    });

    await preparePage(page, theme);
    await page.route("**/api/board-items?**", async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("folder_id")) return route.fallback();
      folderBoardRequests += 1;
      await fulfillJson(route, cachedFolderBoardItems());
    });

    try {
      await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
      const panelRow = page.getByTestId("v3-session-row-run-alpha-2");
      await panelRow.waitFor({ state: "visible", timeout: 20_000 });
      await expect(panelRow.locator(".v3-run-affiliation")).toHaveCount(0);

      await panelRow.locator(".v3-run-open").click();
      await assertFocusedSession(page);
      await expect(panelRow.locator(".v3-run-affiliation"))
        .toHaveText(`${fixtureTitles.primaryTask} · ${fixtureTitles.project}`);
      await capture(page, theme, "01-session-click-focus");

      await page.getByRole("button", { name: "오늘 플래너로 돌아가기" }).click();
      const affiliation = panelRow.locator(".v3-run-affiliation");
      await expect(affiliation).toBeVisible();
      await expect(affiliation).toHaveAttribute(
        "title",
        `${fixtureTitles.primaryTask} · ${fixtureTitles.project}`,
      );
      const ellipsis = await affiliation.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          overflow: style.overflow,
          textOverflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
        };
      });
      expect(ellipsis).toEqual({ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
      await capture(page, theme, "02-panel-affiliation");

      const requestsBeforeCachedClick = folderBoardRequests;
      await panelRow.locator(".v3-run-open").click();
      await assertFocusedSession(page);
      expect(folderBoardRequests).toBe(requestsBeforeCachedClick);
      expect(sessionRequests.every((query) => query.includes("session_id="))).toBe(true);
      expect(browserErrors).toEqual([]);
      await capture(page, theme, "03-cached-round-trip-focus");
    } finally {
      await context.close();
    }
  });
}

async function preparePage(page: Page, theme: "dark" | "light") {
  await page.addInitScript({ content: `
    localStorage.setItem("soul-dashboard-theme", ${JSON.stringify(theme)});
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (serviceWorker) {
      Object.defineProperty(serviceWorker, "register", {
        configurable: true,
        value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
      });
      Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
    }
  ` });
  await installV3VisualQaRoutes(page);
}

async function assertFocusedSession(page: Page) {
  await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask })
    .waitFor({ state: "visible" });
  const navigation = page.getByRole("navigation", { name: "업무 섹션" });
  await expect(navigation.getByRole("button", { name: "세션 섹션으로 이동" }))
    .toHaveAttribute("aria-current", "location");
  const activeRow = page.locator('.v3-detail-scroll [data-session-id="run-alpha-2"]');
  await expect(activeRow).toHaveClass(/is-active/);
  const visibility = await activeRow.evaluate((row) => {
    const scroll = row.closest<HTMLElement>(".v3-detail-scroll");
    if (!scroll) throw new Error("업무 상세 스크롤을 찾지 못했습니다.");
    const rowRect = row.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    return {
      top: rowRect.top - scrollRect.top,
      bottom: rowRect.bottom - scrollRect.top,
      viewportHeight: scroll.clientHeight,
    };
  });
  expect(visibility.top).toBeLessThan(visibility.viewportHeight);
  expect(visibility.bottom).toBeGreaterThan(0);
}

function cachedFolderBoardItems() {
  const sessionItem = (sessionId: string, y: number) => ({
    id: `session:${sessionId}`,
    folderId: "folder-amber",
    containerKind: "runbook",
    containerId: "task-alpha",
    membershipKind: "primary",
    itemType: "session",
    itemId: sessionId,
    x: 24,
    y,
  });
  return {
    boardItems: [
      sessionItem("run-alpha-1", 0),
      sessionItem("run-alpha-2", 72),
      {
        id: "runbook:task-alpha",
        folderId: "folder-amber",
        containerKind: "folder",
        containerId: "folder-amber",
        membershipKind: "primary",
        itemType: "runbook",
        itemId: "task-alpha",
        x: 24,
        y: 144,
        metadata: { title: fixtureTitles.primaryTask },
      },
    ],
  };
}

async function fulfillJson(route: Route, payload: unknown) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}
