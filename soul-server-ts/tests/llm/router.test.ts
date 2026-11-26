import { describe, expect, it } from "vitest";

import { LlmExecutor } from "../../src/llm/executor.js";
import { buildServer } from "../../src/server.js";

import { makeLlmHarness, silentLogger } from "./llm_test_helpers.js";

async function makeServer(authBearerToken = "secret") {
  const harness = makeLlmHarness();
  const executor = new LlmExecutor({
    adapters: { openai: harness.adapter },
    taskManager: harness.taskManager,
    persistence: harness.persistence,
    broadcaster: harness.broadcaster,
    nodeId: "test-node",
    logger: silentLogger,
  });
  const server = await buildServer({
    host: "127.0.0.1",
    port: 0,
    nodeId: "test-node",
    logger: silentLogger,
    llm: {
      executor,
      authBearerToken,
      isProduction: false,
      logger: silentLogger,
    },
  });
  return { server, harness };
}

describe("POST /llm/completions", () => {
  it("Bearer 인증 후 completion 응답을 반환한다", async () => {
    const { server } = await makeServer();
    try {
      const res = await server.inject({
        method: "POST",
        url: "/llm/completions",
        headers: { authorization: "Bearer secret" },
        payload: {
          provider: "openai",
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        content: "Mock response",
        provider: "openai",
        model: "gpt-4o-mini",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      expect(res.json().session_id).toMatch(/^llm-/);
    } finally {
      await server.close();
    }
  });

  it("인증 누락은 401로 거부한다", async () => {
    const { server } = await makeServer();
    try {
      const res = await server.inject({
        method: "POST",
        url: "/llm/completions",
        payload: {
          provider: "openai",
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().detail.error.code).toBe("UNAUTHORIZED");
    } finally {
      await server.close();
    }
  });

  it("개발 모드에서 토큰 미설정이면 인증을 우회한다", async () => {
    const { server } = await makeServer("");
    try {
      const res = await server.inject({
        method: "POST",
        url: "/llm/completions",
        payload: {
          provider: "openai",
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(res.statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("설정되지 않은 provider는 400 PROVIDER_NOT_CONFIGURED로 응답한다", async () => {
    const { server } = await makeServer();
    try {
      const res = await server.inject({
        method: "POST",
        url: "/llm/completions",
        headers: { authorization: "Bearer secret" },
        payload: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().detail.error.code).toBe("PROVIDER_NOT_CONFIGURED");
    } finally {
      await server.close();
    }
  });

  it("잘못된 요청 body는 422로 응답한다", async () => {
    const { server } = await makeServer();
    try {
      const res = await server.inject({
        method: "POST",
        url: "/llm/completions",
        headers: { authorization: "Bearer secret" },
        payload: {
          provider: "openai",
        },
      });

      expect(res.statusCode).toBe(422);
    } finally {
      await server.close();
    }
  });
});
