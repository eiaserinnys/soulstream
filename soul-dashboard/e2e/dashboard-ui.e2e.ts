/**
 * Soul Dashboard 브라우저 UI E2E 테스트
 *
 * 실제 브라우저에서 대시보드를 렌더링하고 각 단계마다 스크린샷을 캡처합니다.
 * 빌드된 클라이언트(dist/client/)를 Mock Express 서버에서 직접 서빙하며,
 * Mock API 엔드포인트(세션 목록, SSE 이벤트)도 같은 서버에서 제공합니다.
 *
 * 사전 요건: `npx vite build` 실행으로 dist/client/ 생성
 * 실행: cd src/soul-dashboard && npx playwright test dashboard-ui --config=playwright.config.ts
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
  SessionListResponse,
} from "../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === SSE 이벤트 타이밍 상수 ===

const SSE_INTERVAL = 200;

// === 멀티 Tool SSE 이벤트 시퀀스 ===

/**
 * 3개의 연속 Tool 호출(Read → Write → Bash)을 포함하는 SSE 이벤트 시퀀스.
 * thinking → 3개 tool 호출 → 2번째 thinking → response → complete
 */
const MULTI_TOOL_SSE_EVENTS = [
  // 0) User message
  {
    delay: 0,
    data: 'id: 0\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"src/utils.ts에 validateInput 함수를 추가하고 테스트를 실행해주세요."}\n\n',
  },
  // 1) Thinking: 분석
  {
    delay: 1 * SSE_INTERVAL,
    data: 'id: 1\nevent: text_start\ndata: {"type":"text_start","card_id":"mt-t1"}\n\n',
  },
  {
    delay: 2 * SSE_INTERVAL,
    data: 'id: 2\nevent: text_delta\ndata: {"type":"text_delta","card_id":"mt-t1","text":"먼저 기존 파일을 읽고, 수정한 뒤, 테스트를 실행하겠습니다."}\n\n',
  },
  {
    delay: 3 * SSE_INTERVAL,
    data: 'id: 3\nevent: text_end\ndata: {"type":"text_end","card_id":"mt-t1"}\n\n',
  },
  // 2) Tool 1: Read
  {
    delay: 4 * SSE_INTERVAL,
    data: 'id: 4\nevent: tool_start\ndata: {"type":"tool_start","card_id":"mt-tool1","tool_name":"Read","tool_input":{"file_path":"/src/utils.ts"}}\n\n',
  },
  {
    delay: 5 * SSE_INTERVAL,
    data: 'id: 5\nevent: tool_result\ndata: {"type":"tool_result","card_id":"mt-tool1","tool_name":"Read","result":"export function formatDate(d: Date) { return d.toISOString(); }","is_error":false}\n\n',
  },
  // 3) Tool 2: Write
  {
    delay: 6 * SSE_INTERVAL,
    data: 'id: 6\nevent: tool_start\ndata: {"type":"tool_start","card_id":"mt-tool2","tool_name":"Write","tool_input":{"file_path":"/src/utils.ts","content":"export function validateInput(s: string) { return s.trim().length > 0; }"}}\n\n',
  },
  {
    delay: 7 * SSE_INTERVAL,
    data: 'id: 7\nevent: tool_result\ndata: {"type":"tool_result","card_id":"mt-tool2","tool_name":"Write","result":"File written successfully","is_error":false}\n\n',
  },
  // 4) Tool 3: Bash
  {
    delay: 8 * SSE_INTERVAL,
    data: 'id: 8\nevent: tool_start\ndata: {"type":"tool_start","card_id":"mt-tool3","tool_name":"Bash","tool_input":{"command":"npm test -- --filter=utils"}}\n\n',
  },
  {
    delay: 9 * SSE_INTERVAL,
    data: 'id: 9\nevent: tool_result\ndata: {"type":"tool_result","card_id":"mt-tool3","tool_name":"Bash","result":"PASS src/utils.test.ts\\n  validateInput\\n    ✓ returns true for valid input (2ms)\\n    ✓ returns false for empty string (1ms)","is_error":false}\n\n',
  },
  // 5) 두 번째 Thinking
  {
    delay: 10 * SSE_INTERVAL,
    data: 'id: 10\nevent: text_start\ndata: {"type":"text_start","card_id":"mt-t2"}\n\n',
  },
  {
    delay: 11 * SSE_INTERVAL,
    data: 'id: 11\nevent: text_delta\ndata: {"type":"text_delta","card_id":"mt-t2","text":"validateInput 함수를 추가하고 테스트가 모두 통과했습니다."}\n\n',
  },
  {
    delay: 12 * SSE_INTERVAL,
    data: 'id: 12\nevent: text_end\ndata: {"type":"text_end","card_id":"mt-t2"}\n\n',
  },
  // 6) Complete
  {
    delay: 14 * SSE_INTERVAL,
    data: 'id: 13\nevent: complete\ndata: {"type":"complete","result":"src/utils.ts에 validateInput 함수를 추가하고 테스트를 통과했습니다.","attachments":[]}\n\n',
    end: true,
  },
];

const SSE_EVENTS = [
  // 0) User message
  {
    delay: 0,
    data: 'id: 0\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"src/index.ts 파일을 분석하고 에러 핸들링을 추가해주세요."}\n\n',
  },
  // 1) Thinking 카드: text_start → text_delta → text_end
  {
    delay: 1 * SSE_INTERVAL,
    data: 'id: 1\nevent: text_start\ndata: {"type":"text_start","card_id":"card-t1"}\n\n',
  },
  {
    delay: 2 * SSE_INTERVAL,
    data: 'id: 2\nevent: text_delta\ndata: {"type":"text_delta","card_id":"card-t1","text":"파일 구조를 분석하겠습니다. src/index.ts를 먼저 확인하고 의존성을 추적합니다."}\n\n',
  },
  {
    delay: 3 * SSE_INTERVAL,
    data: 'id: 3\nevent: text_end\ndata: {"type":"text_end","card_id":"card-t1"}\n\n',
  },
  // 2) Tool 호출: tool_start → tool_result
  {
    delay: 4 * SSE_INTERVAL,
    data: 'id: 4\nevent: tool_start\ndata: {"type":"tool_start","card_id":"card-tool1","tool_name":"Read","tool_input":{"file_path":"/src/index.ts"}}\n\n',
  },
  {
    delay: 6 * SSE_INTERVAL,
    data: 'id: 5\nevent: tool_result\ndata: {"type":"tool_result","card_id":"card-tool1","tool_name":"Read","result":"export function main() {\\n  console.log(\\"hello\\");\\n}","is_error":false}\n\n',
  },
  // 3) 두 번째 Thinking 카드
  {
    delay: 7 * SSE_INTERVAL,
    data: 'id: 6\nevent: text_start\ndata: {"type":"text_start","card_id":"card-t2"}\n\n',
  },
  {
    delay: 8 * SSE_INTERVAL,
    data: 'id: 7\nevent: text_delta\ndata: {"type":"text_delta","card_id":"card-t2","text":"파일을 확인했습니다. main 함수를 수정하여 에러 핸들링을 추가하겠습니다."}\n\n',
  },
  {
    delay: 9 * SSE_INTERVAL,
    data: 'id: 8\nevent: text_end\ndata: {"type":"text_end","card_id":"card-t2"}\n\n',
  },
  // 4) Complete 이벤트
  {
    delay: 11 * SSE_INTERVAL,
    data: 'id: 9\nevent: complete\ndata: {"type":"complete","result":"작업이 완료되었습니다. src/index.ts에 에러 핸들링을 추가했습니다.","attachments":[]}\n\n',
    end: true,
  },
];

// === Tool 없는 세션 SSE 이벤트 시퀀스 ===

/**
 * Tool call 없이 thinking → response → complete만 있는 세션.
 * Bug #10 회귀 테스트: 세로 배치 겹침 검증.
 */
const NO_TOOL_SSE_EVENTS = [
  {
    delay: 0,
    data: 'id: 0\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"간단히 설명해주세요."}\n\n',
  },
  {
    delay: 1 * SSE_INTERVAL,
    data: 'id: 1\nevent: text_start\ndata: {"type":"text_start","card_id":"nt-t1"}\n\n',
  },
  {
    delay: 2 * SSE_INTERVAL,
    data: 'id: 2\nevent: text_delta\ndata: {"type":"text_delta","card_id":"nt-t1","text":"이것은 도구를 사용하지 않고 바로 답변하는 세션입니다."}\n\n',
  },
  {
    delay: 3 * SSE_INTERVAL,
    data: 'id: 3\nevent: text_end\ndata: {"type":"text_end","card_id":"nt-t1"}\n\n',
  },
  {
    delay: 5 * SSE_INTERVAL,
    data: 'id: 4\nevent: complete\ndata: {"type":"complete","result":"답변을 완료했습니다.","attachments":[]}\n\n',
    end: true,
  },
];

// === 25+ 노드 세션 SSE 이벤트 시퀀스 ===

/** 10쌍의 thinking+tool을 생성 → ~25 노드 */
function generateLargeSSEEvents(pairCount: number): Array<{ delay: number; data: string; end?: boolean }> {
  const events: Array<{ delay: number; data: string; end?: boolean }> = [];
  let id = 0;
  let step = 0;

  // user message
  events.push({
    delay: 0,
    data: `id: ${id++}\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"대규모 작업을 수행해주세요 (${pairCount} 단계)."}\n\n`,
  });

  for (let i = 0; i < pairCount; i++) {
    step++;
    // thinking
    events.push({
      delay: step * SSE_INTERVAL,
      data: `id: ${id++}\nevent: text_start\ndata: {"type":"text_start","card_id":"lg-t${i}"}\n\n`,
    });
    step++;
    events.push({
      delay: step * SSE_INTERVAL,
      data: `id: ${id++}\nevent: text_delta\ndata: {"type":"text_delta","card_id":"lg-t${i}","text":"Step ${i}: 분석 중..."}\n\n`,
    });
    step++;
    events.push({
      delay: step * SSE_INTERVAL,
      data: `id: ${id++}\nevent: text_end\ndata: {"type":"text_end","card_id":"lg-t${i}"}\n\n`,
    });

    // tool
    const toolName = ["Read", "Bash", "Glob", "Grep", "Write"][i % 5];
    step++;
    events.push({
      delay: step * SSE_INTERVAL,
      data: `id: ${id++}\nevent: tool_start\ndata: {"type":"tool_start","card_id":"lg-tool${i}","tool_name":"${toolName}","tool_input":{"command":"step-${i}"}}\n\n`,
    });
    step++;
    events.push({
      delay: step * SSE_INTERVAL,
      data: `id: ${id++}\nevent: tool_result\ndata: {"type":"tool_result","card_id":"lg-tool${i}","tool_name":"${toolName}","result":"Result of step ${i}","is_error":false}\n\n`,
    });
  }

  // final thinking + complete
  step++;
  events.push({
    delay: step * SSE_INTERVAL,
    data: `id: ${id++}\nevent: text_start\ndata: {"type":"text_start","card_id":"lg-final"}\n\n`,
  });
  step++;
  events.push({
    delay: step * SSE_INTERVAL,
    data: `id: ${id++}\nevent: text_delta\ndata: {"type":"text_delta","card_id":"lg-final","text":"모든 단계를 완료했습니다."}\n\n`,
  });
  step++;
  events.push({
    delay: step * SSE_INTERVAL,
    data: `id: ${id++}\nevent: text_end\ndata: {"type":"text_end","card_id":"lg-final"}\n\n`,
  });
  step += 2;
  events.push({
    delay: step * SSE_INTERVAL,
    data: `id: ${id++}\nevent: complete\ndata: {"type":"complete","result":"${pairCount}단계 작업 완료","attachments":[]}\n\n`,
    end: true,
  });

  return events;
}

const LARGE_25_SSE_EVENTS = generateLargeSSEEvents(10);  // ~25 노드
const LARGE_50_SSE_EVENTS = generateLargeSSEEvents(20);  // ~50 노드

// === Mock Dashboard Server Fixture ===

interface MockDashboardServer {
  port: number;
  baseURL: string;
  server: Server;
}

/**
 * 빌드된 클라이언트 + Mock API를 서빙하는 통합 서버.
 * 랜덤 포트 사용으로 포트 충돌을 방지합니다.
 */
const test = base.extend<{ dashboardServer: MockDashboardServer }>({
  dashboardServer: async ({}, use) => {
    const app = express();

    // --- Mock: 세션 목록 — SessionListResponse 형식 ---
    app.get("/api/sessions", (_req, res) => {
      const response: SessionListResponse = {
        sessions: [
          {
            agentSessionId: "sess-e2e-ui-001",
            status: "running",
            eventCount: 5,
            createdAt: new Date().toISOString(),
            prompt: "src/index.ts 파일을 분석하고 에러 핸들링을 추가해주세요.",
          },
          {
            agentSessionId: "sess-e2e-ui-002",
            status: "completed",
            eventCount: 12,
            createdAt: new Date(Date.now() - 3600000).toISOString(),
            prompt: "테스트 코드를 작성해주세요.",
          },
          {
            agentSessionId: "sess-e2e-ui-003",
            status: "error",
            eventCount: 3,
            createdAt: new Date(Date.now() - 7200000).toISOString(),
            prompt: "에러 세션 테스트",
          },
          {
            agentSessionId: "sess-e2e-ui-multi",
            status: "running",
            eventCount: 14,
            createdAt: new Date(Date.now() - 60000).toISOString(),
            prompt: "src/utils.ts에 validateInput 함수를 추가하고 테스트를 실행해주세요.",
          },
          {
            agentSessionId: "sess-e2e-ui-notool",
            status: "completed",
            eventCount: 5,
            createdAt: new Date(Date.now() - 120000).toISOString(),
            prompt: "간단히 설명해주세요.",
          },
          {
            agentSessionId: "sess-e2e-ui-large25",
            status: "completed",
            eventCount: 55,
            createdAt: new Date(Date.now() - 180000).toISOString(),
            prompt: "대규모 작업을 수행해주세요 (10 단계).",
          },
          {
            agentSessionId: "sess-e2e-ui-large50",
            status: "completed",
            eventCount: 105,
            createdAt: new Date(Date.now() - 240000).toISOString(),
            prompt: "대규모 작업을 수행해주세요 (20 단계).",
          },
        ],
      };
      res.json(response);
    });

    // --- Mock: Health check ---
    app.get("/api/health", (_req, res) => {
      res.json({ status: "ok", service: "soul-dashboard" });
    });

    // --- Mock: Config ---
    app.get("/api/config", (_req, res) => {
      res.json({ authRequired: false });
    });

    // --- Mock: 세션 생성/재개 — CreateSessionResponse 형식 ---
    // Create & Resume 모두 POST /api/sessions 단일 엔드포인트 사용.
    // Resume 시 body.agentSessionId가 전달되면 재사용, 아니면 새 ID.
    app.use(express.json());
    app.post("/api/sessions", (req, res) => {
      const response: CreateSessionResponse = {
        agentSessionId: req.body.agentSessionId ?? "sess-e2e-new-001",
        status: "running",
      };
      res.status(201).json(response);
    });

    // --- Mock: 세션 개입 — InterveneResponse 형식 ---
    app.post("/api/sessions/:id/intervene", (_req, res) => {
      const response: InterveneResponse = {
        queue_position: 1,
      };
      res.json(response);
    });
    app.post("/api/sessions/:id/message", (_req, res) => {
      const response: InterveneResponse = {
        queue_position: 1,
      };
      res.json(response);
    });

    // --- Mock: SSE 이벤트 스트림 ---
    app.get("/api/sessions/:id/events", (req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const timers: NodeJS.Timeout[] = [];

      // 클라이언트 연결 종료 시 타이머 정리 (ERR_STREAM_DESTROYED 방지)
      res.on("close", () => {
        timers.forEach(clearTimeout);
      });

      // 연결 확인
      res.write("event: connected\ndata: {}\n\n");

      // 세션 ID에 따라 이벤트 시퀀스 선택
      const sessionId = req.params.id;
      let events: Array<{ delay: number; data: string; end?: boolean }>;
      if (sessionId.includes("large50")) {
        events = LARGE_50_SSE_EVENTS;
      } else if (sessionId.includes("large25")) {
        events = LARGE_25_SSE_EVENTS;
      } else if (sessionId.includes("notool")) {
        events = NO_TOOL_SSE_EVENTS;
      } else if (sessionId.includes("multi")) {
        events = MULTI_TOOL_SSE_EVENTS;
      } else {
        events = SSE_EVENTS;
      }

      // SSE 이벤트 스케줄링
      for (const event of events) {
        timers.push(
          setTimeout(() => {
            if (!res.writableEnded) {
              res.write(event.data);
              if (event.end) {
                res.end();
              }
            }
          }, event.delay),
        );
      }
    });

    // --- 빌드된 클라이언트 정적 파일 서빙 ---
    const clientDistDir = path.resolve(__dirname, "../dist/client");
    app.use(express.static(clientDistDir));

    // SPA fallback: API 외 모든 GET 요청에 index.html 반환
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(clientDistDir, "index.html"));
    });

    // 랜덤 포트에서 서버 시작
    const server = createServer(app);
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(0, () => {
        server.removeListener("error", onError);
        const addr = server.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        resolve(p);
      });
    });

    const baseURL = `http://localhost:${port}`;

    await use({ port, baseURL, server });

    // 정리: SSE 등 열린 연결을 강제 종료한 후 서버 종료 (타임아웃 가드 포함)
    server.closeAllConnections();
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  },
});

// === Screenshot 디렉토리 ===

const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

// === Helpers ===

/** React Flow 뷰포트에서 현재 zoom 값을 추출 */
async function getReactFlowZoom(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const rf = document.querySelector(".react-flow");
    if (!rf) return null;
    const transform = rf
      .querySelector(".react-flow__viewport")
      ?.getAttribute("style");
    if (!transform) return null;
    const match = transform.match(/scale\(([^)]+)\)/);
    return match ? parseFloat(match[1]) : null;
  });
}

/** 페이지 내 React Flow 노드들의 AABB 겹침 검사 */
async function checkNodeOverlaps(page: Page): Promise<Array<{ a: string; b: string }>> {
  const boxes = await page.evaluate(() => {
    const nodes = document.querySelectorAll(".react-flow__node");
    return Array.from(nodes).map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        id: node.getAttribute("data-id") ?? "unknown",
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
      };
    });
  });

  const margin = 2;
  const overlaps: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX =
        a.x + margin < b.x + b.w - margin &&
        a.x + a.w - margin > b.x + margin;
      const overlapY =
        a.y + margin < b.y + b.h - margin &&
        a.y + a.h - margin > b.y + margin;
      if (overlapX && overlapY) {
        overlaps.push({ a: a.id, b: b.id });
      }
    }
  }
  return overlaps;
}

/** 대시보드에 접속하고 세션을 선택하는 공통 설정 */
async function navigateAndSelectSession(
  page: Page,
  baseURL: string,
  sessionKey = "sess-e2e-ui-001",
) {
  await page.goto(baseURL);
  await expect(
    page.locator('[data-testid^="session-item-"]'),
  ).toHaveCount(7, { timeout: 10_000 });
  await page
    .locator(`[data-testid="session-item-${sessionKey}"]`)
    .click();
}

// === Tests ===

test.describe("Soul Dashboard 브라우저 UI", () => {
  test.beforeAll(async () => {
    // 스크린샷 디렉토리 생성
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("1. 대시보드 초기 렌더링 + 세션 목록 로드", async ({
    page,
    dashboardServer,
  }) => {
    // Mock 서버로 이동
    await page.goto(dashboardServer.baseURL);

    // 대시보드 레이아웃 확인
    const layout = page.locator('[data-testid="dashboard-layout"]');
    await expect(layout).toBeVisible({ timeout: 15_000 });

    // 헤더에 "Soul Dashboard" 텍스트 확인
    await expect(page.locator("header")).toContainText("Soul Dashboard");

    // 세션 패널 확인
    const sessionPanel = page.locator('[data-testid="session-panel"]');
    await expect(sessionPanel).toBeVisible();

    // 스크린샷: 초기 로딩 상태
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-initial-loading.png`,
      fullPage: true,
    });

    // 세션 목록 로드 대기
    const sessionList = page.locator('[data-testid="session-list"]');
    await expect(sessionList).toBeVisible();

    // 세션 항목이 렌더링될 때까지 대기 (mock에서 3개 반환)
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(7, { timeout: 10_000 });

    // 세션 상태 뱃지 확인
    const statusBadges = page.locator('[data-testid="session-status-badge"]');
    await expect(statusBadges).toHaveCount(7);

    // 그래프 패널 확인 (세션 미선택 → "Select a session" 안내)
    const graphPanel = page.locator('[data-testid="graph-panel"]');
    await expect(graphPanel).toBeVisible();

    // 디테일 패널 확인 (노드 미선택 → "Select a node" 안내)
    const detailPanel = page.locator('[data-testid="detail-panel"]');
    await expect(detailPanel).toBeVisible();

    // 스크린샷: 세션 목록 로드 완료
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-sessions-loaded.png`,
      fullPage: true,
    });
  });

  test("2. SSE 이벤트 → React Flow 노드 그래프 렌더링", async ({
    page,
    dashboardServer,
  }) => {
    await navigateAndSelectSession(page, dashboardServer.baseURL);

    // SSE 연결 + 이벤트 수신 대기
    // Thinking 노드가 나타날 때까지 대기 (text_start 이벤트 이후)
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // 스크린샷: 첫 thinking 노드 렌더링
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-first-thinking-node.png`,
      fullPage: true,
    });

    // Tool Call 노드가 나타날 때까지 대기 (tool_start 이벤트 이후)
    const toolNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolNodes.first()).toBeVisible({ timeout: 10_000 });

    // Complete 후 마지막 thinking이 response로 변환됨을 확인
    const responseNodes = page.locator('[data-testid="response-node"]');
    await expect(responseNodes.first()).toBeVisible({ timeout: 10_000 });

    // React Flow 캔버스에 노드와 엣지가 렌더링되었는지 확인
    const reactFlowNodes = page.locator(".react-flow__node");
    const nodeCount = await reactFlowNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(3); // user + thinking + tool + response + complete

    // 스크린샷: 전체 노드 그래프 렌더링
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-node-graph-rendered.png`,
      fullPage: true,
    });
  });

  test("3. 노드 클릭 → Detail 패널 표시", async ({
    page,
    dashboardServer,
  }) => {
    await navigateAndSelectSession(page, dashboardServer.baseURL);

    // 노드들이 렌더링될 때까지 대기
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // Tool 노드가 렌더링될 때까지 대기
    const toolNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolNodes.first()).toBeVisible({ timeout: 10_000 });

    // Thinking 노드 클릭
    await thinkingNodes.first().click();

    // Detail 패널에 내용이 표시되는지 확인
    const detailView = page.locator('[data-testid="detail-view"]');
    await expect(detailView).toBeVisible();

    // Thinking 카드 상세에서 "Detail" 헤더 확인
    await expect(detailView.getByText("Detail")).toBeVisible();

    // 스크린샷: Thinking 노드 선택 → Detail 패널
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-thinking-detail.png`,
      fullPage: true,
    });

    // Tool Call 노드 클릭
    await toolNodes.first().click();

    // Detail 패널이 Tool 상세로 업데이트되는지 확인
    // Tool 상세에는 도구 이름("Read")이 표시되어야 함
    await expect(detailView).toContainText("Read", { timeout: 5_000 });

    // 스크린샷: Tool 노드 선택 → Detail 패널
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-tool-detail.png`,
      fullPage: true,
    });
  });

  test("4. Complete 상태 + 레이아웃 검증", async ({ page, dashboardServer }) => {
    await navigateAndSelectSession(page, dashboardServer.baseURL);

    // Complete 이벤트까지 대기: 마지막 thinking → response 변환으로 확인
    const responseNodes = page.locator('[data-testid="response-node"]');
    await expect(responseNodes.first()).toBeVisible({ timeout: 10_000 });

    // 전체 노드 그래프가 렌더링된 상태 확인
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    const toolNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolNodes.first()).toBeVisible({ timeout: 10_000 });

    // user 노드 존재 확인 (user_message 이벤트 추가됨)
    const userNodes = page.locator('[data-testid="user-node"]');
    await expect(userNodes.first()).toBeVisible({ timeout: 10_000 });

    // thinking + tool 노드가 모두 존재하는지 확인
    const thinkingCount = await thinkingNodes.count();
    expect(thinkingCount).toBeGreaterThanOrEqual(1);

    // 레이아웃 검증: thinking 노드들이 세로로 정렬되고, tool 노드가 오른쪽에 배치
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(4); // user + thinking + tool + thinking (or response)

    // 스크린샷: Complete 상태의 전체 대시보드
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/07-complete-state.png`,
      fullPage: true,
    });
  });

  test("5. 멀티 Tool 호출 시나리오 (Read → Write → Bash)", async ({
    page,
    dashboardServer,
  }) => {
    // 멀티 Tool 세션 선택
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-multi",
    );

    // Complete 이벤트까지 대기: response 노드 출현으로 확인
    await expect(
      page.locator('[data-testid="response-node"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    // 3개의 Tool Call 노드 확인 (Read, Write, Bash)
    const toolCallNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolCallNodes).toHaveCount(3, { timeout: 10_000 });

    // 3개의 Tool Result 노드 확인
    const toolResultNodes = page.locator('[data-testid="tool-result-node"]');
    await expect(toolResultNodes).toHaveCount(3, { timeout: 10_000 });

    // Response 노드 확인 (세션 완료 → 마지막 text가 response로 변환)
    const responseNodes = page.locator('[data-testid="response-node"]');
    await expect(responseNodes).toHaveCount(1, { timeout: 10_000 });

    // User 노드 확인
    const userNodes = page.locator('[data-testid="user-node"]');
    await expect(userNodes).toHaveCount(1, { timeout: 10_000 });

    // Thinking 노드 확인 (첫 번째 thinking만, 두 번째는 response로 변환)
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes).toHaveCount(1, { timeout: 10_000 });

    // 전체 노드 수: user(1) + thinking(1) + tool_call(3) + tool_result(3) + response(1) + system(1, complete) = 10
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(10);

    // 레이아웃 정렬 검증: Tool Call 노드들이 세로 체이닝 (같은 X 좌표)
    const toolCallBoxes = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        toolCallNodes.nth(i).boundingBox(),
      ),
    );

    // BoundingBox가 null이 아닌지 명시적 확인
    for (const box of toolCallBoxes) {
      expect(box).not.toBeNull();
    }

    // 모든 Tool Call 노드의 X 좌표가 동일한지 확인 (±2px 허용)
    const xPositions = toolCallBoxes.map((b) => b!.x);
    expect(Math.abs(xPositions[0] - xPositions[1])).toBeLessThan(3);
    expect(Math.abs(xPositions[1] - xPositions[2])).toBeLessThan(3);

    // Tool Call 노드들이 위에서 아래로 정렬 (Y 좌표 증가)
    expect(toolCallBoxes[0]!.y).toBeLessThan(toolCallBoxes[1]!.y);
    expect(toolCallBoxes[1]!.y).toBeLessThan(toolCallBoxes[2]!.y);

    // 레이아웃 정렬 검증: Tool Result 노드들이 Tool Call 오른쪽에 배치
    const toolResultBoxes = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        toolResultNodes.nth(i).boundingBox(),
      ),
    );

    for (const box of toolResultBoxes) {
      expect(box).not.toBeNull();
    }

    // Result가 Call 오른쪽에 있어야 함
    expect(toolResultBoxes[0]!.x).toBeGreaterThan(toolCallBoxes[0]!.x);

    // 노드 크기 일관성 검증: 모든 Tool Call 노드의 너비가 동일 (viewport zoom 적용)
    const widths = toolCallBoxes.map((b) => b!.width);
    expect(Math.abs(widths[0] - widths[1])).toBeLessThan(2);
    expect(Math.abs(widths[1] - widths[2])).toBeLessThan(2);

    // 스크린샷: 멀티 Tool 전체 그래프
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/08-multi-tool-graph.png`,
      fullPage: true,
    });

    // 각 Tool 노드에 도구 이름이 정확히 표시되는지 확인
    for (const toolName of ["Read", "Write", "Bash"]) {
      await expect(
        toolCallNodes.filter({ hasText: toolName }),
      ).toHaveCount(1);
    }

    // 스크린샷: 멀티 Tool 전체 그래프 (상세)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/09-multi-tool-detail.png`,
      fullPage: true,
    });
  });

  test("6. 뷰포트 줌 불변 검증 (세션 전환 후 스트리밍 중 zoom 변경 없음)", async ({
    page,
    dashboardServer,
  }) => {
    await navigateAndSelectSession(page, dashboardServer.baseURL);

    // Thinking 노드가 나타날 때까지 대기 (첫 로드 → zoom 설정 1회 발생)
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // 첫 로드 후 viewport 안정화 대기 (300ms animation + 여유)
    await page.waitForTimeout(500);

    // 현재 zoom 값 캡처 (첫 로드 후 설정된 값)
    const initialZoom = await getReactFlowZoom(page);

    expect(initialZoom).not.toBeNull();
    expect(initialZoom).toBeGreaterThan(0);

    // Tool Call 노드가 렌더링될 때까지 대기 (스트리밍 중 새 노드 추가)
    const toolNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolNodes.first()).toBeVisible({ timeout: 10_000 });

    // Complete 후 마지막 thinking → response 변환 대기
    const responseNodes = page.locator('[data-testid="response-node"]');
    await expect(responseNodes.first()).toBeVisible({ timeout: 10_000 });

    // 스트리밍 후 viewport 안정화 대기
    await page.waitForTimeout(500);

    // 스트리밍 후 zoom 값 확인 — 변경되지 않아야 함
    const afterStreamZoom = await getReactFlowZoom(page);

    expect(afterStreamZoom).not.toBeNull();

    // 줌 불변 검증: 스트리밍 중 zoom이 크게 변경되지 않아야 함 (±0.05 허용)
    // 0.05 허용: 첫 로드 시 그래프 바운딩 박스가 노드 추가로 미세하게 변할 수 있어
    // 초기 줌 계산에 소수점 이하 차이가 발생할 수 있음 (fitView 대체 → 수동 계산 특성)
    expect(Math.abs(afterStreamZoom! - initialZoom!)).toBeLessThan(0.05);

    // 스크린샷: 줌 불변 검증 후 상태
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/10-zoom-invariant.png`,
      fullPage: true,
    });
  });

  test("7. 노드 겹침 없음 검증 (바운딩 박스 교차 검사)", async ({
    page,
    dashboardServer,
  }) => {
    // 멀티 Tool 세션 선택 (더 많은 노드)
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-multi",
    );

    // Complete 이벤트까지 대기: response 노드 출현으로 확인
    await expect(
      page.locator('[data-testid="response-node"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    // viewport 안정화 대기
    await page.waitForTimeout(500);

    // 노드가 충분히 렌더링되었는지 확인
    const nodeCount = await page.locator(".react-flow__node").count();
    expect(nodeCount).toBeGreaterThanOrEqual(10);

    // AABB 겹침 검사: 어떤 두 노드도 겹치면 안 됨
    const overlaps = await checkNodeOverlaps(page);
    expect(
      overlaps,
      `노드 겹침 발견: ${JSON.stringify(overlaps)}`,
    ).toHaveLength(0);

    // 스크린샷: 겹침 없음 검증 후 상태
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/11-no-overlap.png`,
      fullPage: true,
    });
  });

  test("8. Tool call 없는 세션: 노드 세로 배치 검증 (Bug #10 regression)", async ({
    page,
    dashboardServer,
  }) => {
    // tool 없는 세션 선택
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-notool",
    );

    // Complete까지 대기: response 노드 출현으로 확인
    await expect(
      page.locator('[data-testid="response-node"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // viewport 안정화
    await page.waitForTimeout(500);

    // Response 노드 확인 (tool 없는 세션 → 마지막 text가 response)
    const responseNodes = page.locator('[data-testid="response-node"]');
    await expect(responseNodes).toHaveCount(1, { timeout: 10_000 });

    // User 노드 확인
    const userNodes = page.locator('[data-testid="user-node"]');
    await expect(userNodes).toHaveCount(1, { timeout: 10_000 });

    // Tool 노드 없음
    const toolCallNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolCallNodes).toHaveCount(0);

    // 전체 노드 수: user(1) + response(1) + system(1, complete) = 3 이상
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(3);

    // AABB 겹침 검사
    const overlaps = await checkNodeOverlaps(page);
    expect(overlaps, `노드 겹침: ${JSON.stringify(overlaps)}`).toHaveLength(0);

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/12-no-tool-session.png`,
      fullPage: true,
    });
  });

  test("9. 25+ 노드 세션: EXECUTION FLOW 정상 렌더링 (Bug #10/#14 regression)", async ({
    page,
    dashboardServer,
  }) => {
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-large25",
    );

    // Complete까지 대기 — 25 노드 세션은 시간이 더 걸림
    await expect(
      page.locator('[data-testid="response-node"]').first(),
    ).toBeVisible({ timeout: 30_000 });

    await page.waitForTimeout(500);

    // 노드가 렌더링되었는지 확인
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(20);

    // 노드가 뷰포트 내에 표시되는지 확인 (하나 이상)
    const visibleNodes = await page.evaluate(() => {
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;
      const nodes = document.querySelectorAll(".react-flow__node");
      let visible = 0;
      nodes.forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.x + rect.width > 0 && rect.x < vpW && rect.y + rect.height > 0 && rect.y < vpH) {
          visible++;
        }
      });
      return visible;
    });
    expect(visibleNodes).toBeGreaterThan(0);

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/13-large25-session.png`,
      fullPage: true,
    });
  });

  test("10. 50+ 노드 세션: EXECUTION FLOW 비어있지 않음 (Bug #14 regression)", async ({
    page,
    dashboardServer,
  }) => {
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-large50",
    );

    // Complete까지 대기 — 50 노드 세션은 시간이 상당히 걸림
    await expect(
      page.locator('[data-testid="response-node"]').first(),
    ).toBeVisible({ timeout: 60_000 });

    await page.waitForTimeout(500);

    // 노드가 렌더링되었는지 확인
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(40);

    // 뷰포트 내에 하나 이상의 노드가 보여야 함 (14번 버그: 비어있으면 안됨)
    const visibleNodes = await page.evaluate(() => {
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;
      const nodes = document.querySelectorAll(".react-flow__node");
      let visible = 0;
      nodes.forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.x + rect.width > 0 && rect.x < vpW && rect.y + rect.height > 0 && rect.y < vpH) {
          visible++;
        }
      });
      return visible;
    });
    expect(visibleNodes).toBeGreaterThan(0);

    // 모든 노드의 바운딩 박스가 유한한 범위 내에 있는지 확인
    const allNodeBoxes = await page.evaluate(() => {
      const nodes = document.querySelectorAll(".react-flow__node");
      return Array.from(nodes).map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      });
    });

    // 0 크기 노드가 없어야 함 (렌더링 실패 표지)
    const zeroSizeNodes = allNodeBoxes.filter((b) => b.w === 0 || b.h === 0);
    expect(zeroSizeNodes).toHaveLength(0);

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/14-large50-session.png`,
      fullPage: true,
    });
  });

  test("11. 세션 생성 → 응답 계약 검증 → SSE 구독 → 그래프 렌더링 (핵심 E2E)", async ({
    page,
    dashboardServer,
  }) => {
    // SSE 구독 URL 감시
    const sseUrls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/events")) {
        sseUrls.push(req.url());
      }
    });

    await page.goto(dashboardServer.baseURL);

    // 세션 목록 로드 대기
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(7, { timeout: 10_000 });

    // 초기 상태: 세션 미선택 → PromptComposer 표시됨
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // 세션 선택하여 PromptComposer 닫기 (+ New 활성화)
    await page.locator('[data-testid="session-item-sess-e2e-ui-001"]').click();
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // "+ New" 버튼 클릭 → PromptComposer 다시 표시
    await page.locator('[data-testid="new-session-button"]').click();
    await expect(composer).toBeVisible({ timeout: 5_000 });
    await expect(composer).toContainText("New Conversation");

    // 스크린샷: PromptComposer 표시
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/15-prompt-composer-new.png`,
      fullPage: true,
    });

    // 프롬프트 입력
    const textarea = composer.locator("textarea");
    await textarea.fill("새 세션을 시작합니다. 테스트 프롬프트입니다.");

    // Submit 버튼 활성화 확인
    const submitBtn = page.locator('[data-testid="compose-submit"]');
    await expect(submitBtn).toBeEnabled();

    // waitForResponse 설정 후 Submit 클릭 — race condition 방지
    const createResponsePromise = page.waitForResponse(
      (resp) =>
        resp.request().method() === "POST" &&
        resp.url().includes("/api/sessions") &&
        !resp.url().includes("/intervene") &&
        !resp.url().includes("/events"),
    );
    await submitBtn.click();
    const rawResponse = await createResponsePromise;
    const createResponse = await rawResponse.json();

    // PromptComposer 사라짐 확인 (세션 생성 성공 후)
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // [계약 검증 1] CreateSessionResponse 형식 — agentSessionId 필수, 레거시 필드 없음
    expect(createResponse).toHaveProperty("agentSessionId");
    expect(typeof createResponse.agentSessionId).toBe("string");
    expect(createResponse.agentSessionId).toBeTruthy();
    expect(createResponse).toHaveProperty("status", "running");

    // 레거시 필드가 응답에 없어야 함 (이 버그를 방지!)
    expect(createResponse).not.toHaveProperty("sessionKey");
    expect(createResponse).not.toHaveProperty("clientId");
    expect(createResponse).not.toHaveProperty("requestId");

    // SSE 구독이 시작되어 노드가 렌더링되기 시작
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // [계약 검증 2] SSE 구독 URL이 응답의 agentSessionId를 사용하는지 확인
    const expectedSessionId = createResponse.agentSessionId as string;
    const newSessionSSE = sseUrls.filter((url) => url.includes(expectedSessionId));
    expect(
      newSessionSSE.length,
      `SSE 구독이 agentSessionId(${expectedSessionId})로 시작되어야 함. 실제 SSE URLs: ${sseUrls.join(", ")}`,
    ).toBeGreaterThanOrEqual(1);

    // 스크린샷: 세션 생성 후 그래프 표시
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/16-session-created.png`,
      fullPage: true,
    });
  });

  test("12. 완료 세션 ChatInput Resume → Intervene API 계약 검증", async ({
    page,
    dashboardServer,
  }) => {
    // API 요청 감시: intervene 호출 캡처
    let interveneRequest: { url: string; body: Record<string, unknown> } | null = null;

    page.on("request", async (req) => {
      if (req.method() === "POST" && req.url().includes("/intervene")) {
        interveneRequest = {
          url: req.url(),
          body: JSON.parse(req.postData() ?? "{}"),
        };
      }
    });

    // 완료된 세션 선택
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-002",
    );

    // Complete까지 대기
    await expect(
      page.locator('[data-testid="response-node"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // ChatInput이 "New Chat" 모드로 표시
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeVisible({ timeout: 5_000 });
    await expect(chatInput).toContainText("New Chat");

    // "Resume" 버튼 (send-button) 표시 확인
    const sendBtn = page.locator('[data-testid="send-button"]');
    await expect(sendBtn).toContainText("Resume");

    // 스크린샷: 완료 세션 ChatInput
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/17-completed-session-chatinput.png`,
      fullPage: true,
    });

    // 프롬프트 입력 + Resume 클릭
    const textarea = chatInput.locator("textarea");
    await textarea.fill("이어서 작업해주세요.");
    await sendBtn.click();

    // [계약 검증] Intervene API 호출이 올바른 세션 ID로 이루어졌는지 확인
    await page.waitForTimeout(500);
    expect(interveneRequest).not.toBeNull();
    expect(interveneRequest!.url).toContain("sess-e2e-ui-002");
    expect(interveneRequest!.body).toHaveProperty("text", "이어서 작업해주세요.");

    // 전송 후 textarea 비워짐 확인
    await expect(textarea).toHaveValue("", { timeout: 5_000 });

    // 스크린샷: Resume 전송 후
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/18-resume-sent.png`,
      fullPage: true,
    });
  });

  test("13. 완료된 세션 ChatInput — New Chat 모드 + Resume 버튼 표시", async ({
    page,
    dashboardServer,
  }) => {
    // 완료된 세션 선택
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-002",
    );

    // Complete 이벤트까지 대기
    await expect(
      page.locator('[data-testid="response-node"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // ChatInput이 "New Chat" 모드로 표시
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeVisible({ timeout: 5_000 });
    await expect(chatInput).toContainText("New Chat");

    // "Resume" 버튼(send-button) 표시 — 완료 세션에서 버튼 텍스트가 "Resume"
    const sendBtn = page.locator('[data-testid="send-button"]');
    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).toContainText("Resume");

    // textarea 표시 (완료 상태에서도 입력 가능)
    await expect(chatInput.locator("textarea")).toBeVisible();

    // placeholder가 완료 모드에 맞게 표시
    await expect(chatInput.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Continue the conversation...",
    );

    // 빈 상태에서 Resume 버튼 비활성화
    await expect(sendBtn).toBeDisabled();

    // 텍스트 입력 → Resume 버튼 활성화
    await chatInput.locator("textarea").fill("이어서 설명해주세요.");
    await expect(sendBtn).toBeEnabled();

    // 스크린샷: 완료된 세션 ChatInput
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/19-completed-session-chatinput.png`,
      fullPage: true,
    });
  });

  test("14. 인터벤션 전송 (Running 세션)", async ({
    page,
    dashboardServer,
  }) => {
    // Running 세션 선택
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-001",
    );

    // SSE 스트리밍 시작 대기
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // ChatInput이 인터벤션 모드로 표시
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeVisible({ timeout: 5_000 });
    await expect(chatInput).toContainText("Intervention");

    // textarea와 Send 버튼 표시
    const textarea = chatInput.locator("textarea");
    await expect(textarea).toBeVisible();
    const sendBtn = page.locator('[data-testid="send-button"]');
    await expect(sendBtn).toBeVisible();

    // 메시지 입력
    await textarea.fill("이 부분을 수정해주세요.");

    // Send 버튼 활성화 확인
    await expect(sendBtn).toBeEnabled();

    // Send 클릭
    await sendBtn.click();

    // 전송 후 textarea 비워짐 확인
    await expect(textarea).toHaveValue("", { timeout: 5_000 });

    // 스크린샷: 인터벤션 전송 후
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/21-intervention-sent.png`,
      fullPage: true,
    });
  });

  test("15. 세션 목록 API 계약 검증 — agentSessionId 형식, 레거시 필드 없음", async ({
    page,
    dashboardServer,
  }) => {
    // GET /api/sessions 응답을 waitForResponse로 확실히 캡처
    const responsePromise = page.waitForResponse(
      (resp) =>
        resp.request().method() === "GET" &&
        resp.url().includes("/api/sessions") &&
        !resp.url().includes("/events"),
    );

    await page.goto(dashboardServer.baseURL);

    // 응답 대기 (async callback 레이스 컨디션 방지)
    const apiResponse = await responsePromise;
    const sessionsResponse = await apiResponse.json();

    // 세션 목록 UI 로드 대기
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(7, { timeout: 10_000 });

    // 응답이 캡처되었는지 확인
    expect(sessionsResponse).not.toBeNull();

    const body = sessionsResponse as { sessions: Record<string, unknown>[] };
    expect(body.sessions).toHaveLength(7);

    // 모든 세션에 대해 계약 검증
    for (const session of body.sessions) {
      // agentSessionId 필수 — "sess-" 접두사 형식
      expect(session).toHaveProperty("agentSessionId");
      expect(typeof session.agentSessionId).toBe("string");
      expect(session.agentSessionId).toBeTruthy();

      // 필수 필드
      expect(session).toHaveProperty("status");
      expect(session).toHaveProperty("eventCount");

      // 레거시 필드 없음 (clientId/requestId 기반 → agentSessionId 기반으로 전환)
      expect(session).not.toHaveProperty("clientId");
      expect(session).not.toHaveProperty("requestId");
      expect(session).not.toHaveProperty("sessionKey");
    }
  });

  test("16. 세션 전환 시 이전 그래프 초기화 검증", async ({
    page,
    dashboardServer,
  }) => {
    // 첫 번째 세션 선택 (멀티 Tool)
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-multi",
    );

    // Complete까지 대기: response 노드 출현으로 확인
    await expect(
      page.locator('[data-testid="response-node"]').first(),
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(300);

    // 멀티 Tool 세션의 노드 수 확인
    const multiToolNodeCount = await page.locator(".react-flow__node").count();
    expect(multiToolNodeCount).toBeGreaterThanOrEqual(10);

    // 3개의 Tool Call 노드 확인 (멀티 Tool 세션 고유)
    const toolCallNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolCallNodes).toHaveCount(3, { timeout: 5_000 });

    // 다른 세션으로 전환 (Tool 없는 세션)
    await page
      .locator('[data-testid="session-item-sess-e2e-ui-notool"]')
      .click();

    // Complete까지 대기: response 노드 출현으로 확인
    await expect(
      page.locator('[data-testid="response-node"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(300);

    // 이전 세션의 3개 Tool Call 노드가 사라졌는지 확인
    // (Tool 없는 세션에서는 tool-call-node가 0개)
    await expect(toolCallNodes).toHaveCount(0, { timeout: 5_000 });

    // 현재 세션의 노드가 정상 렌더링되는지 확인
    const responseNodes = page.locator('[data-testid="response-node"]');
    await expect(responseNodes).toHaveCount(1, { timeout: 5_000 });

    // 스크린샷: 세션 전환 후 그래프
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/22-session-switch-graph-reset.png`,
      fullPage: true,
    });
  });

  test("17. 세션 생성 후 SSE 이벤트가 올바른 세션으로 라우팅되는지 검증", async ({
    page,
    dashboardServer,
  }) => {
    // SSE 구독 URL 캡처
    const sseUrls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/events")) {
        sseUrls.push(req.url());
      }
    });

    await page.goto(dashboardServer.baseURL);

    // 세션 목록 로드 대기
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(7, { timeout: 10_000 });

    // 초기 상태: PromptComposer 표시, "+New" 비활성
    // 먼저 세션을 선택하여 Composer를 닫은 후 "+New" 활성화
    await page.locator('[data-testid="session-item-sess-e2e-ui-001"]').click();
    await expect(
      page.locator('[data-testid="prompt-composer"]'),
    ).not.toBeVisible({ timeout: 5_000 });

    // "+ New" → PromptComposer → Submit
    await page.locator('[data-testid="new-session-button"]').click();
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });
    await composer.locator("textarea").fill("SSE 라우팅 테스트");
    await page.locator('[data-testid="compose-submit"]').click();
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // SSE 이벤트가 도착하여 노드가 렌더링되기 시작
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // Complete까지 대기: response 노드 출현으로 확인
    await expect(
      page.locator('[data-testid="response-node"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    // SSE 구독이 새 세션 ID(sess-e2e-new-001)로 이루어졌는지 확인
    const newSessionSSE = sseUrls.filter((url) =>
      url.includes("sess-e2e-new-001"),
    );
    expect(
      newSessionSSE.length,
      `SSE가 sess-e2e-new-001에 구독되어야 함`,
    ).toBeGreaterThanOrEqual(1);

    // Complete 이벤트까지 수신 완료 → 전체 그래프가 렌더링됨
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(3); // user + thinking + response/complete

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/23-sse-routing-verified.png`,
      fullPage: true,
    });
  });

  test("18. PromptComposer 입력 검증 — 빈 프롬프트 방지 + Submit 활성화", async ({
    page,
    dashboardServer,
  }) => {
    await page.goto(dashboardServer.baseURL);

    // 세션 목록 로드 대기
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(7, { timeout: 10_000 });

    // 초기 상태: 세션 미선택 → PromptComposer 표시됨
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // 빈 프롬프트 상태에서 Submit 버튼 비활성화 확인
    const submitBtn = page.locator('[data-testid="compose-submit"]');
    await expect(submitBtn).toBeDisabled();

    // 공백만 입력해도 Submit 비활성화 유지
    await composer.locator("textarea").fill("   ");
    await expect(submitBtn).toBeDisabled();

    // 유효한 텍스트 입력 → Submit 활성화
    await composer.locator("textarea").fill("유효한 프롬프트입니다.");
    await expect(submitBtn).toBeEnabled();

    // 다시 비우면 Submit 비활성화
    await composer.locator("textarea").fill("");
    await expect(submitBtn).toBeDisabled();
  });
});
