/**
 * Events Routes 단위 테스트
 *
 * GET /api/sessions/:id/events - SSE 이벤트 스트림
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

const TEST_DIR = join(tmpdir(), "soul-dash-events-" + Date.now());

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

describe("Events Routes", () => {
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

  describe("GET /api/sessions/:id/events", () => {
    it("잘못된 세션 ID 형식이면 400 반환", async () => {
      const res = await fetch(
        `http://localhost:${port}/api/sessions/invalid-no-colon/events`,
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("INVALID_SESSION_ID");
    });

    it("SSE 연결 수립 후 connected 이벤트 수신", async () => {
      const res = await fetch(
        `http://localhost:${port}/api/sessions/bot:req-sse-1/events`,
      );

      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(res.headers.get("cache-control")).toContain("no-cache");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let collected = "";

      const timeout = setTimeout(() => reader.cancel(), 2000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          collected += decoder.decode(value, { stream: true });
          // connected 이벤트를 수신하면 중단
          if (collected.includes("event: connected")) break;
        }
      } catch {
        /* reader cancelled */
      }
      clearTimeout(timeout);

      expect(collected).toContain("event: connected");
      expect(collected).toContain("bot:req-sse-1");
    });

    it("기존 JSONL 이벤트를 SSE로 재생", async () => {
      createTestJsonl("bot", "req-replay", [
        { id: 1, event: { type: "progress", text: "Starting..." } },
        { id: 2, event: { type: "session", session_id: "sess-123" } },
        { id: 3, event: { type: "text_start", card_id: "c1" } },
        { id: 4, event: { type: "text_delta", card_id: "c1", text: "Hello world" } },
        { id: 5, event: { type: "text_end", card_id: "c1" } },
        { id: 6, event: { type: "complete", result: "Done", attachments: [] } },
      ]);

      const res = await fetch(
        `http://localhost:${port}/api/sessions/bot:req-replay/events`,
      );

      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let collected = "";

      const timeout = setTimeout(() => reader.cancel(), 2000);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          collected += decoder.decode(value, { stream: true });
          // complete 이벤트까지 수신하면 중단
          if (collected.includes("event: complete")) break;
        }
      } catch {
        /* reader cancelled */
      }
      clearTimeout(timeout);

      // connected 이벤트 확인
      expect(collected).toContain("event: connected");

      // 재생된 이벤트들 확인
      expect(collected).toContain("event: progress");
      expect(collected).toContain("event: session");
      expect(collected).toContain("event: text_start");
      expect(collected).toContain("event: text_delta");
      expect(collected).toContain("event: text_end");
      expect(collected).toContain("event: complete");

      // 이벤트 ID 확인
      expect(collected).toContain("id: 1");
      expect(collected).toContain("id: 6");

      // 이벤트 데이터 내용 확인
      expect(collected).toContain("Hello world");
      expect(collected).toContain("sess-123");
    });
  });
});
