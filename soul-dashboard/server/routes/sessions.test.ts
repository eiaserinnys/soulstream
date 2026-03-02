/**
 * Sessions Routes 단위 테스트
 *
 * GET /api/sessions         - 전체 세션 목록 조회
 * GET /api/sessions/:id     - 특정 세션 상세 조회 (:id = agentSessionId)
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

/** 플랫 구조로 JSONL 파일 생성 */
function createTestJsonl(
  agentSessionId: string,
  events: Array<{ id: number; event: Record<string, unknown> }>,
): void {
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(TEST_DIR, `${agentSessionId}.jsonl`), lines, "utf-8");
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
      createTestJsonl("sess-001", [
        { id: 1, event: { type: "progress", text: "Processing..." } },
        { id: 2, event: { type: "session", session_id: "sess-abc" } },
        { id: 3, event: { type: "complete", result: "Done", attachments: [] } },
      ]);

      createTestJsonl("sess-002", [
        { id: 1, event: { type: "user_message", text: "hello", user: "dashboard" } },
        { id: 2, event: { type: "progress", text: "Working..." } },
      ]);

      const res = await fetch(`http://localhost:${port}/api/sessions`);
      expect(res.ok).toBe(true);

      const data = await res.json();
      expect(data.sessions).toHaveLength(2);

      const sess1 = data.sessions.find((s: any) => s.agentSessionId === "sess-001");
      expect(sess1).toBeDefined();
      expect(sess1.status).toBe("completed");
      expect(sess1.eventCount).toBe(3);

      const sess2 = data.sessions.find((s: any) => s.agentSessionId === "sess-002");
      expect(sess2).toBeDefined();
      expect(sess2.status).toBe("running");
      expect(sess2.eventCount).toBe(2);
    });
  });

  describe("GET /api/sessions/:id", () => {
    it("세션 상세 정보와 이벤트 목록 반환", async () => {
      createTestJsonl("sess-detail", [
        { id: 1, event: { type: "progress", text: "Working..." } },
        { id: 2, event: { type: "session", session_id: "sess-xyz" } },
        { id: 3, event: { type: "text_start", card_id: "c1" } },
        { id: 4, event: { type: "text_delta", card_id: "c1", text: "Hello" } },
        { id: 5, event: { type: "text_end", card_id: "c1" } },
        { id: 6, event: { type: "complete", result: "Finished", attachments: [] } },
      ]);

      const res = await fetch(
        `http://localhost:${port}/api/sessions/sess-detail`,
      );
      expect(res.ok).toBe(true);

      const detail = await res.json();
      expect(detail.agentSessionId).toBe("sess-detail");
      expect(detail.status).toBe("completed");
      expect(detail.claudeSessionId).toBe("sess-xyz");
      expect(detail.eventCount).toBe(6);
      expect(detail.result).toBe("Finished");
      expect(detail.events).toHaveLength(6);
      expect(detail.events[0].id).toBe(1);
      expect(detail.events[5].id).toBe(6);
    });

    it("존재하지 않는 세션이면 404 반환", async () => {
      const res = await fetch(
        `http://localhost:${port}/api/sessions/nonexistent-session`,
      );
      expect(res.status).toBe(404);

      const data = await res.json();
      expect(data.error.code).toBe("SESSION_NOT_FOUND");
    });
  });
});
