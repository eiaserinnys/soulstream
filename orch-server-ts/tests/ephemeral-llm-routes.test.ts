import { describe, expect, it, vi } from "vitest";

import {
  CodexEphemeralExecutionError,
  createApp,
  parseOrchServerConfig,
  type CodexExecGenerateRequest,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "service-token",
});

describe("ephemeral LLM routes", () => {
  it("requires the configured service bearer token", async () => {
    const generate = vi.fn();
    const app = createApp({
      config,
      ephemeralLlmRoutes: { authBearerToken: "service-token", generator: { generate } },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/ephemeral",
      payload: { prompt: "hello", model: "gpt-5.6-luna" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      detail: { error: { code: "UNAUTHORIZED", message: "bearer token is missing" } },
    });
    expect(generate).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects invalid efforts, retry counts, and timeouts", async () => {
    const generate = vi.fn();
    const app = createApp({
      config,
      ephemeralLlmRoutes: { authBearerToken: "service-token", generator: { generate } },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/ephemeral",
      headers: { authorization: "Bearer service-token" },
      payload: {
        prompt: "hello",
        model: "gpt-5.6-luna",
        reasoning_effort: "ultra",
        timeout_ms: 120_001,
        max_attempts: 0,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      detail: { error: { code: "INVALID_EPHEMERAL_LLM_REQUEST" } },
    });
    expect(generate).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes the complete request contract to the isolated external executor", async () => {
    const generate = vi.fn(async (_request: CodexExecGenerateRequest) => ({
      content: '{"translations":[]}',
      model: "gpt-5.6-luna",
      latencyMs: 321,
      attempts: 1,
      spawnDurationMs: 300,
      peakConcurrentSpawns: 1,
      usage: { input_tokens: 11, output_tokens: 7 },
    }));
    const app = createApp({
      config,
      ephemeralLlmRoutes: { authBearerToken: "service-token", generator: { generate } },
    });
    const outputSchema = {
      type: "object",
      properties: { translations: { type: "array" } },
      required: ["translations"],
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/ephemeral",
      headers: { authorization: "Bearer service-token" },
      payload: {
        prompt: "translate",
        model: "gpt-5.6-luna",
        reasoning_effort: "xhigh",
        output_schema: outputSchema,
        timeout_ms: 90_000,
        max_attempts: 2,
        purpose: "inbox_translation",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      content: '{"translations":[]}',
      model: "gpt-5.6-luna",
      latency_ms: 321,
      attempts: 1,
      usage: { input_tokens: 11, output_tokens: 7 },
    });
    expect(generate).toHaveBeenCalledWith({
      prompt: "translate",
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
      outputSchema,
      timeoutMs: 90_000,
      maxAttempts: 2,
      concurrencyLimit: 1,
    });
    await app.close();
  });

  it.each([
    ["CODEX_UNAVAILABLE", 503],
    ["CODEX_TIMEOUT", 504],
    ["CODEX_INVALID_OUTPUT", 502],
    ["CODEX_EXEC_FAILED", 502],
  ] as const)("maps %s to an explicit HTTP failure", async (code, statusCode) => {
    const generate = vi.fn(async () => {
      throw new CodexEphemeralExecutionError(code, "failed", {
        attempts: 1,
        latencyMs: 10,
        spawnDurationMs: 10,
        peakConcurrentSpawns: 1,
      });
    });
    const app = createApp({
      config,
      ephemeralLlmRoutes: { authBearerToken: "service-token", generator: { generate } },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/ephemeral",
      headers: { authorization: "Bearer service-token" },
      payload: { prompt: "hello", model: "gpt-5.6-sol" },
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({
      detail: { error: { code, message: "failed" } },
    });
    await app.close();
  });
});
