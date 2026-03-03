/**
 * Sessions Proxy Routes 단위 테스트
 *
 * Dashboard Server가 Soul Server를 프록시하는 테스트.
 * 파일 직접 읽기 대신 Soul Server API를 호출합니다.
 *
 * GET /api/sessions              → Soul GET /sessions
 * GET /api/sessions/stream       → Soul GET /sessions/stream (SSE)
 * GET /api/sessions/:id/events   → Soul GET /sessions/:id/history (SSE)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Server, createServer } from "http";
import express, { type Express } from "express";
import { createSessionsProxyRouter } from "./sessions-proxy.js";

interface MockSoulServer {
  server: Server;
  port: number;
  /** 저장된 세션 목록 데이터 */
  sessions: Array<{
    agent_session_id: string;
    status: string;
    prompt?: string;
    created_at: string;
    updated_at: string;
  }>;
  /** 저장된 세션별 이벤트 데이터 */
  events: Map<
    string,
    Array<{ id: number; event: Record<string, unknown> }>
  >;
  /** is_live 상태 (세션별) */
  isLive: Map<string, boolean>;
}

/**
 * Mock Soul Server 생성 - 프록시 테스트용
 */
function createMockSoulServer(): Promise<MockSoulServer> {
  return new Promise((resolve) => {
    const sessions: MockSoulServer["sessions"] = [];
    const events = new Map<
      string,
      Array<{ id: number; event: Record<string, unknown> }>
    >();
    const isLive = new Map<string, boolean>();

    const app = express();
    app.use(express.json());

    // GET /sessions - 세션 목록 조회
    app.get("/sessions", (_req, res) => {
      res.json({ sessions });
    });

    // GET /sessions/stream - 세션 목록 SSE 스트림
    app.get("/sessions/stream", (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // 초기 세션 목록 전송
      res.write(
        `event: session_list\ndata: ${JSON.stringify({ type: "session_list", sessions })}\n\n`,
      );

      // 테스트에서 연결 종료 전에 keepalive 전송 후 종료
      setTimeout(() => {
        res.write(": keepalive\n\n");
        res.end();
      }, 50);
    });

    // GET /sessions/:id/history - 세션 히스토리 SSE 스트림
    app.get("/sessions/:agent_session_id/history", (req, res) => {
      const agentSessionId = req.params.agent_session_id;
      const sessionEvents = events.get(agentSessionId);

      if (!sessionEvents) {
        res.status(404).json({
          error: {
            code: "SESSION_NOT_FOUND",
            message: `세션을 찾을 수 없습니다: ${agentSessionId}`,
          },
        });
        return;
      }

      // Last-Event-ID 파싱
      const lastEventIdHeader =
        req.query.last_event_id ?? req.headers["last-event-id"];
      let afterId = 0;
      if (typeof lastEventIdHeader === "string") {
        const parsed = parseInt(lastEventIdHeader, 10);
        if (!isNaN(parsed)) afterId = parsed;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // 저장된 이벤트 전송 (afterId 이후)
      const eventsToSend = sessionEvents.filter((e) => e.id > afterId);
      let lastStoredId = 0;
      for (const record of eventsToSend) {
        lastStoredId = Math.max(lastStoredId, record.id);
        res.write(
          `id: ${record.id}\nevent: ${record.event.type ?? "unknown"}\ndata: ${JSON.stringify(record.event)}\n\n`,
        );
      }

      // history_sync 이벤트
      res.write(
        `event: history_sync\ndata: ${JSON.stringify({
          type: "history_sync",
          last_event_id: lastStoredId,
          is_live: isLive.get(agentSessionId) ?? false,
        })}\n\n`,
      );

      // 즉시 종료 (테스트용)
      res.end();
    });

    const server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, sessions, events, isLive });
    });
  });
}

/** 테스트용 Dashboard 앱 생성 */
function createDashboardApp(soulBaseUrl: string): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", createSessionsProxyRouter({ soulBaseUrl }));
  return app;
}

describe("Sessions Proxy Routes", () => {
  let mockSoul: MockSoulServer;
  let dashServer: Server;
  let dashPort: number;

  beforeEach(async () => {
    mockSoul = await createMockSoulServer();
    const dashApp = createDashboardApp(`http://localhost:${mockSoul.port}`);
    dashServer = createServer(dashApp);

    await new Promise<void>((resolve) => {
      dashServer.listen(0, () => resolve());
    });
    const addr = dashServer.address();
    dashPort = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => dashServer?.close(() => resolve()));
    await new Promise<void>((resolve) =>
      mockSoul?.server?.close(() => resolve()),
    );
  });

  describe("GET /api/sessions", () => {
    it("세션이 없을 때 빈 목록 반환", async () => {
      const res = await fetch(`http://localhost:${dashPort}/api/sessions`);
      expect(res.ok).toBe(true);

      const data = (await res.json()) as { sessions: unknown[] };
      expect(data.sessions).toEqual([]);
    });

    it("Soul Server의 세션 목록을 프록시하여 반환", async () => {
      mockSoul.sessions.push(
        {
          agent_session_id: "sess-001",
          status: "completed",
          prompt: "Hello",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:01:00Z",
        },
        {
          agent_session_id: "sess-002",
          status: "running",
          prompt: "World",
          created_at: "2024-01-01T00:02:00Z",
          updated_at: "2024-01-01T00:03:00Z",
        },
      );

      const res = await fetch(`http://localhost:${dashPort}/api/sessions`);
      expect(res.ok).toBe(true);

      const data = (await res.json()) as { sessions: unknown[] };
      expect(data.sessions).toHaveLength(2);
    });
  });

  describe("GET /api/sessions/stream", () => {
    it("SSE 스트림으로 세션 목록을 받음", async () => {
      mockSoul.sessions.push({
        agent_session_id: "sess-sse",
        status: "running",
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      });

      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/stream`,
      );
      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const text = await res.text();
      expect(text).toContain("event: session_list");
      expect(text).toContain("sess-sse");
    });
  });

  describe("GET /api/sessions/:id/events", () => {
    it("저장된 이벤트와 history_sync 이벤트를 SSE로 반환", async () => {
      mockSoul.events.set("sess-history", [
        { id: 1, event: { type: "progress", text: "Working..." } },
        { id: 2, event: { type: "text_start" } },
        { id: 3, event: { type: "text_delta", text: "Hello" } },
        { id: 4, event: { type: "complete", result: "Done" } },
      ]);
      mockSoul.isLive.set("sess-history", false);

      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/sess-history/events`,
      );
      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const text = await res.text();
      expect(text).toContain("event: progress");
      expect(text).toContain("event: text_start");
      expect(text).toContain("event: text_delta");
      expect(text).toContain("event: complete");
      expect(text).toContain("event: history_sync");
      expect(text).toContain('"last_event_id":4');
    });

    it("존재하지 않는 세션이면 404 반환", async () => {
      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/nonexistent/events`,
      );
      expect(res.status).toBe(404);

      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe("SESSION_NOT_FOUND");
    });

    it("Last-Event-ID 헤더를 전달하여 이후 이벤트만 수신", async () => {
      mockSoul.events.set("sess-resume", [
        { id: 1, event: { type: "progress", text: "Step 1" } },
        { id: 2, event: { type: "progress", text: "Step 2" } },
        { id: 3, event: { type: "progress", text: "Step 3" } },
      ]);
      mockSoul.isLive.set("sess-resume", true);

      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/sess-resume/events`,
        {
          headers: {
            "Last-Event-ID": "1",
          },
        },
      );
      expect(res.ok).toBe(true);

      const text = await res.text();
      // id: 1 이벤트는 포함되지 않아야 함
      expect(text).not.toContain('"Step 1"');
      // id: 2, 3 이벤트는 포함되어야 함
      expect(text).toContain('"Step 2"');
      expect(text).toContain('"Step 3"');
      expect(text).toContain('"is_live":true');
    });
  });
});
