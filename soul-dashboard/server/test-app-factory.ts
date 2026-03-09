/**
 * 테스트용 Express 앱 팩토리
 *
 * 통합 테스트에서 실제 Express 앱을 생성할 때 사용합니다.
 * 프록시 아키텍처: 대시보드 → Soul 서버 API 호출.
 */

import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { createSessionsProxyRouter } from "./routes/sessions-proxy.js";
import { createActionsRouter } from "./routes/actions.js";

export interface TestAppOptions {
  /** Soul 서버 포트 (기본값: 39999 - 연결 안 됨) */
  soulPort?: number;
}

export interface TestAppContext {
  app: Express;
}

/**
 * 테스트용 Express 앱과 의존성을 생성합니다.
 */
export function createTestApp(options: TestAppOptions = {}): TestAppContext {
  const soulBaseUrl = `http://localhost:${options.soulPort ?? 39999}`;
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "soul-dashboard",
      version: "0.5.0",
      soulServer: soulBaseUrl,
    });
  });

  app.use(
    "/api/sessions",
    createSessionsProxyRouter({ soulBaseUrl }),
  );
  app.use(
    "/api/sessions",
    createActionsRouter({ soulBaseUrl }),
  );

  return { app };
}

/**
 * Express 앱을 랜덤 포트에서 시작합니다.
 */
export function startTestServer(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.on("error", reject);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

/**
 * Mock Soul 서버를 생성합니다.
 * /execute와 /sessions/:agentSessionId/intervene 엔드포인트를 제공합니다.
 */
export function createMockSoulServer(): Promise<{
  server: Server;
  port: number;
  requests: Array<{ type: string; body: unknown; params?: Record<string, string> }>;
}> {
  return new Promise((resolve) => {
    const requests: Array<{ type: string; body: unknown; params?: Record<string, string> }> = [];
    const soulApp = express();
    soulApp.use(express.json());

    soulApp.post("/execute", (req, res) => {
      requests.push({ type: "execute", body: req.body });
      const agentSessionId = req.body.agent_session_id ?? `sess-mock-${Date.now()}`;

      // SSE 스트림 시뮬레이트 (init 이벤트 후 즉시 종료)
      // 실제 Soul 서버(sse_starlette)는 \r\n 구분자를 사용하므로 동일하게 재현
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      res.write(
        `event: init\r\ndata: ${JSON.stringify({ type: "init", agent_session_id: agentSessionId })}\r\n\r\n`,
      );
      res.end();
    });

    soulApp.post("/sessions/:agentSessionId/intervene", (req, res) => {
      requests.push({
        type: "intervene",
        body: req.body,
        params: req.params as Record<string, string>,
      });
      res.json({ status: "queued" });
    });

    const server = createServer(soulApp);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, requests });
    });
  });
}
