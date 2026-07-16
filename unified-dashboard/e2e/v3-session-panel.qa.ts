import type { Browser, Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_AU_QA_OUTPUT ?? path.join("e2e", "screenshots", "v3-session-panel"),
);

const result = await runPlaywrightLifecycle({
  lockName: "pr-au-v3-session-panel",
  timeoutMs: 180_000,
}, async ({ browser }) => ({
  dark: await verifyTheme(browser, "dark"),
  light: await verifyTheme(browser, "light"),
}));

console.log(JSON.stringify({ ok: true, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: "dark" | "light") {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const sessionRequests: string[] = [];
  let folderBoardRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/sessions") sessionRequests.push(url.search);
    if (url.pathname === "/api/board-items" && url.searchParams.has("folder_id")) {
      folderBoardRequests += 1;
    }
  });
  page.on("pageerror", (error) => console.error(`[pr-au/${theme}] pageerror`, error));
  await preparePage(page, theme);

  try {
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    const panel = page.getByTestId("v3-session-panel");
    await panel.waitFor({ state: "visible", timeout: 20_000 });
    await page.locator('[data-session-id="run-alpha-2"]').waitFor({ state: "visible" });
    await capture(page, theme, "01-three-column-shell");

    await page.locator('[data-session-id="run-alpha-2"]').click();
    await page.locator(".v3-task-title-button").filter({ hasText: fixtureTitles.primaryTask })
      .waitFor({ state: "visible" });
    await page.locator('.v3-chat-pane[aria-label="세션 채팅"]').waitFor({ state: "visible" });
    assert(await page.getByTestId("v3-standalone-task-empty").count() === 0, "업무 소속 세션이 단독 모드로 열렸습니다.");
    await capture(page, theme, "02-task-session-active-chat");
    await page.getByRole("button", { name: "업무 상세 닫기" }).click();

    await page.locator('[data-session-id="review-session"]').click();
    await page.getByTestId("v3-standalone-task-empty").waitFor({ state: "visible" });
    await page.getByTestId("v3-standalone-session-chat").waitFor({ state: "visible" });
    await capture(page, theme, "03-standalone-session-chat");
    await page.getByRole("button", { name: "업무 창 닫기" }).click();

    const removed = page.getByTestId("v3-session-row-review-session-2");
    const untouched = page.getByTestId("v3-session-row-review-session-3");
    await removed.waitFor({ state: "visible" });
    await startReviewMutationObserver(page, "review-session-3");
    await removed.getByRole("button", { name: "추가 검수 세션 2 확인 처리" }).click();
    await removed.waitFor({ state: "detached" });
    const mutations = await stopReviewMutationObserver(page);
    assert(await panel.isVisible(), "검수 확인 뒤 우측 세션 패널이 닫혔습니다.");
    assert(await untouched.isVisible(), "검수 확인이 다른 행을 제거했습니다.");
    assert(mutations.untouched === 0, `검수 확인이 다른 행을 ${mutations.untouched}회 변경했습니다.`);
    assert(mutations.listChild === 1, `검수 확인이 목록 구조를 ${mutations.listChild}회 변경했습니다.`);
    assert(folderBoardRequests === 1, `세션 업무 해석이 ${folderBoardRequests}회 요청되었습니다.`);
    assert(sessionRequests.every((query) => query.includes("session_id=")), `우측 패널이 전체 세션 조회를 만들었습니다: ${sessionRequests.join(", ")}`);
    await capture(page, theme, "04-review-row-removed");

    return {
      taskSession: true,
      standaloneSession: true,
      reviewRowOnly: mutations,
      folderBoardRequests,
      fullSessionRequests: sessionRequests.filter((query) => !query.includes("session_id=")).length,
    };
  } finally {
    await context.close();
  }
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

async function startReviewMutationObserver(page: Page, untouchedSessionId: string) {
  await page.evaluate((sessionId) => {
    const list = document.querySelector('[data-testid="v3-session-group-review"] .v3-session-list');
    const untouched = document.querySelector(`[data-testid="v3-session-row-${sessionId}"]`);
    if (!list || !untouched) throw new Error("검수 MutationObserver 대상을 찾지 못했습니다.");
    const state = { listChild: 0, untouched: 0, observers: [] as MutationObserver[] };
    const listObserver = new MutationObserver((records) => { state.listChild += records.length; });
    listObserver.observe(list, { childList: true });
    const untouchedObserver = new MutationObserver((records) => { state.untouched += records.length; });
    untouchedObserver.observe(untouched, { attributes: true, characterData: true, childList: true, subtree: true });
    state.observers.push(listObserver, untouchedObserver);
    (window as Window & { __prAuReviewObserver?: typeof state }).__prAuReviewObserver = state;
  }, untouchedSessionId);
}

async function stopReviewMutationObserver(page: Page): Promise<{ listChild: number; untouched: number }> {
  return await page.evaluate(() => {
    const state = (window as Window & {
      __prAuReviewObserver?: { listChild: number; untouched: number; observers: MutationObserver[] };
    }).__prAuReviewObserver;
    if (!state) throw new Error("검수 MutationObserver 상태가 없습니다.");
    for (const observer of state.observers) observer.disconnect();
    return { listChild: state.listChild, untouched: state.untouched };
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
