/**
 * Events Cached Routes 테스트
 *
 * 캐시 + 라이브 통합 이벤트 스트리밍 테스트.
 *
 * GET /api/sessions/:id/events
 * 1. 캐시에서 Last-Event-ID 이후 이벤트 읽기
 * 2. 캐시된 이벤트 SSE 전송
 * 3. Soul 서버 /sessions/:id/history 프록시 연결
 * 4. 라이브 이벤트 수신 시 캐시에 저장 + 클라이언트 전달
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Server, createServer } from "http";
import express, { type Express } from "express";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { createEventsCachedRouter } from "./events-cached.js";
import { SessionCache } from "../session-cache.js";

interface MockSoulServer {
  server: Server;
  port: number;
  /** 세션별 이벤트 데이터 */
  events: Map<string, Array<{ id: number; event: Record<string, unknown> }>>;
  /** is_live 상태 (세션별) */
  isLive: Map<string, boolean>;
}

const TEST_CACHE_DIR = join(
  import.meta.dirname,
  "../../.test-cache/events-cached",
);

/**
 * Mock Soul Server 생성
 */
function createMockSoulServer(): Promise<MockSoulServer> {
  return new Promise((resolve) => {
    const events = new Map<
      string,
      Array<{ id: number; event: Record<string, unknown> }>
    >();
    const isLive = new Map<string, boolean>();

    const app = express();
    app.use(express.json());

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
      resolve({ server, port, events, isLive });
    });
  });
}

/** 테스트용 Dashboard 앱 생성 */
function createDashboardApp(
  soulBaseUrl: string,
  sessionCache: SessionCache,
): Express {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/sessions",
    createEventsCachedRouter({ soulBaseUrl, sessionCache }),
  );
  return app;
}

describe("Events Cached Routes", () => {
  let mockSoul: MockSoulServer;
  let dashServer: Server;
  let dashPort: number;
  let sessionCache: SessionCache;

  beforeEach(async () => {
    // 캐시 디렉토리 생성
    await mkdir(TEST_CACHE_DIR, { recursive: true });
    sessionCache = new SessionCache({ cacheDir: TEST_CACHE_DIR });

    mockSoul = await createMockSoulServer();
    const dashApp = createDashboardApp(
      `http://localhost:${mockSoul.port}`,
      sessionCache,
    );
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
    // 캐시 디렉토리 정리
    await rm(TEST_CACHE_DIR, { recursive: true, force: true });
  });

  describe("캐시 우선 + 라이브 통합", () => {
    it("캐시가 비어있을 때 Soul 서버에서 이벤트를 받아 캐시에 저장", async () => {
      // Soul 서버에 이벤트 설정
      mockSoul.events.set("sess-new", [
        { id: 1, event: { type: "text_start" } },
        { id: 2, event: { type: "text_delta", text: "Hello" } },
        { id: 3, event: { type: "text_end" } },
      ]);
      mockSoul.isLive.set("sess-new", false);

      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/sess-new/events`,
      );
      expect(res.ok).toBe(true);

      const text = await res.text();
      expect(text).toContain("event: text_start");
      expect(text).toContain("event: text_delta");
      expect(text).toContain("event: text_end");

      // 캐시에 저장되었는지 확인
      const cachedEvents = await sessionCache.readEvents("sess-new");
      expect(cachedEvents).toHaveLength(3);
      expect(cachedEvents[0].id).toBe(1);
      expect(cachedEvents[2].id).toBe(3);
    });

    it("캐시에 이벤트가 있으면 캐시 먼저 전송 후 Soul 서버에서 새 이벤트만 가져옴", async () => {
      // 캐시에 이벤트 미리 저장
      await sessionCache.appendEvent("sess-cached", 1, { type: "text_start" });
      await sessionCache.appendEvent("sess-cached", 2, {
        type: "text_delta",
        text: "Cached",
      });

      // Soul 서버에 전체 이벤트 설정 (id 1, 2, 3)
      mockSoul.events.set("sess-cached", [
        { id: 1, event: { type: "text_start" } },
        { id: 2, event: { type: "text_delta", text: "Cached" } },
        { id: 3, event: { type: "text_end" } },
      ]);
      mockSoul.isLive.set("sess-cached", false);

      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/sess-cached/events`,
      );
      expect(res.ok).toBe(true);

      const text = await res.text();

      // 모든 이벤트가 전송되어야 함 (캐시 + 라이브)
      expect(text).toContain("event: text_start");
      expect(text).toContain("event: text_delta");
      expect(text).toContain("event: text_end");

      // 캐시에 새 이벤트(id: 3)가 저장되었는지 확인
      const cachedEvents = await sessionCache.readEvents("sess-cached");
      expect(cachedEvents).toHaveLength(3);
    });

    it("클라이언트 Last-Event-ID가 있으면 그 이후 이벤트만 전송", async () => {
      // 캐시에 이벤트 저장
      await sessionCache.appendEvent("sess-resume", 1, { type: "event1" });
      await sessionCache.appendEvent("sess-resume", 2, { type: "event2" });
      await sessionCache.appendEvent("sess-resume", 3, { type: "event3" });

      // Soul 서버에 새 이벤트 추가 (id 4, 5)
      mockSoul.events.set("sess-resume", [
        { id: 1, event: { type: "event1" } },
        { id: 2, event: { type: "event2" } },
        { id: 3, event: { type: "event3" } },
        { id: 4, event: { type: "event4" } },
        { id: 5, event: { type: "event5" } },
      ]);
      mockSoul.isLive.set("sess-resume", false);

      // Last-Event-ID: 2 이후의 이벤트만 요청
      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/sess-resume/events`,
        {
          headers: {
            "Last-Event-ID": "2",
          },
        },
      );
      expect(res.ok).toBe(true);

      const text = await res.text();

      // id 1, 2는 포함되지 않아야 함
      expect(text).not.toContain('"type":"event1"');
      expect(text).not.toContain('"type":"event2"');

      // id 3, 4, 5는 포함되어야 함
      expect(text).toContain('"type":"event3"');
      expect(text).toContain('"type":"event4"');
      expect(text).toContain('"type":"event5"');
    });

    it("존재하지 않는 세션이면 404 반환", async () => {
      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/nonexistent/events`,
      );
      expect(res.status).toBe(404);

      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe("SESSION_NOT_FOUND");
    });
  });

  describe("캐시 일관성", () => {
    it("중복 이벤트를 캐시에 저장하지 않음", async () => {
      // 캐시에 이벤트 저장
      await sessionCache.appendEvent("sess-dup", 1, { type: "event1" });
      await sessionCache.appendEvent("sess-dup", 2, { type: "event2" });

      // Soul 서버도 같은 이벤트 (중복)
      mockSoul.events.set("sess-dup", [
        { id: 1, event: { type: "event1" } },
        { id: 2, event: { type: "event2" } },
      ]);
      mockSoul.isLive.set("sess-dup", false);

      await fetch(`http://localhost:${dashPort}/api/sessions/sess-dup/events`);

      // 캐시에 중복 없이 2개만 있어야 함
      const cachedEvents = await sessionCache.readEvents("sess-dup");
      expect(cachedEvents).toHaveLength(2);
    });
  });
});
