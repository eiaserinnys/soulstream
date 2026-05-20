import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import {
  CLAUDE_OAUTH_TOKEN_ENV,
  ClaudeEngineAdapter,
  buildClaudeEnvironment,
  normalizeClaudeModel,
  type ClaudeClient,
  type ClaudeClientEvent,
  type ClaudeRunOptions,
} from "../../src/engine/claude_adapter.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";

const silentLogger = pino({ level: "silent" });

async function* clientEvents(events: ClaudeClientEvent[]): AsyncGenerator<ClaudeClientEvent> {
  for (const event of events) {
    yield event;
  }
}

function makeClient(events: ClaudeClientEvent[], captured: ClaudeRunOptions[]): ClaudeClient {
  return {
    async *run(options: ClaudeRunOptions): AsyncIterable<ClaudeClientEvent> {
      captured.push(options);
      yield* clientEvents(events);
    },
    async interrupt() {
      return true;
    },
    async close() {
      // no-op
    },
  };
}

describe("ClaudeEngineAdapter options parity", () => {
  it("model이 undefined/null/빈 문자열이면 client options에서 model을 생략한다", async () => {
    expect(normalizeClaudeModel(undefined)).toBeUndefined();
    expect(normalizeClaudeModel(null)).toBeUndefined();
    expect(normalizeClaudeModel("")).toBeUndefined();
    expect(normalizeClaudeModel("   ")).toBeUndefined();

    for (const model of [undefined, null, ""] as const) {
      const captured: ClaudeRunOptions[] = [];
      const engine = new ClaudeEngineAdapter(
        {
          workspaceDir: "/tmp/claude-work",
          client: makeClient([], captured),
          processEnv: {},
        },
        silentLogger,
      );
      for await (const _ of engine.execute({ prompt: "hi", model })) {
        // drain
      }
      expect(captured[0]).not.toHaveProperty("model");
    }
  });

  it("model이 있으면 정규화한 값을 client options에 전달한다", async () => {
    const captured: ClaudeRunOptions[] = [];
    const engine = new ClaudeEngineAdapter(
      {
        workspaceDir: "/tmp/claude-work",
        client: makeClient([], captured),
        processEnv: {},
      },
      silentLogger,
    );

    for await (const _ of engine.execute({ prompt: "hi", model: " claude-sonnet-4.5 " })) {
      // drain
    }

    expect(captured[0]).toMatchObject({
      model: "claude-sonnet-4.5",
      workspaceDir: "/tmp/claude-work",
    });
  });

  it("task-level OAuth extraEnv가 process env 토큰보다 우선한다", () => {
    const env = buildClaudeEnvironment({
      processEnv: {
        HOME: "/home/test",
        [CLAUDE_OAUTH_TOKEN_ENV]: "env-token",
      },
      extraEnv: {
        [CLAUDE_OAUTH_TOKEN_ENV]: "task-token",
      },
    });

    expect(env[CLAUDE_OAUTH_TOKEN_ENV]).toBe("task-token");
    expect(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe("1");
    expect(env.HOME).toBe("/home/test");
  });

  it("task-level OAuth가 없으면 process env 토큰을 보존하고, 둘 다 없으면 토큰 키를 만들지 않는다", () => {
    expect(
      buildClaudeEnvironment({
        processEnv: { [CLAUDE_OAUTH_TOKEN_ENV]: "env-token" },
      })[CLAUDE_OAUTH_TOKEN_ENV],
    ).toBe("env-token");

    expect(
      buildClaudeEnvironment({
        processEnv: { HOME: "/home/test" },
      }),
    ).not.toHaveProperty(CLAUDE_OAUTH_TOKEN_ENV);
  });
});

describe("ClaudeEngineAdapter fake client flow", () => {
  it("fake client session/text/complete를 SSE payload로 yield하고 onSession을 호출한다", async () => {
    const captured: ClaudeRunOptions[] = [];
    const client = makeClient(
      [
        { type: "session", sessionId: "claude-sess-1" },
        { type: "text", text: "hello from claude" },
        { type: "complete" },
      ],
      captured,
    );
    const engine = new ClaudeEngineAdapter(
      { workspaceDir: "/tmp/claude-work", client, processEnv: {} },
      silentLogger,
    );
    const onSession = vi.fn();
    const seen: SSEEventPayload[] = [];

    for await (const event of engine.execute({ prompt: "hi", onSession })) {
      seen.push(event);
    }

    expect(onSession).toHaveBeenCalledWith("claude-sess-1");
    expect(captured[0]).toMatchObject({
      prompt: "hi",
      workspaceDir: "/tmp/claude-work",
    });
    expect(seen.map((event) => event.type)).toEqual([
      "session",
      "text_start",
      "text_delta",
      "text_end",
      "complete",
    ]);
    expect(seen[0]).toEqual({ type: "session", session_id: "claude-sess-1" });
    expect(seen[2]).toMatchObject({ type: "text_delta", text: "hello from claude" });
    expect(seen[4]).toMatchObject({ type: "complete", result: "hello from claude" });
  });

  it("client error event를 fatal error SSE로 전달하고 complete를 강제하지 않는다", async () => {
    const captured: ClaudeRunOptions[] = [];
    const engine = new ClaudeEngineAdapter(
      {
        workspaceDir: "/tmp/claude-work",
        client: makeClient([{ type: "error", message: "boom" }], captured),
        processEnv: {},
      },
      silentLogger,
    );
    const seen: SSEEventPayload[] = [];

    await expect(async () => {
      for await (const event of engine.execute({ prompt: "hi" })) {
        seen.push(event);
      }
    }).rejects.toThrow("boom");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "error", message: "boom", fatal: true });
  });
});
