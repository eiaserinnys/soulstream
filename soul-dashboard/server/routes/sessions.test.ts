/**
 * Sessions Routes 단위 테스트
 *
 * GET /api/sessions         - 전체 세션 목록 조회
 * GET /api/sessions/:id     - 특정 세션 상세 조회
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Server } from "http";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createTestApp,
  startTestServer,
  type TestAppContext,
} from "../test-app-factory.js";

const TEST_DIR = join(tmpdir(), "soul-dash-sessions-" + Date.now());

function createTestJsonl(
  clientId: string,
  requestId: string,
  events: Array<{ id: number; event: Record<string, unknown> }>,
): void {
  const dir = join(TEST_DIR, clientId);
  mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, `${requestId}.jsonl`), lines, "utf-8");
}

describe("Sessions Routes", () => {
  let server: Server;
  let port: number;
  let ctx: TestAppContext;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    ctx = createTestApp({ eventsBaseDir: TEST_DIR });
    const started = await startTestServer(ctx.app);
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    ctx?.soulClient?.close();
    ctx?.eventHub?.closeAll();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("GET /api/sessions", () => {
    it("세션이 없을 때 빈 목록 반환", async () => {
      const res = await fetch(`http://localhost:${port}/api/sessions`);
      expect(res.ok).toBe(true);

      const data = await res.json();
      expect(data.sessions).toEqual([]);
    });

    it("JSONL 파일에서 세션 목록 반환", async () => {
      createTestJsonl("bot", "req-001", [
        { id: 1, event: { type: "progress", text: "Processing..." } },
        { id: 2, event: { type: "session", session_id: "sess-abc" } },
        { id: 3, event: { type: "complete", result: "Done", attachments: [] } },
      ]);

      createTestJsonl("dashboard", "req-002", [
        { id: 1, event: { type: "user_message", text: "hello", user: "dashboard" } },
        { id: 2, event: { type: "progress", text: "Working..." } },
      ]);

      const res = await fetch(`http://localhost:${port}/api/sessions`);
      expect(res.ok).toBe(true);

      const data = await res.json();
      expect(data.sessions).toHaveLength(2);

      const botSession = data.sessions.find((s: any) => s.clientId === "bot");
      expect(botSession).toBeDefined();
      expect(botSession.requestId).toBe("req-001");
      expect(botSession.status).toBe("completed");
      expect(botSession.eventCount).toBe(3);

      const dashSession = data.sessions.find((s: any) => s.clientId === "dashboard");
      expect(dashSession).toBeDefined();
      expect(dashSession.requestId).toBe("req-002");
      expect(dashSession.status).toBe("running");
      expect(dashSession.eventCount).toBe(2);
    });
  });

  describe("GET /api/sessions/:id", () => {
    it("세션 상세 정보와 이벤트 목록 반환", async () => {
      createTestJsonl("bot", "req-detail", [
        { id: 1, event: { type: "progress", text: "Working..." } },
        { id: 2, event: { type: "session", session_id: "sess-xyz" } },
        { id: 3, event: { type: "text_start", card_id: "c1" } },
        { id: 4, event: { type: "text_delta", card_id: "c1", text: "Hello" } },
        { id: 5, event: { type: "text_end", card_id: "c1" } },
        { id: 6, event: { type: "complete", result: "Finished", attachments: [] } },
      ]);

      const res = await fetch(
        `http://localhost:${port}/api/sessions/bot:req-detail`,
      );
      expect(res.ok).toBe(true);

      const detail = await res.json();
      expect(detail.clientId).toBe("bot");
      expect(detail.requestId).toBe("req-detail");
      expect(detail.status).toBe("completed");
      expect(detail.claudeSessionId).toBe("sess-xyz");
      expect(detail.eventCount).toBe(6);
      expect(detail.prompt).toBe("Working...");
      expect(detail.result).toBe("Finished");
      expect(detail.events).toHaveLength(6);
      expect(detail.events[0].id).toBe(1);
      expect(detail.events[5].id).toBe(6);
    });

    it("콜론이 없는 잘못된 세션 ID 형식이면 400 반환", async () => {
      const res = await fetch(
        `http://localhost:${port}/api/sessions/invalid-no-colon`,
      );
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error.code).toBe("INVALID_SESSION_ID");
    });

    it("존재하지 않는 세션이면 404 반환", async () => {
      const res = await fetch(
        `http://localhost:${port}/api/sessions/bot:nonexistent-req`,
      );
      expect(res.status).toBe(404);

      const data = await res.json();
      expect(data.error.code).toBe("SESSION_NOT_FOUND");
    });
  });
});
