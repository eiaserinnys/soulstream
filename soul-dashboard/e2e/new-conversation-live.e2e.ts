/**
 * New Conversation Live E2E 테스트 — 실제 서버 접속
 *
 * 실제 Soul Dashboard 서버(localhost:3109)에 접속하여
 * "New Conversation" 흐름을 검증합니다.
 *
 * 실행: npx playwright test new-conversation-live --config=playwright.config.ts
 *
 * 주의: 실제 서버가 실행 중이어야 합니다.
 * - Dashboard Server: http://localhost:3109
 * - Soul Server: http://localhost:3105
 */

import { test, expect } from "@playwright/test";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DASHBOARD_URL = "http://localhost:3109";
const SCREENSHOT_DIR = path.join(__dirname, "screenshots", "live");

test.describe("Live New Conversation 진단", () => {
  test.beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  // 서버 접속 가능 여부 확인
  test.beforeEach(async () => {
    try {
      const res = await fetch(`${DASHBOARD_URL}/api/health`);
      if (!res.ok) test.skip();
    } catch {
      test.skip();
    }
  });

  test("1. 실제 서버 초기 상태 진단", async ({ page }) => {
    // 콘솔 로그 수집
    const consoleLogs: string[] = [];
    page.on("console", (msg) => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    // 네트워크 요청/응답 추적
    const networkLog: Array<{
      method: string;
      url: string;
      status?: number;
      timing?: number;
    }> = [];

    page.on("request", (req) => {
      if (req.url().includes("/api/")) {
        networkLog.push({
          method: req.method(),
          url: req.url(),
        });
      }
    });

    page.on("response", (res) => {
      if (res.url().includes("/api/")) {
        const entry = networkLog.find(
          (e) => e.url === res.url() && !e.status,
        );
        if (entry) {
          entry.status = res.status();
          entry.timing = res.request().timing().responseEnd;
        }
      }
    });

    await page.goto(DASHBOARD_URL);

    // 대시보드 로드 대기
    const layout = page.locator('[data-testid="dashboard-layout"]');
    await expect(layout).toBeVisible({ timeout: 15_000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-live-initial.png`,
      fullPage: true,
    });

    // 세션 목록 로드 대기 (실제 서버에서는 시간이 걸릴 수 있음)
    const sessionList = page.locator('[data-testid="session-list"]');
    await expect(sessionList).toBeVisible({ timeout: 10_000 });

    // 세션이 있는지 확인 (기존 세션 존재 여부)
    await page.waitForTimeout(3000); // SSE 연결 + 세션 로드 대기

    const sessionItems = page.locator('[data-testid^="session-item-"]');
    const sessionCount = await sessionItems.count();
    console.log(`[Live Test] Session count: ${sessionCount}`);

    // Composer 상태 확인
    const composer = page.locator('[data-testid="prompt-composer"]');
    const composerVisible = await composer.isVisible();
    console.log(`[Live Test] Composer visible: ${composerVisible}`);

    // Composer 내용 확인
    if (composerVisible) {
      const composerText = await composer.textContent();
      console.log(`[Live Test] Composer content: ${composerText}`);
    }

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-live-loaded.png`,
      fullPage: true,
    });

    // 네트워크 요약
    console.log(`[Live Test] Network log:`);
    for (const entry of networkLog) {
      console.log(
        `  ${entry.method} ${entry.url} → ${entry.status ?? "pending"}`,
      );
    }
  });

  test("2. 실제 서버에서 New Conversation 전체 흐름 (진단 모드)", async ({
    page,
  }) => {
    // 콘솔 로그 수집
    const consoleLogs: string[] = [];
    page.on("console", (msg) => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    // 네트워크 요청/응답 추적
    const networkLog: Array<{
      method: string;
      url: string;
      status?: number;
      startTime: number;
      endTime?: number;
    }> = [];

    page.on("request", (req) => {
      if (req.url().includes("/api/")) {
        networkLog.push({
          method: req.method(),
          url: req.url(),
          startTime: Date.now(),
        });
      }
    });

    page.on("response", (res) => {
      if (res.url().includes("/api/")) {
        const entry = networkLog.find(
          (e) =>
            e.url === res.url() &&
            e.method === res.request().method() &&
            !e.status,
        );
        if (entry) {
          entry.status = res.status();
          entry.endTime = Date.now();
        }
      }
    });

    await page.goto(DASHBOARD_URL);

    // 세션 목록 로드 대기
    await page.waitForTimeout(3000);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-live-before-new.png`,
      fullPage: true,
    });

    // Composer가 보이지 않으면 기존 세션이 선택된 상태 → "+ New" 클릭
    const composer = page.locator('[data-testid="prompt-composer"]');
    if (!(await composer.isVisible())) {
      const newButton = page.locator('[data-testid="new-session-button"]');
      await newButton.click();
      await expect(composer).toBeVisible({ timeout: 5_000 });
    }

    // "Connecting to server..." 상태인지 확인
    const connectingText = composer.locator("text=Connecting to server...");
    const isConnecting = await connectingText.isVisible().catch(() => false);
    console.log(
      `[Live Test 2] Connecting to server state: ${isConnecting}`,
    );

    if (isConnecting) {
      console.log(
        "[Live Test 2] ⚠️ Composer is in 'Connecting to server...' state!",
      );
      console.log(
        "[Live Test 2] This means sessionsLoading is true — SSE session list not yet connected",
      );

      // 최대 10초 대기
      await expect(connectingText).not.toBeVisible({ timeout: 10_000 });
    }

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-live-composer-ready.png`,
      fullPage: true,
    });

    // 간단한 테스트 프롬프트 입력
    const textarea = composer.locator("textarea");
    await textarea.fill("E2E live test - please respond briefly");

    const submitButton = page.locator('[data-testid="compose-submit"]');
    await expect(submitButton).toBeEnabled();

    // 제출 전 시간 기록
    const submitTime = Date.now();
    await submitButton.click();

    console.log(`[Live Test 2] Submit clicked at t=0`);

    // 200ms 간격으로 상태 변화 추적 (최대 30초)
    const stateSnapshots: Array<{
      t: number;
      composerVisible: boolean;
      composerContent: string;
      activeItems: string[];
      url: string;
      graphHasNodes: boolean;
      submitButtonText: string;
    }> = [];

    for (let i = 0; i < 150; i++) {
      await page.waitForTimeout(200);
      const elapsed = Date.now() - submitTime;

      const snapshot = await page.evaluate(() => {
        const composerEl = document.querySelector(
          '[data-testid="prompt-composer"]',
        );
        const activeItems = Array.from(
          document.querySelectorAll(
            'button[data-testid^="session-item-"].border-l-accent-blue',
          ),
        ).map((el) => el.getAttribute("data-testid") ?? "");
        const rfNodes = document.querySelectorAll(".react-flow__node");
        const submitBtn = document.querySelector(
          '[data-testid="compose-submit"]',
        );
        const errorEl = composerEl?.querySelector(".text-accent-red");

        return {
          composerVisible: composerEl !== null,
          composerContent: errorEl?.textContent ?? "",
          activeItems,
          url: window.location.pathname,
          graphHasNodes: rfNodes.length > 0,
          submitButtonText: submitBtn?.textContent ?? "",
        };
      });

      stateSnapshots.push({ t: elapsed, ...snapshot });

      // "Starting..." 상태 로깅
      if (
        snapshot.composerVisible &&
        snapshot.submitButtonText.includes("Starting")
      ) {
        if (i % 5 === 0) {
          console.log(
            `[Live Test 2] t=${elapsed}ms: Still "Starting..." (waiting for POST response)`,
          );
        }
      }

      // 에러 발생 시 로깅
      if (snapshot.composerContent) {
        console.log(
          `[Live Test 2] t=${elapsed}ms: Error in composer: ${snapshot.composerContent}`,
        );
        break;
      }

      // 세션 활성화 완료
      if (!snapshot.composerVisible && snapshot.activeItems.length > 0) {
        console.log(
          `[Live Test 2] t=${elapsed}ms: Session activated! active=${snapshot.activeItems[0]}, url=${snapshot.url}`,
        );

        // 노드 렌더링까지 조금 더 대기
        if (snapshot.graphHasNodes) {
          console.log(
            `[Live Test 2] t=${elapsed}ms: Nodes rendered.`,
          );
          break;
        }
      }

      // 30초 타임아웃
      if (elapsed > 30000) {
        console.log(
          `[Live Test 2] t=${elapsed}ms: TIMEOUT - session not activated`,
        );
        break;
      }
    }

    // 스크린샷 캡처
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-live-after-submit.png`,
      fullPage: true,
    });

    // 네트워크 요약
    console.log(`\n[Live Test 2] Network log:`);
    for (const entry of networkLog) {
      const duration = entry.endTime
        ? `${entry.endTime - entry.startTime}ms`
        : "pending";
      console.log(
        `  ${entry.method} ${new URL(entry.url).pathname} → ${entry.status ?? "?"} (${duration})`,
      );
    }

    // 결과 진단
    const finalState = stateSnapshots[stateSnapshots.length - 1];

    console.log(`\n[Live Test 2] Final state:`);
    console.log(
      `  Composer visible: ${finalState.composerVisible}`,
    );
    console.log(
      `  Active items: ${JSON.stringify(finalState.activeItems)}`,
    );
    console.log(`  URL: ${finalState.url}`);
    console.log(`  Graph has nodes: ${finalState.graphHasNodes}`);
    console.log(
      `  Submit button text: ${finalState.submitButtonText}`,
    );

    if (finalState.composerVisible) {
      console.log(
        `\n[Live Test 2] ⚠️ BUG CONFIRMED: Composer is still visible after submit!`,
      );
      console.log(
        `  Possible causes:`,
      );
      console.log(
        `  1. POST /api/sessions failed or is still pending`,
      );
      console.log(
        `  2. completeCompose was not called (error before it)`,
      );
      console.log(
        `  3. activeSessionKey was reset after being set`,
      );
    }

    // POST /api/sessions 응답 확인
    const postEntry = networkLog.find(
      (e) => e.method === "POST" && e.url.includes("/api/sessions"),
    );
    if (postEntry) {
      console.log(
        `\n[Live Test 2] POST /api/sessions: status=${postEntry.status}, took=${postEntry.endTime ? postEntry.endTime - postEntry.startTime : "pending"}ms`,
      );
    } else {
      console.log(`\n[Live Test 2] ⚠️ POST /api/sessions was never sent!`);
    }

    // SSE 연결 확인
    const sseEntries = networkLog.filter(
      (e) => e.method === "GET" && e.url.includes("/events"),
    );
    console.log(
      `\n[Live Test 2] SSE event subscriptions: ${sseEntries.length}`,
    );
    for (const entry of sseEntries) {
      console.log(
        `  ${new URL(entry.url).pathname} → ${entry.status ?? "?"}`,
      );
    }

    // 실패 스크린샷
    if (finalState.composerVisible) {
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/06-live-bug-confirmed.png`,
        fullPage: true,
      });
    }
  });

  test("3. sessionsLoading 상태가 풀리는지 진단", async ({ page }) => {
    /**
     * sessionsLoading이 true인 동안 PromptComposer는
     * "Connecting to server..." 화면만 보여줌.
     * 이 상태가 영원히 유지되면 사용자는 프롬프트를 입력할 수 없음.
     */
    const consoleLogs: string[] = [];
    page.on("console", (msg) => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    await page.goto(DASHBOARD_URL);

    const startTime = Date.now();
    const stateLog: Array<{
      t: number;
      connecting: boolean;
      composerReady: boolean;
      sessionCount: number;
    }> = [];

    for (let i = 0; i < 50; i++) {
      await page.waitForTimeout(200);
      const elapsed = Date.now() - startTime;

      const state = await page.evaluate(() => {
        const connectingEl = document.querySelector(
          '[data-testid="prompt-composer"]',
        );
        const connectingText = connectingEl?.textContent?.includes(
          "Connecting to server",
        );
        const textarea = connectingEl?.querySelector("textarea");
        const sessions = document.querySelectorAll(
          '[data-testid^="session-item-"]',
        );

        return {
          connecting: !!connectingText,
          composerReady: textarea !== null,
          sessionCount: sessions.length,
        };
      });

      stateLog.push({ t: elapsed, ...state });

      // textarea가 보이면 준비 완료
      if (state.composerReady) {
        console.log(
          `[Live Test 3] Composer ready after ${elapsed}ms (${state.sessionCount} sessions loaded)`,
        );
        break;
      }

      if (state.connecting && i % 5 === 0) {
        console.log(
          `[Live Test 3] t=${elapsed}ms: Still "Connecting to server..."`,
        );
      }
    }

    const finalState = stateLog[stateLog.length - 1];
    if (!finalState.composerReady) {
      console.log(
        `[Live Test 3] ⚠️ Composer never became ready after ${finalState.t}ms!`,
      );
      console.log(
        `  connecting: ${finalState.connecting}`,
      );
      console.log(
        `  This means sessionsLoading is stuck at true.`,
      );
      console.log(
        `  Possible cause: SSE /api/sessions/stream never sent session_list event.`,
      );
    }

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/07-live-sessions-loading.png`,
      fullPage: true,
    });
  });
});
