import { koreanLocale } from "./korean-locale.mjs";
import { expect, test, type Page } from "./test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_BY_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-session-affiliation-focus"),
);

test.describe.configure({ mode: "serial" });

for (const theme of ["dark", "light"] as const) {
  test(`folder affiliation and session-row focus stay aligned in ${theme} mode`, async ({ browser }) => {
    // 전체 화면 캡처 세 번과 왕복 클릭이 공유 호스트 부하에서 기본 60초를 넘긴다.
    test.setTimeout(180_000);
    const context = await browser.newContext({
      colorScheme: theme,
      reducedMotion: "reduce",
      viewport: { width: 1600, height: 1000 },
      locale: koreanLocale,
    });
    const page = await context.newPage();
    const browserErrors: string[] = [];
    const sessionRequests: string[] = [];
    let boardItemRequests = 0;
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/sessions") sessionRequests.push(url.search);
      if (url.pathname === "/api/board-items") boardItemRequests += 1;
    });

    await preparePage(page, theme);
    // The panel affiliation comes from the session folder, so an empty board must not hide it.
    await page.route("**/api/board-items?**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ boardItems: [] }) });
    });

    try {
      await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
      const panelRow = page.getByTestId("v3-session-row-run-alpha-2");
      await panelRow.waitFor({ state: "visible", timeout: 20_000 });
      // 세션 행은 카탈로그 폴더와 별도 요청에서 먼저 도착할 수 있다. 열기 전 소속은
      // 카드 제목이 아니라 폴더 이름이다(패널의 폴더 폴백). 열면 카드 제목으로 바뀐다.
      await expect(panelRow.locator(".v3-run-affiliation")).toHaveText(fixtureTitles.primaryTask);

      await panelRow.locator(".v3-run-open").click();
      await assertFocusedSession(page);
      // 이 fixture의 세션에는 카드가 붙지 않으므로 소속은 폴더 이름이다. 보드가 비어도
      // 폴더 소속 표시가 사라지지 않는지가 이 시나리오의 핵심이다.
      await expect(panelRow.locator(".v3-run-affiliation")).toHaveText(fixtureTitles.primaryTask);
      await capture(page, theme, "01-session-click-focus");

      // rb-alpha는 folder-amber의 자식이라 뒤로 가기는 부모 폴더로 간다. 플래너로
      // 돌아가려면 워크스페이스를 닫는다(Escape).
      await page.keyboard.press("Escape");
      await expect(page.locator(".v3-workspace")).toHaveCount(0);
      const affiliation = panelRow.locator(".v3-run-affiliation");
      await expect(affiliation).toBeVisible();
      await expect(affiliation).toHaveAttribute("title", fixtureTitles.primaryTask);
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

      const requestsBeforeCachedClick = boardItemRequests;
      const sessionRequestsBeforeCachedClick = sessionRequests.length;
      await panelRow.locator(".v3-run-open").click();
      await assertFocusedSession(page);
      expect(boardItemRequests).toBe(requestsBeforeCachedClick);
      // 캐시된 재방문은 그 세션의 상세(session_id=)를 다시 요청하지 않는다. 패널의
      // 목록 조회는 라이브 데이터 평면이 따로 하므로 여기 판정에 넣지 않는다.
      expect(sessionRequests.slice(sessionRequestsBeforeCachedClick)
        .filter((query) => query.includes("session_id="))).toEqual([]);
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
  // 플래너의 인라인 폴더와 클릭으로 연 워크스페이스가 같은 폴더 상세를 함께 띄울 수 있다.
  // 소속 초점은 클릭이 연 워크스페이스에서만 판정한다.
  const workspace = page.locator(".v3-workspace");
  const navigation = workspace.getByRole("navigation", { name: "폴더 섹션" });
  await expect(navigation.getByRole("button", { name: "세션 섹션으로 이동" }))
    .toHaveAttribute("aria-current", "location");
  const activeRow = workspace.locator('.v3-detail-scroll [data-session-id="run-alpha-2"]');
  await expect(activeRow).toHaveClass(/is-active/);
  const visibility = await activeRow.evaluate((row) => {
    const scroll = row.closest<HTMLElement>(".v3-detail-scroll");
    if (!scroll) throw new Error("폴더 상세 스크롤을 찾지 못했습니다.");
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

async function capture(page: Page, theme: string, name: string) {
  const directory = path.join(outputRoot, theme);
  mkdirSync(directory, { recursive: true });
  await page.screenshot({
    path: path.join(directory, `${name}.png`),
    animations: "disabled",
    fullPage: true,
  });
}
