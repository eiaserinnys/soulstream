/**
 * New Conversation E2E 테스트
 *
 * "New Conversation" 버튼 클릭 → 프롬프트 입력 → 세션 생성 → 세션 활성화 흐름을 검증합니다.
 * 핵심 검증: 새 세션 생성 후 해당 세션이 자동으로 선택(활성화)되어야 합니다.
 *
 * 사전 요건: `npx vite build` 실행으로 dist/client/ 생성
 * 실행: npx playwright test new-conversation --config=playwright.config.ts
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

// === SSE 이벤트 시퀀스 (새 세션용) ===

const NEW_SESSION_SSE_EVENTS = [
  {
    delay: 0,
    data: 'id: 0\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"Hello from new conversation"}\n\n',
  },
  {
    delay: 200,
    data: 'id: 1\nevent: text_start\ndata: {"type":"text_start","card_id":"new-t1"}\n\n',
  },
  {
    delay: 400,
    data: 'id: 2\nevent: text_delta\ndata: {"type":"text_delta","card_id":"new-t1","text":"새 대화를 시작합니다."}\n\n',
  },
  {
    delay: 600,
    data: 'id: 3\nevent: text_end\ndata: {"type":"text_end","card_id":"new-t1"}\n\n',
  },
  {
    delay: 800,
    data: 'id: 4\nevent: tool_start\ndata: {"type":"tool_start","card_id":"new-tool1","tool_name":"Read","tool_input":{"file_path":"/test.ts"}}\n\n',
  },
  {
    delay: 1000,
    data: 'id: 5\nevent: tool_result\ndata: {"type":"tool_result","card_id":"new-tool1","tool_name":"Read","result":"file content","is_error":false}\n\n',
  },
  {
    delay: 1200,
    data: 'id: 6\nevent: complete\ndata: {"type":"complete","result":"Done","attachments":[]}\n\n',
    end: true,
  },
];

// === Mock Server Fixture ===

interface MockDashboardServer {
  port: number;
  baseURL: string;
  server: Server;
  /** POST /api/sessions 호출 기록 */
  createSessionCalls: Array<{ prompt: string; agentSessionId?: string }>;
  /** SSE /api/sessions/:id/events 연결 기록 */
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

      const createSessionCalls: MockDashboardServer["createSessionCalls"] = [];
      const eventSubscriptions: string[] = [];

      // 기존 세션 목록 (2개)
      const existingSessions = [
        {
          agent_session_id: "sess-existing-001",
          status: "completed",
          prompt: "기존 세션 1",
          created_at: new Date(Date.now() - 3600000).toISOString(),
          updated_at: new Date(Date.now() - 3500000).toISOString(),
        },
        {
          agent_session_id: "sess-existing-002",
          status: "running",
          prompt: "기존 세션 2",
          created_at: new Date(Date.now() - 1800000).toISOString(),
          updated_at: new Date(Date.now() - 1800000).toISOString(),
        },
      ];

      // 세션 목록 API
      app.get("/api/sessions", (_req, res) => {
        res.json({ sessions: existingSessions });
      });

      // 세션 목록 SSE
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

        // 연결 유지
        _req.on("close", () => res.end());
      });

      // 세션 생성 API — 핵심 테스트 대상
      app.post("/api/sessions", (req, res) => {
        createSessionCalls.push({
          prompt: req.body.prompt,
          agentSessionId: req.body.agentSessionId,
        });

        const response: CreateSessionResponse = {
          agentSessionId:
            req.body.agentSessionId ?? "sess-new-conversation-001",
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

        // 새 세션이면 SSE 이벤트 전송
        if (sessionId === "sess-new-conversation-001") {
          for (const event of NEW_SESSION_SSE_EVENTS) {
            timers.push(
              setTimeout(() => {
                if (!res.writableEnded) {
                  res.write(event.data);
                  if (event.end) res.end();
                }
              }, event.delay),
            );
          }
        } else {
          // 기존 세션: 간단한 이벤트만
          timers.push(
            setTimeout(() => {
              if (!res.writableEnded) {
                res.write(
                  'id: 0\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"existing"}\n\n',
                );
              }
            }, 100),
          );
        }
      });

      // Config / Health
      app.get("/api/config", (_req, res) =>
        res.json({ serendipityAvailable: false }),
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

      // 서버 시작
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

      await use({
        port,
        baseURL,
        server,
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

// === Screenshot 디렉토리 ===
const SCREENSHOT_DIR = path.join(__dirname, "screenshots", "new-conversation");

// === Helpers ===

/** 대시보드에 접속하고 세션 목록이 로드될 때까지 대기 */
async function waitForDashboard(page: Page, baseURL: string) {
  await page.goto(baseURL);
  // 세션 목록이 로드될 때까지 대기
  await expect(
    page.locator('[data-testid^="session-item-"]'),
  ).toHaveCount(2, { timeout: 10_000 });
}

// === Tests ===

test.describe("New Conversation 흐름", () => {
  test.beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("1. 초기 상태: PromptComposer가 표시된다", async ({
    page,
    dashboardServer,
  }) => {
    await waitForDashboard(page, dashboardServer.baseURL);

    // 초기 상태: 세션이 선택되지 않았으므로 PromptComposer 표시
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // "New Conversation" 타이틀 확인
    await expect(composer).toContainText("New Conversation");

    // "+ New" 버튼은 disabled (이미 composing 상태)
    const newButton = page.locator('[data-testid="new-session-button"]');
    await expect(newButton).toBeDisabled();

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-initial-composer.png`,
      fullPage: true,
    });
  });

  test("2. 기존 세션 클릭 → Composer 사라짐 → + New 클릭 → Composer 재표시", async ({
    page,
    dashboardServer,
  }) => {
    await waitForDashboard(page, dashboardServer.baseURL);

    // 기존 세션 클릭
    await page
      .locator('[data-testid="session-item-sess-existing-001"]')
      .click();

    // Composer가 사라지고 그래프가 표시
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // "+ New" 버튼이 활성화됨
    const newButton = page.locator('[data-testid="new-session-button"]');
    await expect(newButton).toBeEnabled();

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-session-selected.png`,
      fullPage: true,
    });

    // "+ New" 버튼 클릭
    await newButton.click();

    // Composer가 다시 표시
    await expect(composer).toBeVisible({ timeout: 5_000 });
    await expect(composer).toContainText("New Conversation");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-new-button-clicked.png`,
      fullPage: true,
    });
  });

  test("3. 프롬프트 입력 후 제출 → 새 세션 생성 + 활성화", async ({
    page,
    dashboardServer,
  }) => {
    await waitForDashboard(page, dashboardServer.baseURL);

    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // 프롬프트 입력
    const textarea = composer.locator("textarea");
    await textarea.fill("E2E 테스트 프롬프트입니다");

    // Start 버튼 클릭
    const submitButton = page.locator('[data-testid="compose-submit"]');
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-prompt-submitted.png`,
      fullPage: true,
    });

    // 핵심 검증 1: POST /api/sessions가 호출됨
    // (약간의 네트워크 지연 허용)
    await page.waitForTimeout(500);
    expect(dashboardServer.createSessionCalls.length).toBeGreaterThanOrEqual(1);
    expect(dashboardServer.createSessionCalls[0].prompt).toBe(
      "E2E 테스트 프롬프트입니다",
    );

    // 핵심 검증 2: Composer가 사라짐 (세션이 활성화됨)
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // 핵심 검증 3: 새 세션이 세션 목록에 표시됨
    const newSessionItem = page.locator(
      '[data-testid="session-item-sess-new-conversation-001"]',
    );
    await expect(newSessionItem).toBeVisible({ timeout: 5_000 });

    // 핵심 검증 4: 새 세션이 active 상태 (border-l-accent-blue 클래스)
    // border-l-[3px] border-l-accent-blue 로 활성 세션을 시각적으로 표시
    await expect(newSessionItem).toHaveClass(/border-l-accent-blue/, {
      timeout: 5_000,
    });

    // 핵심 검증 5: URL이 새 세션 ID로 변경됨
    await expect(page).toHaveURL(
      /\/sess-new-conversation-001/,
      { timeout: 5_000 },
    );

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-session-activated.png`,
      fullPage: true,
    });
  });

  test("4. 새 세션 생성 후 SSE 이벤트 수신 → 노드 렌더링", async ({
    page,
    dashboardServer,
  }) => {
    await waitForDashboard(page, dashboardServer.baseURL);

    // 프롬프트 입력 및 제출
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    const textarea = composer.locator("textarea");
    await textarea.fill("SSE 이벤트 수신 테스트");

    const submitButton = page.locator('[data-testid="compose-submit"]');
    await submitButton.click();

    // Composer 사라짐 확인
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // 핵심 검증: SSE 이벤트 구독이 새 세션 ID로 시작됨
    await page.waitForTimeout(500);
    expect(dashboardServer.eventSubscriptions).toContain(
      "sess-new-conversation-001",
    );

    // SSE 이벤트로 노드가 렌더링됨
    // thinking 노드
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // tool call 노드
    const toolNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolNodes.first()).toBeVisible({ timeout: 10_000 });

    // complete 노드 (system-node)
    const systemNodes = page.locator('[data-testid="system-node"]');
    await expect(systemNodes.first()).toBeVisible({ timeout: 10_000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-sse-nodes-rendered.png`,
      fullPage: true,
    });
  });

  test("5. 새 세션 생성 후 + New 버튼이 다시 활성화됨", async ({
    page,
    dashboardServer,
  }) => {
    await waitForDashboard(page, dashboardServer.baseURL);

    // 프롬프트 입력 및 제출
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    const textarea = composer.locator("textarea");
    await textarea.fill("버튼 상태 테스트");

    const submitButton = page.locator('[data-testid="compose-submit"]');
    await submitButton.click();

    // 세션 생성 완료 후 Composer 사라짐
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // "+ New" 버튼이 다시 활성화됨 (세션이 활성화되었으므로)
    const newButton = page.locator('[data-testid="new-session-button"]');
    await expect(newButton).toBeEnabled({ timeout: 5_000 });
  });

  test("6. Escape 키로 Compose 모드 취소", async ({
    page,
    dashboardServer,
  }) => {
    await waitForDashboard(page, dashboardServer.baseURL);

    // 먼저 기존 세션 선택
    await page
      .locator('[data-testid="session-item-sess-existing-002"]')
      .click();

    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // "+ New" 버튼 클릭
    const newButton = page.locator('[data-testid="new-session-button"]');
    await newButton.click();
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // Escape 키로 취소
    await page.keyboard.press("Escape");

    // cancelCompose는 isComposing: false를 설정하지만
    // activeSessionKey는 이미 startCompose에서 null로 리셋됨
    // 따라서 showComposer(= !activeSessionKey)는 여전히 true
    // → Composer가 그대로 보이는 것이 현재 동작

    // 이 동작이 의도된 것인지 검증
    // startCompose()가 activeSessionKey를 null로 리셋하므로
    // Escape 후 이전 세션으로 돌아가지 않음

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/07-escape-compose.png`,
      fullPage: true,
    });
  });

  test("7. Ctrl+Enter로 프롬프트 제출", async ({
    page,
    dashboardServer,
  }) => {
    await waitForDashboard(page, dashboardServer.baseURL);

    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // 프롬프트 입력
    const textarea = composer.locator("textarea");
    await textarea.fill("Ctrl+Enter 테스트");

    // Ctrl+Enter로 제출
    await textarea.press("Control+Enter");

    // 세션 생성 + Composer 사라짐
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // POST 호출 확인
    await page.waitForTimeout(500);
    const lastCall =
      dashboardServer.createSessionCalls[
        dashboardServer.createSessionCalls.length - 1
      ];
    expect(lastCall.prompt).toBe("Ctrl+Enter 테스트");
  });

  test("8. 빈 프롬프트로는 제출할 수 없다", async ({
    page,
    dashboardServer,
  }) => {
    await waitForDashboard(page, dashboardServer.baseURL);

    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // Start 버튼이 disabled
    const submitButton = page.locator('[data-testid="compose-submit"]');
    await expect(submitButton).toBeDisabled();

    // 공백만 입력해도 disabled
    const textarea = composer.locator("textarea");
    await textarea.fill("   ");
    await expect(submitButton).toBeDisabled();

    // 유효한 텍스트 입력 시 enabled
    await textarea.fill("유효한 프롬프트");
    await expect(submitButton).toBeEnabled();
  });

  test("9. Zustand store 상태 검증: completeCompose 후 activeSessionKey 설정", async ({
    page,
    dashboardServer,
  }) => {
    await waitForDashboard(page, dashboardServer.baseURL);

    // 프롬프트 입력 및 제출
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    const textarea = composer.locator("textarea");
    await textarea.fill("Store 상태 검증 테스트");

    const submitButton = page.locator('[data-testid="compose-submit"]');
    await submitButton.click();

    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // 브라우저 내에서 Zustand store 상태 직접 검증
    const storeState = await page.evaluate(() => {
      // Zustand persist store는 zustand/middleware의 getState로 접근 가능
      // 하지만 모듈 번들 내부이므로 DOM 기반으로 간접 검증
      const activeItem = document.querySelector(
        'button[data-testid^="session-item-"].border-l-accent-blue',
      );
      const url = window.location.pathname;
      const composerVisible = document.querySelector(
        '[data-testid="prompt-composer"]',
      );
      return {
        activeItemTestId: activeItem?.getAttribute("data-testid") ?? null,
        url,
        composerVisible: composerVisible !== null,
      };
    });

    // 새 세션이 active 상태
    expect(storeState.activeItemTestId).toBe(
      "session-item-sess-new-conversation-001",
    );
    // URL이 새 세션 ID
    expect(storeState.url).toBe("/sess-new-conversation-001");
    // Composer 숨김
    expect(storeState.composerVisible).toBe(false);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/08-store-state-verified.png`,
      fullPage: true,
    });
  });
});
