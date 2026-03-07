/**
 * Actions Routes 단위 테스트
 *
 * POST /api/sessions                  - 새 세션 생성
 * POST /api/sessions/:id/intervene    - 실행 중/완료된 세션에 메시지 전송
 * POST /api/sessions/:id/message      - intervene 레거시 호환 경로
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Server } from "http";
import {
  createTestApp,
  startTestServer,
  createMockSoulServer,
  type TestAppContext,
} from "../test-app-factory.js";

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
    const soul = await createMockSoulServer();
    soulServer = soul.server;
    soulPort = soul.port;
    soulRequests = soul.requests;

    ctx = createTestApp({ soulPort });
    const started = await startTestServer(ctx.app);
    dashServer = started.server;
    dashPort = started.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => dashServer?.close(() => resolve()));
    await new Promise<void>((resolve) => soulServer?.close(() => resolve()));
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

    it("정상 요청 시 201으로 세션 생성 성공 (agentSessionId 반환)", async () => {
      const res = await fetch(`http://localhost:${dashPort}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Analyze this code" }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();

      expect(data.agentSessionId).toBeDefined();
      expect(data.agentSessionId).toMatch(/^sess-/);
      expect(data.status).toBe("running");

      // Soul 서버가 올바른 요청을 수신했는지 확인
      expect(soulRequests).toHaveLength(1);
      expect(soulRequests[0].type).toBe("execute");
      expect((soulRequests[0].body as any).prompt).toBe("Analyze this code");
      // 새 세션에서는 agent_session_id를 보내지 않음 (서버가 생성)
      expect((soulRequests[0].body as any).agent_session_id).toBeUndefined();
      expect((soulRequests[0].body as any).use_mcp).toBe(true);
    });
  });

  describe("POST /api/sessions/:id/intervene", () => {
    it("잘못된 세션 ID 형식이면 400 반환", async () => {
      // 유효하지 않은 문자가 포함된 ID
      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/${encodeURIComponent("../invalid")}/intervene`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "stop please",
            user: "admin",
          }),
        },
      );

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("INVALID_SESSION_ID");
    });

    it("text 없이 요청하면 400 반환", async () => {
      const res = await fetch(
        `http://localhost:${dashPort}/api/sessions/sess-abc/intervene`,
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
        `http://localhost:${dashPort}/api/sessions/sess-abc/intervene`,
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
        `http://localhost:${dashPort}/api/sessions/sess-abc/intervene`,
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
      expect(soulRequests[0].params!.agentSessionId).toBe("sess-abc");
    });
  });
});
