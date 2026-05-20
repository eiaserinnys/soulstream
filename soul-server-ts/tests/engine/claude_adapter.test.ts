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

  it("fake client의 Claude parity 이벤트를 mapper 출력 그대로 yield한다", async () => {
    const captured: ClaudeRunOptions[] = [];
    const engine = new ClaudeEngineAdapter(
      {
        workspaceDir: "/tmp/claude-work",
        client: makeClient(
          [
            { type: "tool_start", toolName: "Read", toolInput: { file_path: "a.ts" }, toolUseId: "toolu_1", timestamp: 1 },
            { type: "tool_result", toolName: "Read", result: "content", toolUseId: "toolu_1", timestamp: 2 },
            { type: "thinking", thinking: "checking", timestamp: 3 },
            { type: "result", success: true, output: "content", timestamp: 4 },
            { type: "prompt_suggestion", text: "next?", timestamp: 5 },
            { type: "rate_limit", status: "allowed_warning", utilization: 0.91, timestamp: 6 },
            { type: "compact", trigger: "auto", message: "compacted", timestamp: 7 },
            { type: "subagent_start", agentId: "sub-1", agentType: "explorer", timestamp: 8 },
            { type: "subagent_stop", agentId: "sub-1", timestamp: 9 },
          ],
          captured,
        ),
        processEnv: {},
      },
      silentLogger,
    );
    const seen: SSEEventPayload[] = [];

    for await (const event of engine.execute({ prompt: "hi" })) {
      seen.push(event);
    }

    expect(seen.map((event) => event.type)).toEqual([
      "tool_start",
      "tool_result",
      "thinking",
      "result",
      "prompt_suggestion",
      "credential_alert",
      "compact",
      "subagent_start",
      "subagent_stop",
    ]);
    expect(seen[0]).toMatchObject({
      type: "tool_start",
      tool_name: "Read",
      tool_input: { file_path: "a.ts" },
      tool_use_id: "toolu_1",
    });
    expect(seen[5]).toMatchObject({
      type: "credential_alert",
      status: "allowed_warning",
      utilization: 0.91,
    });
  });

  it("fake client input_request를 SSE로 yield하고 deliverInputResponse를 client에 전달한다", async () => {
    const delivered: Array<{ requestId: string; answers: Record<string, unknown> }> = [];
    const release = deferred<void>();
    const client: ClaudeClient = {
      async *run(): AsyncIterable<ClaudeClientEvent> {
        yield {
          type: "input_request",
          requestId: "ask-1",
          toolUseId: "toolu_ask",
          questions: [{ question: "진행할까요?", header: "확인", options: [] }],
          startedAt: 1779264000,
          timeoutSec: 300,
          timestamp: 10,
        };
        await release.promise;
        yield { type: "complete", result: "done", timestamp: 11 };
      },
      async deliverInputResponse(requestId, answers) {
        delivered.push({ requestId, answers });
        return true;
      },
    };
    const engine = new ClaudeEngineAdapter(
      { workspaceDir: "/tmp/claude-work", client, processEnv: {} },
      silentLogger,
    );

    const iter = engine.execute({ prompt: "hi" })[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value).toMatchObject({
      type: "input_request",
      request_id: "ask-1",
      tool_use_id: "toolu_ask",
    });

    await expect(
      engine.deliverInputResponse("ask-1", { "진행할까요?": "진행" }),
    ).resolves.toEqual({ status: "delivered" });
    expect(delivered).toEqual([
      { requestId: "ask-1", answers: { "진행할까요?": "진행" } },
    ]);

    await expect(
      engine.deliverInputResponse("ask-1", { "진행할까요?": "다시" }),
    ).resolves.toEqual({ status: "already_responded" });

    release.resolve();
    const second = await iter.next();
    expect(second.value).toMatchObject({ type: "complete", result: "done" });
    await expect(iter.next()).resolves.toMatchObject({ done: true });
  });

  it("expired input_request 이후 late response는 delivered가 아니다", async () => {
    const client: ClaudeClient = {
      async *run(): AsyncIterable<ClaudeClientEvent> {
        yield {
          type: "input_request",
          requestId: "ask-expired",
          questions: [],
          startedAt: 1779264000,
          timeoutSec: 1,
        };
        yield { type: "input_request_expired", requestId: "ask-expired" };
      },
      async deliverInputResponse() {
        throw new Error("should not be called after expired");
      },
    };
    const engine = new ClaudeEngineAdapter(
      { workspaceDir: "/tmp/claude-work", client, processEnv: {} },
      silentLogger,
    );
    for await (const _ of engine.execute({ prompt: "hi" })) {
      // drain input_request and expired
    }

    await expect(
      engine.deliverInputResponse("ask-expired", { q: "late" }),
    ).resolves.toEqual({ status: "expired" });
  });

  it("fake client가 run options의 onIntervention으로 running intervention prompt를 즉시 주입받는다", async () => {
    const injected: Array<string | null> = [];
    const client: ClaudeClient = {
      async *run(options: ClaudeRunOptions): AsyncIterable<ClaudeClientEvent> {
        yield { type: "session", sessionId: "claude-sess-1" };
        injected.push(await options.onIntervention?.() ?? null);
        yield { type: "text", text: injected[0] ?? "no intervention" };
        yield { type: "complete" };
      },
    };
    const engine = new ClaudeEngineAdapter(
      { workspaceDir: "/tmp/claude-work", client, processEnv: {} },
      silentLogger,
    );
    const onIntervention = vi.fn().mockResolvedValue("injected while waiting");
    const seen: SSEEventPayload[] = [];

    for await (const event of engine.execute({ prompt: "hi", onIntervention })) {
      seen.push(event);
    }

    expect(onIntervention).toHaveBeenCalledTimes(1);
    expect(injected).toEqual(["injected while waiting"]);
    expect(seen.map((event) => event.type)).toEqual([
      "session",
      "text_start",
      "text_delta",
      "text_end",
      "complete",
    ]);
    expect(seen[2]).toMatchObject({
      type: "text_delta",
      text: "injected while waiting",
    });
  });

  it("ClaudeEngineAdapter.compact는 fake client compact boundary를 호출한다", async () => {
    const compact = vi.fn().mockResolvedValue(undefined);
    const client: ClaudeClient = {
      async *run(): AsyncIterable<ClaudeClientEvent> {
        yield { type: "complete" };
      },
      compact,
    };
    const engine = new ClaudeEngineAdapter(
      { workspaceDir: "/tmp/claude-work", client, processEnv: {} },
      silentLogger,
    );

    await engine.compact("claude-sess-1");

    expect(compact).toHaveBeenCalledWith("claude-sess-1");
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
