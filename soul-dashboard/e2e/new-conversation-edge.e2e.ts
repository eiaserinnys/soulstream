/**
 * New Conversation 엣지 케이스 E2E 테스트
 *
 * 실제 서버 환경에서 발생할 수 있는 타이밍 이슈, 레이스 컨디션을 검증합니다:
 * - 서버 응답 지연 (POST /api/sessions가 3초+ 소요)
 * - 세션 목록 SSE가 session_created를 completeCompose보다 먼저 전송
 * - POST /api/sessions 에러 후 복구
 * - 연속 세션 생성
 *
 * 사전 요건: `npx vite build` 실행으로 dist/client/ 생성
 */

import { test as base, expect, type Page } from "@playwright/test";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { createServer, type Server } from "http";
import type {
  CreateSessionResponse,
  InterveneResponse,
} from "../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Mock Server Fixture ===

interface MockDashboardServer {
  port: number;
  baseURL: string;
  server: Server;
  /** POST 응답 지연 (ms) */
  setPostDelay: (ms: number) => void;
  /** POST 에러 모드 (다음 N회 에러) */
  setPostErrorCount: (count: number) => void;
  /** 세션 목록 SSE에 session_created 이벤트 전송 */
  sendSessionCreated: (agentSessionId: string, prompt: string) => void;
  /** 기록 */
  createSessionCalls: Array<{ prompt: string; agentSessionId?: string }>;
  eventSubscriptions: string[];
}

const test = base.extend<
  { dashboardServer: MockDashboardServer },
  { dashboardServer: MockDashboardServer }
>({
  dashboardServer: [
    async ({}, use) => {
      const app = express();
      app.use(express.json());

      let postDelay = 0;
      let postErrorCount = 0;
      let sessionCounter = 0;

      // SSE 연결 목록 (session_created 이벤트 전송용)
      const sseConnections: express.Response[] = [];

      const createSessionCalls: MockDashboardServer["createSessionCalls"] = [];
      const eventSubscriptions: string[] = [];

      const existingSessions = [
        {
          agent_session_id: "sess-existing-001",
          status: "completed",
          prompt: "기존 세션 1",
          created_at: new Date(Date.now() - 3600000).toISOString(),
          updated_at: new Date(Date.now() - 3500000).toISOString(),
        },
      ];

      // 세션 목록 API
      app.get("/api/sessions", (_req, res) => {
        res.json({ sessions: existingSessions });
      });

      // 세션 목록 SSE — 연결을 유지하고 나중에 session_created 전송 가능
      app.get("/api/sessions/stream", (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const data = JSON.stringify({
          type: "session_list",
          sessions: existingSessions,
        });
        res.write(`event: session_list\ndata: ${data}\n\n`);

        sseConnections.push(res);
        _req.on("close", () => {
          const idx = sseConnections.indexOf(res);
          if (idx >= 0) sseConnections.splice(idx, 1);
          res.end();
        });
      });

      // 세션 생성 API — 지연 + 에러 시뮬레이션
      app.post("/api/sessions", async (req, res) => {
        createSessionCalls.push({
          prompt: req.body.prompt,
          agentSessionId: req.body.agentSessionId,
        });

        // 에러 모드
        if (postErrorCount > 0) {
          postErrorCount--;
          res.status(500).json({
            error: {
              code: "INTERNAL_ERROR",
              message: "Simulated server error",
            },
          });
          return;
        }

        // 지연 시뮬레이션
        if (postDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, postDelay));
        }

        sessionCounter++;
        const agentSessionId =
          req.body.agentSessionId ??
          `sess-new-${String(sessionCounter).padStart(3, "0")}`;

        const response: CreateSessionResponse = {
          agentSessionId,
          status: "running",
        };
        res.status(201).json(response);
      });

      // 세션 이벤트 SSE
      app.get("/api/sessions/:id/events", (req, res) => {
        const sessionId = req.params.id;
        eventSubscriptions.push(sessionId);

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("event: connected\ndata: {}\n\n");

        const timers: NodeJS.Timeout[] = [];
        res.on("close", () => timers.forEach(clearTimeout));

        // 기본 이벤트 시퀀스
        timers.push(
          setTimeout(() => {
            if (!res.writableEnded) {
              res.write(
                `id: 0\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"Hello"}\n\n`,
              );
            }
          }, 100),
        );
        timers.push(
          setTimeout(() => {
            if (!res.writableEnded) {
              res.write(
                `id: 1\nevent: text_start\ndata: {"type":"text_start","card_id":"t1-${sessionId}"}\n\n`,
              );
            }
          }, 200),
        );
        timers.push(
          setTimeout(() => {
            if (!res.writableEnded) {
              res.write(
                `id: 2\nevent: text_delta\ndata: {"type":"text_delta","card_id":"t1-${sessionId}","text":"Response for ${sessionId}"}\n\n`,
              );
            }
          }, 400),
        );
        timers.push(
          setTimeout(() => {
            if (!res.writableEnded) {
              res.write(
                `id: 3\nevent: text_end\ndata: {"type":"text_end","card_id":"t1-${sessionId}"}\n\n`,
              );
            }
          }, 600),
        );
        timers.push(
          setTimeout(() => {
            if (!res.writableEnded) {
              res.write(
                `id: 4\nevent: complete\ndata: {"type":"complete","result":"Done","attachments":[]}\n\n`,
              );
              res.end();
            }
          }, 800),
        );
      });

      // Config / Health
      app.get("/api/config/settings", (_req, res) =>
        res.json({ serendipityAvailable: false, categories: [] }),
      );
      app.get("/api/auth/config", (_req, res) =>
        res.json({ authEnabled: false, devModeEnabled: true }),
      );
      app.get("/api/health", (_req, res) =>
        res.json({ status: "ok", service: "soul-dashboard" }),
      );

      // 정적 파일 서빙
      const clientDistDir = path.resolve(__dirname, "../dist/client");
      app.use(express.static(clientDistDir));
      app.get("/{*splat}", (_req, res) => {
        res.sendFile(path.join(clientDistDir, "index.html"));
      });

      const server = createServer(app);
      const port = await new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(0, () => {
          server.removeListener("error", onError);
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
      });

      const baseURL = `http://localhost:${port}`;

      const sendSessionCreated = (
        agentSessionId: string,
        prompt: string,
      ) => {
        const event = {
          type: "session_created",
          session: {
            agent_session_id: agentSessionId,
            status: "running",
            prompt,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        };
        const data = JSON.stringify(event);
        for (const conn of sseConnections) {
          if (!conn.writableEnded) {
            conn.write(`event: session_created\ndata: ${data}\n\n`);
          }
        }
      };

      await use({
        port,
        baseURL,
        server,
        setPostDelay: (ms: number) => {
          postDelay = ms;
        },
        setPostErrorCount: (count: number) => {
          postErrorCount = count;
        },
        sendSessionCreated,
        createSessionCalls,
        eventSubscriptions,
      });

      server.closeAllConnections();
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    },
    { scope: "worker" },
  ],
});

const SCREENSHOT_DIR = path.join(
  __dirname,
  "screenshots",
  "new-conversation-edge",
);

async function waitForDashboard(page: Page, baseURL: string) {
  await page.goto(baseURL);
  await expect(
    page.locator('[data-testid^="session-item-"]'),
  ).toHaveCount(1, { timeout: 10_000 });
}

// === Tests ===

test.describe("New Conversation 엣지 케이스", () => {
  test.beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("1. 서버 응답 지연 (3초) → 세션이 여전히 활성화됨", async ({
    page,
    dashboardServer,
  }) => {
    // POST 응답을 3초 지연시킴
    dashboardServer.setPostDelay(3000);

    await waitForDashboard(page, dashboardServer.baseURL);

    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // 프롬프트 입력 및 제출
    const textarea = composer.locator("textarea");
    await textarea.fill("지연 테스트 프롬프트");

    const submitButton = page.locator('[data-testid="compose-submit"]');
    await submitButton.click();

    // "Starting..." 상태가 표시됨
    await expect(submitButton).toContainText("Starting...");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-slow-response-waiting.png`,
      fullPage: true,
    });

    // 3초 후 응답 → Composer 사라짐
    await expect(composer).not.toBeVisible({ timeout: 10_000 });

    // 새 세션이 활성화됨
    const newSessionItem = page.locator(
      '[data-testid="session-item-sess-new-001"]',
    );
    await expect(newSessionItem).toBeVisible({ timeout: 5_000 });
    await expect(newSessionItem).toHaveClass(/border-l-accent-blue/);

    // SSE 구독 시작됨
    await page.waitForTimeout(500);
    expect(dashboardServer.eventSubscriptions).toContain("sess-new-001");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-slow-response-activated.png`,
      fullPage: true,
    });

    // 지연 리셋
    dashboardServer.setPostDelay(0);
  });

  test("2. POST 에러 → Composer에 에러 표시 + 재시도 가능", async ({
    page,
    dashboardServer,
  }) => {
    // 첫 1회는 에러, 이후 성공
    dashboardServer.setPostErrorCount(1);

    await waitForDashboard(page, dashboardServer.baseURL);

    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    const textarea = composer.locator("textarea");
    await textarea.fill("에러 테스트");

    const submitButton = page.locator('[data-testid="compose-submit"]');
    await submitButton.click();

    // 에러 메시지가 표시됨
    const errorMessage = composer.locator(".text-accent-red");
    await expect(errorMessage).toBeVisible({ timeout: 5_000 });

    // Composer는 여전히 보임 (에러 상태)
    await expect(composer).toBeVisible();
    await expect(textarea).toHaveValue("에러 테스트");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-post-error.png`,
      fullPage: true,
    });

    // 재시도 (이번엔 성공)
    await submitButton.click();

    // 세션 생성 성공
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-post-error-retry-success.png`,
      fullPage: true,
    });
  });

  test("3. 세션 목록 SSE가 session_created 전송 → completeCompose와 레이스 처리", async ({
    page,
    dashboardServer,
  }) => {
    // POST 응답을 1초 지연 → 그 사이에 SSE session_created 전송
    dashboardServer.setPostDelay(1000);

    await waitForDashboard(page, dashboardServer.baseURL);

    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    const textarea = composer.locator("textarea");
    await textarea.fill("레이스 컨디션 테스트");

    const submitButton = page.locator('[data-testid="compose-submit"]');
    await submitButton.click();

    // POST가 아직 응답하지 않은 상태에서 SSE로 session_created 전송
    // 이 경우 addSession이 먼저 호출되고, completeCompose가 나중에 호출됨
    await page.waitForTimeout(200);
    dashboardServer.sendSessionCreated(
      "sess-new-001",
      "레이스 컨디션 테스트",
    );

    // POST 응답 후 completeCompose가 중복 세션을 추가하지 않아야 함
    await expect(composer).not.toBeVisible({ timeout: 10_000 });

    // 세션이 목록에 한 번만 표시됨 (중복 없음)
    const sessionItems = page.locator('[data-testid^="session-item-"]');
    const sessionTexts = await sessionItems.allTextContents();
    const newSessionCount = sessionTexts.filter((t) =>
      t.includes("레이스 컨디션"),
    ).length;
    // 1개: 기존 세션 + 1개: 새 세션 = 총 2개 아이템, 새 세션은 1개만
    expect(newSessionCount).toBeLessThanOrEqual(1);

    // 새 세션이 활성화됨
    await expect(page).toHaveURL(/\/sess-new-001/, { timeout: 5_000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-race-condition-handled.png`,
      fullPage: true,
    });

    dashboardServer.setPostDelay(0);
  });

  test("4. 연속 세션 생성 → 각각 올바르게 활성화됨", async ({
    page,
    dashboardServer,
  }) => {
    await waitForDashboard(page, dashboardServer.baseURL);

    // 첫 번째 세션 생성
    let composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    let textarea = composer.locator("textarea");
    await textarea.fill("첫 번째 세션");
    await page.locator('[data-testid="compose-submit"]').click();

    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // 첫 번째 세션 URL 캡처
    const firstSessionUrl = page.url();
    const firstSessionMatch = firstSessionUrl.match(/\/(sess-new-\d+)/);
    expect(firstSessionMatch).not.toBeNull();
    const firstSessionId = firstSessionMatch![1];

    // 잠시 대기 후 "+ New" 클릭
    await page.waitForTimeout(500);
    const newButton = page.locator('[data-testid="new-session-button"]');
    await expect(newButton).toBeEnabled({ timeout: 5_000 });
    await newButton.click();

    // 두 번째 세션 생성
    composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    textarea = composer.locator("textarea");
    await textarea.fill("두 번째 세션");
    await page.locator('[data-testid="compose-submit"]').click();

    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // 두 번째 세션이 활성화됨 (첫 번째가 아님!)
    const secondSessionUrl = page.url();
    const secondSessionMatch = secondSessionUrl.match(/\/(sess-new-\d+)/);
    expect(secondSessionMatch).not.toBeNull();
    const secondSessionId = secondSessionMatch![1];

    // 두 번째 세션은 첫 번째와 다른 ID
    expect(secondSessionId).not.toBe(firstSessionId);

    // 두 세션 모두 목록에 있음
    await expect(
      page.locator(`[data-testid="session-item-${firstSessionId}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="session-item-${secondSessionId}"]`),
    ).toBeVisible();

    // 두 번째 세션이 active
    const activeItem = page.locator(
      `[data-testid="session-item-${secondSessionId}"]`,
    );
    await expect(activeItem).toHaveClass(/border-l-accent-blue/);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-consecutive-sessions.png`,
      fullPage: true,
    });
  });

  test("5. 지연 중 Escape 키 → compose 취소 후 재시도", async ({
    page,
    dashboardServer,
  }) => {
    await waitForDashboard(page, dashboardServer.baseURL);

    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // 프롬프트 입력하지 않고 Escape
    await page.keyboard.press("Escape");

    // cancelCompose가 호출됨, 하지만 activeSessionKey는 여전히 null
    // → DashboardLayout에서 showComposer = !activeSessionKey = true
    // → Composer가 여전히 보임 (이것이 의도된 동작인지 확인)

    // 이 동작을 캡처해서 진단
    const storeState = await page.evaluate(() => {
      // DOM 기반으로 상태 추론
      const composerEl = document.querySelector(
        '[data-testid="prompt-composer"]',
      );
      const newBtn = document.querySelector(
        '[data-testid="new-session-button"]',
      ) as HTMLButtonElement | null;
      return {
        composerVisible: composerEl !== null,
        newButtonDisabled: newBtn?.disabled ?? null,
        url: window.location.pathname,
      };
    });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/07-escape-state.png`,
      fullPage: true,
    });

    // 진단 정보 기록
    console.log("[Edge Test 5] After Escape:", JSON.stringify(storeState));

    // Escape 후에도 프롬프트를 다시 입력하고 제출할 수 있어야 함
    const textarea = composer.locator("textarea");
    await textarea.fill("Escape 후 재시도");
    const submitButton = page.locator('[data-testid="compose-submit"]');
    await submitButton.click();

    await expect(composer).not.toBeVisible({ timeout: 5_000 });
  });

  test("6. isComposing과 activeSessionKey 상태 불일치 진단", async ({
    page,
    dashboardServer,
  }) => {
    /**
     * 이 테스트는 핵심 버그 시나리오를 재현합니다:
     * "새 대화를 시작해도 세션이 선택되지 않는" 현상.
     *
     * 가능한 원인:
     * 1. completeCompose 후 isComposing=false, activeSessionKey=set 인데
     *    DashboardLayout의 showComposer가 여전히 true
     * 2. useSessionProvider가 새 세션 키로 구독을 시작하지 않음
     * 3. URL이 업데이트되지 않음
     */
    await waitForDashboard(page, dashboardServer.baseURL);

    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // 제출 전 상태 캡처
    const beforeState = await page.evaluate(() => {
      const composerEl = document.querySelector('[data-testid="prompt-composer"]');
      const graphPanelChildren = document.querySelector('[data-testid="graph-panel"]')?.children.length;
      return {
        composerVisible: composerEl !== null,
        graphPanelChildren,
        url: window.location.pathname,
      };
    });
    console.log("[Edge Test 6] Before submit:", JSON.stringify(beforeState));

    // 프롬프트 입력 및 제출
    const textarea = composer.locator("textarea");
    await textarea.fill("상태 불일치 진단 테스트");
    await page.locator('[data-testid="compose-submit"]').click();

    // 200ms 간격으로 상태 변화 추적
    const stateSnapshots: Array<{
      t: number;
      composerVisible: boolean;
      activeItems: string[];
      url: string;
      graphHasNodes: boolean;
    }> = [];

    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(200);

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

        return {
          composerVisible: composerEl !== null,
          activeItems,
          url: window.location.pathname,
          graphHasNodes: rfNodes.length > 0,
        };
      });

      stateSnapshots.push({ t: i * 200, ...snapshot });

      // 세션이 활성화되고 노드가 렌더링되면 중단
      if (
        !snapshot.composerVisible &&
        snapshot.activeItems.length > 0 &&
        snapshot.graphHasNodes
      ) {
        break;
      }
    }

    console.log(
      "[Edge Test 6] State snapshots:",
      JSON.stringify(stateSnapshots, null, 2),
    );

    // 최종 상태 검증
    const finalState = stateSnapshots[stateSnapshots.length - 1];
    expect(finalState.composerVisible).toBe(false);
    expect(finalState.activeItems.length).toBeGreaterThan(0);
    expect(finalState.url).not.toBe("/");

    // Composer가 사라지는 데 걸린 시간 확인
    const composerHiddenIdx = stateSnapshots.findIndex(
      (s) => !s.composerVisible,
    );
    if (composerHiddenIdx >= 0) {
      console.log(
        `[Edge Test 6] Composer hidden after ~${stateSnapshots[composerHiddenIdx].t}ms`,
      );
    }

    // 노드가 렌더링되기까지 걸린 시간
    const nodesRenderedIdx = stateSnapshots.findIndex((s) => s.graphHasNodes);
    if (nodesRenderedIdx >= 0) {
      console.log(
        `[Edge Test 6] Nodes rendered after ~${stateSnapshots[nodesRenderedIdx].t}ms`,
      );
    }

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/08-state-diagnosis.png`,
      fullPage: true,
    });
  });
});
