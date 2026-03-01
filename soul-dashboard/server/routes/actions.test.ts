/**
 * Actions Routes 단위 테스트
 *
 * POST /api/sessions                  - 새 세션 생성
 * POST /api/sessions/:id/resume       - 완료된 세션 재개
 * POST /api/sessions/:id/intervene    - 실행 중인 세션에 개입 메시지 전송
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Server } from "http";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createTestApp,
  startTestServer,
  createMockSoulServer,
  type TestAppContext,
} from "../test-app-factory.js";

const TEST_DIR = join(tmpdir(), "soul-dash-actions-" + Date.now());

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

describe("Actions Routes", () => {
  let dashServer: Server;
  let dashPort: number;
  let soulServer: Server;
  let soulPort: number;
  let soulRequests: Array<{
    type: string;
    body: unknown;
    params?: Record<string, string>;
  }>;
  let ctx: TestAppContext;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const soul = await createMockSoulServer();
    soulServer = soul.server;
    soulPort = soul.port;
    soulRequests = soul.requests;

    ctx = createTestApp({ eventsBaseDir: TEST_DIR, soulPort });
    const started = await startTestServer(ctx.app);
    dashServer = started.server;
    dashPort = started.port;
  });

  afterEach(async () => {
    ctx?.soulClient?.close();
    ctx?.eventHub?.closeAll();
    await new Promise<void>((resolve) => dashServer?.close(() => resolve()));
    await new Promise<void>((resolve) => soulServer?.close(() => resolve()));
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("POST /api/sessions", () => {
    it("prompt 없이 요청하면 400 반환", async () => {
      const res = await fetch(`http://localhost:${dashPort}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("INVALID_REQUEST");
      expect(data.error.message).toContain("prompt");
    });

    it("prompt가 MAX_PROMPT_LENGTH(100000)을 초과하면 400 반환", async () => {
      const hugePrompt = "X".repeat(100_001);
      const res = await fetch(`http://localhost:${dashPort}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: hugePrompt }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("INVALID_REQUEST");
      expect(data.error.message).toContain("maximum length");
    });

    it("정상 요청 시 201으로 세션 생성 성공", async () => {
      const res = await fetch(`http://localhost:${dashPort}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Analyze this code" }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();

      expect(data.clientId).toBe("dashboard");
      expect(data.requestId).toBeDefined();
      expect(data.requestId).toMatch(/^dash-/);
      expect(data.sessionKey).toContain("dashboard:");
      expect(data.status).toBe("running");

      // Soul 서버가 올바른 요청을 수신했는지 확인
      expect(soulRequests).toHaveLength(1);
      expect(soulRequests[0].type).toBe("execute");
      expect((soulRequests[0].body as any).prompt).toBe("Analyze this code");
      expect((soulRequests[0].body as any).client_id).toBe("dashboard");
      expect((soulRequests[0].body as any).use_mcp).toBe(true);
    });
  });

  describe("POST /api/sessions/:id/resume", () => {
    it("잘못된 세션 ID 형식이면 400 반환", async () => {
      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/invalid-no-colon/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "continue" }),
        },
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("INVALID_SESSION_ID");
    });

    it("prompt 없이 요청하면 400 반환", async () => {
      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/bot:req-1/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("INVALID_REQUEST");
      expect(data.error.message).toContain("prompt");
    });

    it("이벤트가 없는 세션이면 404 반환", async () => {
      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/bot:nonexistent/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "try to resume" }),
        },
      );

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe("SESSION_NOT_FOUND");
    });

    it("마지막 이벤트가 progress인 실행 중 세션이면 409 반환", async () => {
      createTestJsonl("dashboard", "req-running", [
        { id: 1, event: { type: "user_message", text: "hello", user: "dashboard" } },
        { id: 2, event: { type: "progress", text: "Still working..." } },
      ]);

      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/dashboard:req-running/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "try to resume" }),
        },
      );

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error.code).toBe("SESSION_STILL_RUNNING");
    });

    it("session 이벤트 없이 완료된 세션이면 404 반환 (claude_session_id 미발견)", async () => {
      createTestJsonl("dashboard", "req-no-session", [
        { id: 1, event: { type: "user_message", text: "test", user: "dashboard" } },
        { id: 2, event: { type: "complete", result: "Done" } },
      ]);

      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/dashboard:req-no-session/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "try to resume" }),
        },
      );

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe("SESSION_NOT_FOUND");
      expect(data.error.message).toContain("claude_session_id");
    });
  });

  describe("POST /api/sessions/:id/intervene", () => {
    it("text 없이 요청하면 400 반환", async () => {
      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/bot:req-1/intervene`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user: "admin" }),
        },
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("INVALID_REQUEST");
      expect(data.error.message).toContain("text");
    });

    it("user 없이 요청하면 400 반환", async () => {
      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/bot:req-1/intervene`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "stop please" }),
        },
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("INVALID_REQUEST");
      expect(data.error.message).toContain("user");
    });

    it("정상 요청 시 Soul 서버에 개입 메시지 전송 성공", async () => {
      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/bot:req-1/intervene`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "Please stop and explain",
            user: "admin",
          }),
        },
      );

      expect(res.ok).toBe(true);

      // Soul 서버가 올바른 요청을 수신했는지 확인
      expect(soulRequests).toHaveLength(1);
      expect(soulRequests[0].type).toBe("intervene");
      expect((soulRequests[0].body as any).text).toBe("Please stop and explain");
      expect((soulRequests[0].body as any).user).toBe("admin");
      expect(soulRequests[0].params!.clientId).toBe("bot");
      expect(soulRequests[0].params!.requestId).toBe("req-1");
    });
  });
});
