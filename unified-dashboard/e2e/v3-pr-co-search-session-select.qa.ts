import type { Browser, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

type Theme = "dark" | "light";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const outputRoot = path.resolve(
  process.env.PR_CO_QA_OUTPUT
    ?? path.join(".local", "artifacts", "screenshots", "pr-co-search-session-select"),
);
const firstTarget = {
  query: "대비",
  sessionId: "run-alpha-child",
  title: "대비 확인",
  preview: "첫 번째 검색 세션",
};
const secondTarget = {
  query: "모바일",
  sessionId: "run-beta-1",
  title: "모바일 탭 구현",
  preview: "두 번째 검색 세션",
};

const result = await runPlaywrightLifecycle({
  lockName: "pr-co-search-session-select",
  timeoutMs: 180_000,
  launchOptions: { headless: true, args: ["--disable-dev-shm-usage"] },
}, async ({ browser }) => ({
  themes: [
    await verifyTheme(browser, "dark"),
    await verifyTheme(browser, "light"),
  ],
}));

mkdirSync(outputRoot, { recursive: true });
writeFileSync(
  path.join(outputRoot, "metrics.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify({ ok: true, outputRoot, residualProcesses: 0, ...result }, null, 2));

async function verifyTheme(browser: Browser, theme: Theme) {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = collectErrors(page);
  const targetedSessionRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/sessions" && url.searchParams.has("session_id")) {
      targetedSessionRequests.push(url.search);
    }
  });

  try {
    await preparePage(page, theme);
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("v3-task-task-alpha").waitFor({ state: "visible", timeout: 30_000 });

    await page.getByRole("button", { name: "Open session search" }).click();
    await selectSearchResult(page, firstTarget.query, firstTarget.preview);
    const firstChat = visibleChat(page);
    await firstChat.getByText(firstTarget.title, { exact: true }).waitFor({ state: "visible" });
    await firstChat.getByText(`PR-CO 채팅 ${firstTarget.sessionId}`, { exact: true })
      .waitFor({ state: "visible" });

    await page.keyboard.press("Control+K");
    await selectSearchResult(page, secondTarget.query, secondTarget.preview);
    const secondChat = visibleChat(page);
    await secondChat.getByText(secondTarget.title, { exact: true }).waitFor({ state: "visible" });
    await secondChat.getByText(`PR-CO 채팅 ${secondTarget.sessionId}`, { exact: true })
      .waitFor({ state: "visible" });
    assert(
      targetedSessionRequests.some((search) => search.includes(`session_id=${firstTarget.sessionId}`)),
      `선택 세션 ${firstTarget.sessionId}의 targeted 조회가 없습니다: ${targetedSessionRequests.join(", ")}`,
    );
    assert(
      await secondChat.getByText(firstTarget.title, { exact: true }).count() === 0,
      "두 번째 검색 선택 뒤에도 첫 번째 채팅 제목이 남아 있습니다.",
    );
    assert(errors.length === 0, `브라우저 오류: ${errors.join(" | ")}`);

    const directory = path.join(outputRoot, theme);
    mkdirSync(directory, { recursive: true });
    await page.screenshot({
      path: path.join(directory, "search-session-selected.png"),
      animations: "disabled",
      fullPage: true,
    });
    return {
      theme,
      previousSessionId: firstTarget.sessionId,
      selectedSessionId: secondTarget.sessionId,
      selectedTitle: secondTarget.title,
      modalClosed: await page.getByRole("dialog", { name: "세션 기록 검색" }).count() === 0,
      targetedRequestCount: targetedSessionRequests.filter(
        (search) => search.includes(`session_id=${firstTarget.sessionId}`),
      ).length,
      browserErrors: errors.length,
    };
  } finally {
    await context.close();
  }
}

async function preparePage(page: Page, theme: Theme) {
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
  await installV3VisualQaRoutes(page, {
    liveEventText: "PR-CO 채팅",
    excludeSessionIdsFromInitialStream: [firstTarget.sessionId],
  });
  await page.route("**/cogito/search**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    const target = query.includes(secondTarget.query) ? secondTarget : firstTarget;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results: [{
          session_id: target.sessionId,
          event_id: 1,
          score: 1,
          preview: target.preview,
          event_type: "user_message",
        }],
      }),
    });
  });
}

async function selectSearchResult(page: Page, query: string, preview: string) {
  const searchDialog = page.getByRole("dialog", { name: "세션 기록 검색" });
  await searchDialog.waitFor({ state: "visible" });
  await searchDialog.getByPlaceholder("검색어를 입력하세요...").fill(query);
  await searchDialog.getByText(preview, { exact: true }).waitFor({ state: "visible" });
  await searchDialog.getByText(preview, { exact: true }).click();
  await searchDialog.waitFor({ state: "hidden" });
}

function visibleChat(page: Page) {
  return page.locator(".v3-chat-pane:visible").first();
}

function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
