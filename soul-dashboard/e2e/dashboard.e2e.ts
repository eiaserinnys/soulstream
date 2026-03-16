/**
 * Soul Dashboard E2E 테스트 (Playwright) — API 계약 검증
 *
 * Mock Express 서버를 시작하여 API 응답 형식을 검증합니다.
 * 서버-클라이언트 간 응답 타입의 일관성을 보장합니다.
 *
 * 실행: cd soul-dashboard && npx playwright test dashboard --config=playwright.config.ts
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import express from "express";
import { createServer, type Server } from "http";
import type {
  CreateSessionResponse,
  InterveneResponse,
} from "../shared/types.js";

// === Test Fixtures ===

const TEST_DIR = join(tmpdir(), "soul-dash-e2e-" + Date.now());

// === Test Server Management ===

let testServer: Server | null = null;
let testPort = 0;

/**
 * 테스트용 Express 서버를 시작합니다.
 * 실제 서버와 동일한 응답 형식을 반환하는 mock API를 제공합니다.
 */
async function startMockDashboardServer(): Promise<number> {
  const app = express();
  app.use(express.json());

  // 모의 세션 목록 API — 실제 서버와 동일한 snake_case 형식
  const mockSessions = [
    {
      agent_session_id: "sess-e2e-001",
      status: "completed",
      prompt: "첫 번째 테스트 세션",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      agent_session_id: "sess-e2e-002",
      status: "running",
      prompt: "두 번째 테스트 세션",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  app.get("/api/sessions", (_req, res) => {
    res.json({ sessions: mockSessions });
  });

  // 모의 세션 생성 API — CreateSessionResponse 형식
  app.post("/api/sessions", (_req, res) => {
    const response: CreateSessionResponse = {
      agentSessionId: "sess-e2e-new-001",
      status: "running",
    };
    res.status(201).json(response);
  });

  // 모의 Intervention API — InterveneResponse 형식
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

  // 모의 Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", service: "soul-dashboard" });
  });

  // 모의 인증 엔드포인트 (인증 비활성 기본값)
  app.get("/api/auth/config", (_req, res) => {
    res.json({ authEnabled: false, devModeEnabled: true });
  });
  app.get("/api/auth/status", (_req, res) => {
    res.json({ authenticated: false });
  });
  app.post("/api/auth/dev-login", (_req, res) => {
    res.json({ success: true });
  });
  app.post("/api/auth/logout", (_req, res) => {
    res.json({ success: true });
  });

  // 모의 세션 목록 SSE 스트림 (SSE 모드에서 사용)
  app.get("/api/sessions/stream", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const data = JSON.stringify({ type: "session_list", sessions: mockSessions });
    res.write(`event: session_list\ndata: ${data}\n\n`);

    // API 테스트에서 request.get()이 완료되도록 응답 종료
    setTimeout(() => {
      if (!res.writableEnded) res.end();
    }, 100);
  });

  // 모의 SSE 엔드포인트
  app.get("/api/sessions/:id/events", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("event: connected\ndata: {}\n\n");

    const timers: NodeJS.Timeout[] = [];
    res.on("close", () => timers.forEach(clearTimeout));

    timers.push(
      setTimeout(() => {
        if (!res.writableEnded) {
          res.write(
            'id: 1\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"Hello"}\n\n',
          );
        }
      }, 50),
    );
    timers.push(
      setTimeout(() => {
        if (!res.writableEnded) {
          res.write(
            'id: 2\nevent: text_start\ndata: {"type":"text_start","card_id":"c1"}\n\n',
          );
        }
      }, 100),
    );
    timers.push(
      setTimeout(() => {
        if (!res.writableEnded) {
          res.write(
            'id: 3\nevent: text_delta\ndata: {"type":"text_delta","card_id":"c1","text":"Hello from E2E test"}\n\n',
          );
        }
      }, 200),
    );
    timers.push(
      setTimeout(() => {
        if (!res.writableEnded) {
          res.write(
            'id: 4\nevent: text_end\ndata: {"type":"text_end","card_id":"c1"}\n\n',
          );
        }
      }, 300),
    );
    timers.push(
      setTimeout(() => {
        if (!res.writableEnded) {
          res.write(
            'id: 5\nevent: complete\ndata: {"type":"complete","result":"Done","attachments":[]}\n\n',
          );
          res.end();
        }
      }, 400),
    );
  });

  return new Promise((resolve) => {
    const server = createServer(app);
    testServer = server;
    server.listen(0, () => {
      const addr = server.address();
      testPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve(testPort);
    });
  });
}

// === Playwright Tests ===

test.describe("Soul Dashboard API 계약 E2E", () => {
  test.beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    await startMockDashboardServer();
  });

  test.afterAll(async () => {
    if (testServer) {
      await new Promise<void>((resolve) => testServer!.close(() => resolve()));
      testServer = null;
    }
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("API health check가 응답한다", async ({ request }) => {
    const res = await request.get(`http://localhost:${testPort}/api/health`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("soul-dashboard");
  });

  test("GET /api/sessions — 서버 응답 계약 (snake_case)", async ({ request }) => {
    const res = await request.get(
      `http://localhost:${testPort}/api/sessions`,
    );
    expect(res.ok()).toBe(true);
    const body = await res.json() as { sessions: Record<string, unknown>[] };

    // sessions 배열 존재
    expect(body.sessions).toHaveLength(2);

    // 서버 필수 필드: agent_session_id (snake_case)
    const session = body.sessions[0];
    expect(session).toHaveProperty("agent_session_id");
    expect(typeof session.agent_session_id).toBe("string");
    expect(session.agent_session_id).toBeTruthy();

    // 구버전 필드가 없어야 함
    expect(session).not.toHaveProperty("clientId");
    expect(session).not.toHaveProperty("requestId");
    expect(session).not.toHaveProperty("sessionKey");

    // 나머지 필수 필드
    expect(session).toHaveProperty("status");
    expect(session).toHaveProperty("created_at");
  });

  test("POST /api/sessions — CreateSessionResponse 계약", async ({ request }) => {
    const res = await request.post(
      `http://localhost:${testPort}/api/sessions`,
      {
        data: { prompt: "E2E test prompt" },
      },
    );
    expect(res.status()).toBe(201);
    const body: CreateSessionResponse = await res.json();

    // agentSessionId 필수
    expect(body).toHaveProperty("agentSessionId");
    expect(typeof body.agentSessionId).toBe("string");
    expect(body.agentSessionId).toBeTruthy();
    expect(body.status).toBe("running");

    // 구버전 필드가 없어야 함 (이 버그를 방지!)
    expect(body).not.toHaveProperty("sessionKey");
    expect(body).not.toHaveProperty("clientId");
    expect(body).not.toHaveProperty("requestId");
  });

  test("POST /api/sessions/:id/intervene — InterveneResponse 계약", async ({ request }) => {
    const res = await request.post(
      `http://localhost:${testPort}/api/sessions/sess-e2e-002/intervene`,
      {
        data: { text: "E2E intervention", user: "dashboard" },
      },
    );
    expect(res.ok()).toBe(true);
    const body: InterveneResponse = await res.json();

    // queue_position 존재
    expect(body).toHaveProperty("queue_position");
    expect(typeof body.queue_position).toBe("number");
  });

  test("SSE 이벤트 스트림이 올바른 형식으로 전달된다", async ({ request }) => {
    const res = await request.get(
      `http://localhost:${testPort}/api/sessions/sess-e2e-001/events`,
    );
    expect(res.ok()).toBe(true);
    const text = await res.text();
    expect(text).toContain("event: connected");
    expect(text).toContain("event: user_message");
    expect(text).toContain("event: text_start");
    expect(text).toContain("event: text_delta");
    expect(text).toContain("Hello from E2E test");
    expect(text).toContain("event: complete");
  });

  test("GET /api/sessions/stream — 세션 목록 SSE 스트림 계약", async ({ request }) => {
    const res = await request.get(
      `http://localhost:${testPort}/api/sessions/stream`,
    );
    expect(res.ok()).toBe(true);
    const text = await res.text();

    // named event 형식: "event: session_list"
    expect(text).toContain("event: session_list");

    // data 파싱 가능 확인
    const dataMatch = text.match(/^data: (.+)$/m);
    expect(dataMatch).not.toBeNull();

    const payload = JSON.parse(dataMatch![1]);
    expect(payload.type).toBe("session_list");
    expect(payload.sessions).toHaveLength(2);

    // 세션 필수 필드 검증 (서버와 동일한 snake_case)
    for (const session of payload.sessions) {
      expect(session).toHaveProperty("agent_session_id");
      expect(typeof session.agent_session_id).toBe("string");
      expect(session).toHaveProperty("status");
      expect(session).toHaveProperty("created_at");
    }
  });

  test("SSE 이벤트 ID가 단조 증가한다", async ({ request }) => {
    const res = await request.get(
      `http://localhost:${testPort}/api/sessions/sess-e2e-001/events`,
    );
    const text = await res.text();
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map(m => parseInt(m[1], 10));

    expect(ids.length).toBeGreaterThanOrEqual(3);

    // 단조 증가 검증
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });

  test("GET /api/auth/config — 인증 설정 계약", async ({ request }) => {
    const res = await request.get(`http://localhost:${testPort}/api/auth/config`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("authEnabled");
    expect(typeof body.authEnabled).toBe("boolean");
    expect(body).toHaveProperty("devModeEnabled");
    expect(typeof body.devModeEnabled).toBe("boolean");
  });

  test("GET /api/auth/status — 인증 상태 계약", async ({ request }) => {
    const res = await request.get(`http://localhost:${testPort}/api/auth/status`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("authenticated");
    expect(typeof body.authenticated).toBe("boolean");
  });

  test("POST /api/auth/dev-login — 개발자 로그인 계약", async ({ request }) => {
    const res = await request.post(`http://localhost:${testPort}/api/auth/dev-login`, {
      data: { email: "dev@example.com", name: "Dev User" },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("success");
    expect(body.success).toBe(true);
  });

  test("POST /api/auth/logout — 로그아웃 계약", async ({ request }) => {
    const res = await request.post(`http://localhost:${testPort}/api/auth/logout`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("success");
    expect(body.success).toBe(true);
  });
});
