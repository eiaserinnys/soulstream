/**
 * 카드 #1650: V3ErrorNotice 낱말 중간 줄바꿈 방지(keep-all)와 남은 영어 문구 한국어화의 시각 검수.
 *
 * 실행:
 *   VITE_API_BASE=http://127.0.0.1:5200 corepack pnpm --dir unified-dashboard dev --host 127.0.0.1 --port 43184 --strictPort
 *   PLAYWRIGHT_MODULE=$(realpath unified-dashboard/node_modules/@playwright/test/../../playwright/index.mjs) \
 *   CHROMIUM_PATH=/usr/bin/google-chrome V3_QA_BASE_URL=http://127.0.0.1:43184 \
 *   node soul-server-ts/node_modules/tsx/dist/cli.mjs unified-dashboard/e2e/card1650-keepall-korean.qa.ts
 *
 * 고치기 전(base d34089b9) 캡처와 계측은 V3_CARD1650_BASELINE=1 로 실행한다.
 * 산출물은 unified-dashboard/e2e/evidence/card1650/ 에 저장한다.
 */
import type { Browser, Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPlaywrightLifecycle } from "./playwright-lifecycle-harness.mjs";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const baseUrl = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:43184";
const output = path.resolve(process.env.V3_CARD1650_OUTPUT ?? "unified-dashboard/e2e/evidence/card1650");
const baseline = process.env.V3_CARD1650_BASELINE === "1";
const suffix = baseline ? "before" : "after";
mkdirSync(output, { recursive: true });

const settings = {
  default_model: { model_preset: null, reasoning_effort: null },
  fallback_models: [],
  show_generation_separator: true,
  show_character: false,
  animate_character: false,
  show_jev_candidates: true,
  turn_usage_mode: "collapsed" as const,
  show_turn_usage: true,
};
const persistentSession = {
  session_id: "run-alpha-2",
  display_name: "시각 검수 세션",
  node_id: "eiaserinnys",
  folder_id: "rb-alpha",
  agent_id: "roselin_codex",
  agent_name: "로젤린",
  persistent: true,
  settings,
  runtime: { current_model: { model_preset: null, reasoning_effort: null, model: null }, pending: null },
};

async function ctx(browser: Browser, width: number, height = 1000) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    timezoneId: "Asia/Seoul",
    colorScheme: "dark",
  });
  await context.addInitScript({ content: "window.__name = (f) => f;" });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-07-28T12:00:00+09:00"));
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  return { context, page };
}

const result = await runPlaywrightLifecycle({
  lockName: "card1650-keepall-korean",
  timeoutMs: 240_000,
  launchOptions: { headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) },
}, async ({ browser }) => {
  const planner = await plannerNotice(browser);
  const chat = await chatTop(browser);
  const document = await documentLoading(browser);
  const measured = { baseline, planner, chat, document };
  if (!baseline) {
    assert(planner.narrow.brokenWords.length === 0, `390px 실패 안내에서 낱말이 끊김: ${JSON.stringify(planner.narrow)}`);
    assert(chat.narrowVisible && chat.text?.trim() === "대화의 시작", `대화의 시작 문구 불일치: ${JSON.stringify(chat)}`);
    assert(document.label?.includes("불러오는 중"), `문서 패널 로딩 문구 불일치: ${JSON.stringify(document)}`);
  }
  return measured;
});
writeFileSync(path.join(output, `metrics-${suffix}.json`), JSON.stringify({ baseline, result }, null, 2));
console.log(JSON.stringify({ baseline, output, result }, null, 2));

async function plannerNotice(browser: Browser) {
  const { context, page } = await ctx(browser, 1440, 1000);
  try {
    await installV3VisualQaRoutes(page, { unifiedFolderView: true });
    // 폴더 집계 응답을 실패로 바꿔 플래너 실패 안내를 띄운다.
    await page.route("**/api/planner/folders/folder-ops**", route => route.fulfill({
      status: 503,
      json: { detail: "planner unavailable: ETIMEDOUT" },
    }));
    await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
    const nav = page.getByTestId("v3-all-projects");
    await nav.waitFor({ state: "visible", timeout: 30_000 });
    await nav.getByText("Soulstream 운영", { exact: true }).click();
    const notice = page.locator(".v3-error-notice").first();
    await notice.waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(400);
    const wide = await paragraphLines(page);
    await page.screenshot({ path: path.join(output, `planner-error-1440-${suffix}.png`), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const narrow = await paragraphLines(page);
    const narrowBox = await notice.boundingBox();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    await page.screenshot({ path: path.join(output, `planner-error-390-${suffix}.png`), animations: "disabled" });
    return { wide, narrow, narrowBox, overflow };
  } finally {
    await context.close();
  }
}

async function paragraphLines(page: Page) {
  return page.locator(".v3-error-notice p").first().evaluate((el) => {
    const text = (el.textContent ?? "").trim();
    const chars: { ch: string; top: number }[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      for (let index = 0; index < node.data.length; index += 1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getClientRects()[0];
        if (!rect) continue;
        chars.push({ ch: node.data[index], top: Math.round(rect.top * 2) / 2 });
      }
    }
    const lines: { top: number; text: string }[] = [];
    for (const entry of chars) {
      const last = lines.at(-1);
      if (last && Math.abs(last.top - entry.top) <= 1.5) last.text += entry.ch;
      else lines.push({ top: entry.top, text: entry.ch });
    }
    const words = text.split(/\s+/).filter(Boolean);
    const brokenWords = words.filter((word) => !lines.some(line => line.text.replace(/\s+/g, "").includes(word)));
    return {
      text,
      lines: lines.map(line => ({ top: line.top, text: line.text.trim() })),
      words,
      brokenWords,
    };
  });
}

async function chatTop(browser: Browser) {
  const { context, page } = await ctx(browser, 1440, 1000);
  try {
    await page.addInitScript(() => localStorage.setItem(
      "soulstream-pas-device:qa@example.com",
      JSON.stringify({ openOnStart: true, lastSessionId: "run-alpha-2" }),
    ));
    await installV3VisualQaRoutes(page, {
      timelineEventCount: 1,
      timelineContentByEventId: { 1: "대화의 시작 표시 검수" },
      liveEventText: "검수 메시지",
    });
    await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
    await page.route("**/api/auth/status", route => route.fulfill({
      json: { authenticated: true, user: { email: "qa@example.com", name: "QA" } },
    }));
    await page.route("**/api/persistent-sessions**", async route => {
      const url = new URL(route.request().url());
      if (route.request().method() === "GET" && url.pathname === "/api/persistent-sessions") {
        return route.fulfill({ json: { sessions: [persistentSession], total: 1, create_defaults: null } });
      }
      if (route.request().method() === "GET" && url.pathname === "/api/persistent-sessions/run-alpha-2") {
        return route.fulfill({ json: { session: persistentSession } });
      }
      return route.fallback();
    });
    await page.goto(`${baseUrl}/?session=run-alpha-2&event=1`, { waitUntil: "domcontentloaded" });
    const marker = baseline
      ? page.getByText(/Beginning of conversation/).first()
      : page.getByText("대화의 시작", { exact: true }).first();
    await marker.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(400);
    const text = await marker.textContent();
    await page.screenshot({ path: path.join(output, `chat-top-1440-${suffix}.png`), animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const narrowVisible = await marker.isVisible();
    await page.screenshot({ path: path.join(output, `chat-top-390-${suffix}.png`), animations: "disabled" });
    return { text, narrowVisible };
  } finally {
    await context.close();
  }
}

async function documentLoading(browser: Browser) {
  const { context, page } = await ctx(browser, 1440, 1000);
  try {
    await installV3VisualQaRoutes(page, {});
    // 샘플 페이지의 문서 API는 네트워크를 타지 않고 즉시 응답한다. 로딩 상태를 보이게 하려고
    // 브라우저가 받는 모듈에만 지연을 심는다. 저장소 파일은 바꾸지 않는다.
    await page.route("**/client/v3/dialogues-api.ts*", async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        "value = document;",
        "await new Promise((resolve) => setTimeout(resolve, 4000)); value = document;",
      );
      await route.fulfill({ response, body });
    });
    await page.goto(`${baseUrl}/dialogues?sample=document-overlay`, { waitUntil: "domcontentloaded" });
    const loading = page.locator('[data-slot="frame-loading"]').first();
    await loading.waitFor({ state: "visible", timeout: 20_000 });
    const label = (await loading.textContent())?.trim() ?? null;
    await page.screenshot({ path: path.join(output, `document-loading-1440-${suffix}.png`), animations: "disabled" });
    return { label };
  } finally {
    await context.close();
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
