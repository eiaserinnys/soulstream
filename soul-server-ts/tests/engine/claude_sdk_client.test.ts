import type {
  PermissionResult,
  Query as ClaudeSdkQuery,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { ClaudeSdkClient } from "../../src/engine/claude_adapter.js";
import type {
  ClaudeSdkQueryFn,
  ClaudeSdkQueryParams,
} from "../../src/engine/claude_sdk_client.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";

const silentLogger = pino({ level: "silent" });

describe("ClaudeSdkClient", () => {
  it("SDK query options match Python Claude runner parity and map SDK messages to client events", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    const queryFn: ClaudeSdkQueryFn = (params) => {
      captured.push(params);
      return makeQuery(
        sdkMessages([
          sdkSystemInit("claude-sess-1"),
          {
            type: "assistant",
            message: {
              content: [
                { type: "text", text: "hello" },
                { type: "thinking", thinking: "checking", signature: "sig" },
                { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
              ],
            },
            parent_tool_use_id: null,
            uuid: "assistant-1",
            session_id: "claude-sess-1",
          },
          {
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file", is_error: false }],
            },
            parent_tool_use_id: null,
            uuid: "user-1",
            session_id: "claude-sess-1",
          },
          {
            type: "prompt_suggestion",
            suggestion: "next?",
            uuid: "suggestion-1",
            session_id: "claude-sess-1",
          },
          sdkSuccessResult("claude-sess-1", "done"),
        ]),
      );
    };
    const client = new ClaudeSdkClient({ query: queryFn }, silentLogger);

    const events = await collect(
      client.run(
        {
          prompt: "hi",
          workspaceDir: "/tmp/claude-work",
          resumeSessionId: "resume-1",
          model: "claude-sonnet-4.5",
          systemPrompt: "system",
          env: {
            HOME: "/home/test",
            CLAUDE_CODE_OAUTH_TOKEN: "task-token",
            CLAUDE_CODE_EXECPATH: "/opt/claude",
          },
        },
        new AbortController().signal,
      ),
    );

    expect(captured[0]?.options).toMatchObject({
      cwd: "/tmp/claude-work",
      env: {
        HOME: "/home/test",
        CLAUDE_CODE_OAUTH_TOKEN: "task-token",
        CLAUDE_CODE_EXECPATH: "/opt/claude",
      },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project"],
      promptSuggestions: true,
      includePartialMessages: false,
      model: "claude-sonnet-4.5",
      systemPrompt: "system",
      resume: "resume-1",
      pathToClaudeCodeExecutable: "/opt/claude",
    });
    expect(captured[0]?.options?.canUseTool).toEqual(expect.any(Function));
    expect(events.map((event) => event.type)).toEqual([
      "session",
      "text",
      "thinking",
      "tool_start",
      "tool_result",
      "prompt_suggestion",
      "result",
      "complete",
    ]);
    expect(events[0]).toEqual({ type: "session", sessionId: "claude-sess-1" });
    expect(events[3]).toMatchObject({
      type: "tool_start",
      toolName: "Read",
      toolInput: { file_path: "a.ts" },
      toolUseId: "toolu_1",
    });
    expect(events[4]).toMatchObject({
      type: "tool_result",
      toolName: "Read",
      result: "file",
      toolUseId: "toolu_1",
    });
    expect(events[5]).toMatchObject({
      type: "prompt_suggestion",
      text: "next?",
    });
    expect(events[7]).toMatchObject({
      type: "complete",
      result: "done",
      claudeSessionId: "claude-sess-1",
    });
  });

  it("forwards allowedTools / disallowedTools / maxTurns to SDK options (Python agents.yaml parity)", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          captured.push(params);
          return makeQuery(sdkMessages([sdkSuccessResult("claude-sess-opts", "done")]));
        },
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    await collect(
      client.run(
        {
          prompt: "hi",
          workspaceDir: "/tmp/claude-work",
          env: {},
          allowedTools: ["Read", "Bash"],
          disallowedTools: ["WebFetch"],
          maxTurns: 25,
        },
        new AbortController().signal,
      ),
    );

    expect(captured[0]?.options).toMatchObject({
      allowedTools: ["Read", "Bash"],
      disallowedTools: ["WebFetch"],
      maxTurns: 25,
    });
  });

  it("omits SDK model and executable options when caller does not provide them", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          captured.push(params);
          return makeQuery(sdkMessages([sdkSuccessResult("claude-sess-2", "done")]));
        },
      },
      silentLogger,
    );

    await collect(
      client.run(
        {
          prompt: "hi",
          workspaceDir: "/tmp/claude-work",
          env: {},
        },
        new AbortController().signal,
      ),
    );

    expect(captured[0]?.options).not.toHaveProperty("model");
    expect(captured[0]?.options).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  it("emits complete as soon as SDK result arrives and closes the streaming query", async () => {
    let query: ClaudeSdkQuery | undefined;
    const client = new ClaudeSdkClient(
      {
        query: () => {
          query = makeQuery(
            (async function* () {
              yield sdkSuccessResult("claude-sess-done", "done");
              await new Promise<never>(() => {});
            })(),
          );
          return query;
        },
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        {
          prompt: "hi",
          workspaceDir: "/tmp/claude-work",
          env: {},
        },
        new AbortController().signal,
      ),
    );

    expect(events.map((event) => event.type)).toEqual(["result", "complete"]);
    expect(query?.close).toHaveBeenCalledTimes(1);
  });

  it("bridges AskUserQuestion canUseTool to input_request and returns updatedInput after delivery", async () => {
    const permissionResults: PermissionResult[] = [];
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const permission = await params.options?.canUseTool?.(
                "AskUserQuestion",
                {
                  questions: [
                    {
                      question: "진행할까요?",
                      header: "확인",
                      options: [{ label: "진행", description: "continue" }],
                    },
                  ],
                },
                {
                  signal: new AbortController().signal,
                  toolUseID: "toolu_ask",
                },
              );
              if (permission) permissionResults.push(permission);
              yield sdkSuccessResult("claude-sess-3", "answered");
            })(),
          ),
        inputRequestTimeoutMs: 1_000,
      },
      silentLogger,
    );

    const iter = client
      .run(
        {
          prompt: "hi",
          workspaceDir: "/tmp/claude-work",
          env: {},
        },
        new AbortController().signal,
      )
      [Symbol.asyncIterator]();

    const first = await iter.next();
    expect(first.value).toMatchObject({
      type: "input_request",
      toolUseId: "toolu_ask",
      questions: [{ question: "진행할까요?" }],
    });
    expect(
      client.deliverInputResponse((first.value as Extract<ClaudeClientEvent, { type: "input_request" }>).requestId, {
        "진행할까요?": "진행",
      }),
    ).toBe(true);

    const remaining = await collectIterator(iter);
    expect(remaining.map((event) => event.type)).toEqual(["result", "complete"]);
    expect(permissionResults).toEqual([
      {
        behavior: "allow",
        updatedInput: expect.objectContaining({
          answers: { "진행할까요?": "진행" },
        }),
        toolUseID: "toolu_ask",
      },
    ]);
  });

  it("injects running interventions through the SDK streaming input", async () => {
    const prompts: string[] = [];
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const input = params.prompt as AsyncIterable<SDKUserMessage>;
              const iterator = input[Symbol.asyncIterator]();
              const initial = await iterator.next();
              prompts.push(messageText(initial.value));
              const injected = await iterator.next();
              prompts.push(messageText(injected.value));
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: messageText(injected.value) }] },
                parent_tool_use_id: null,
                uuid: "assistant-2",
                session_id: "claude-sess-4",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-4", "done");
            })(),
          ),
        interventionPollIntervalMs: 1,
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        {
          prompt: "first",
          workspaceDir: "/tmp/claude-work",
          env: {},
          onIntervention: vi.fn().mockResolvedValueOnce("while running").mockResolvedValue(null),
        },
        new AbortController().signal,
      ),
    );

    expect(prompts).toEqual(["first", "while running"]);
    expect(events.find((event) => event.type === "text")).toMatchObject({
      type: "text",
      text: "while running",
    });
  });

  it("compact resumes the last run context and sends /compact through the SDK", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          captured.push(params);
          return makeQuery(sdkMessages([sdkSuccessResult("claude-sess-5", "done")]));
        },
      },
      silentLogger,
    );

    await collect(
      client.run(
        {
          prompt: "hi",
          workspaceDir: "/tmp/claude-work",
          env: { CLAUDE_CODE_OAUTH_TOKEN: "task-token" },
        },
        new AbortController().signal,
      ),
    );
    await client.compact("claude-sess-5");

    expect(captured).toHaveLength(2);
    expect(captured[1]?.options).toMatchObject({
      cwd: "/tmp/claude-work",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "task-token" },
      resume: "claude-sess-5",
    });
    const compactPrompt = captured[1]?.prompt as AsyncIterable<SDKUserMessage>;
    const first = await compactPrompt[Symbol.asyncIterator]().next();
    expect(messageText(first.value)).toBe("/compact");
  });

  it("drains a prompt_suggestion that arrives after the result message (Python receive_loop._drain_after_result parity)", async () => {
    // SDK 0.2.x typedef: "prompt_suggestion arrives after the result message. Consumers
    // must keep iterating the stream after result to receive it."
    // Python soul-server/claude/receive_loop.py:308-317 drains 1 message for
    // PROMPT_SUGGESTION_DRAIN_TIMEOUT (2s).
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              yield sdkSystemInit("claude-sess-drain");
              yield sdkSuccessResult("claude-sess-drain", "done");
              yield {
                type: "prompt_suggestion",
                suggestion: "Try this next?",
                uuid: "suggestion-drain",
                session_id: "claude-sess-drain",
              } as unknown as SDKMessage;
              // SDK normally closes after suggestion. Simulate that by ending the generator.
            })(),
          ),
        postResultDrainMs: 200,
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "session",
      "result",
      "complete",
      "prompt_suggestion",
    ]);
    expect(events[3]).toEqual({
      type: "prompt_suggestion",
      text: "Try this next?",
    });
  });

  it("post-result drain times out and finishes cleanly when no late prompt_suggestion arrives", async () => {
    let queryRef: ClaudeSdkQuery | undefined;
    const client = new ClaudeSdkClient(
      {
        query: () => {
          queryRef = makeQuery(
            (async function* () {
              yield sdkSuccessResult("claude-sess-no-drain", "done");
              // hang forever — drain phase must time out without leaking.
              await new Promise<never>(() => {});
            })(),
          );
          return queryRef;
        },
        postResultDrainMs: 30,
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(events.map((event) => event.type)).toEqual(["result", "complete"]);
    expect(queryRef?.close).toHaveBeenCalledTimes(1);
  });

  it("post-result drain ignores non prompt_suggestion messages (Python drain phase narrowing)", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              yield sdkSuccessResult("claude-sess-narrow", "done");
              // Unexpected post-result assistant message — drain phase narrows to prompt_suggestion only.
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: "stray" }] },
                parent_tool_use_id: null,
                uuid: "assistant-stray",
                session_id: "claude-sess-narrow",
              } as unknown as SDKMessage;
            })(),
          ),
        postResultDrainMs: 200,
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    // No text event from the stray assistant — drain phase only processes prompt_suggestion.
    expect(events.map((event) => event.type)).toEqual(["result", "complete"]);
  });

  it("AssistantMessage.error field emits a distinct assistant_error (not generic error{fatal:false}) for dashboard classification", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "assistant",
                message: {
                  id: "msg_01_auth",
                  model: "claude-sonnet-4-5",
                  content: [],
                },
                error: "authentication_failed",
                parent_tool_use_id: null,
                uuid: "assistant-auth-fail",
                session_id: "claude-sess-err",
              },
              sdkSuccessResult("claude-sess-err", "done"),
            ]),
          ),
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    const errEvent = events.find((event) => event.type === "assistant_error");
    expect(errEvent).toMatchObject({
      type: "assistant_error",
      errorType: "authentication_failed",
      model: "claude-sonnet-4-5",
      messageId: "msg_01_auth",
    });
    // No generic error{fatal:false} for the assistant error path — assistant_error replaces it.
    expect(events.filter((e) => e.type === "error")).toHaveLength(0);
  });

  it("SystemMessage subtype=away_summary emits away_summary event (Python AwaySummaryEngineEvent parity)", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "system",
                subtype: "away_summary",
                data: { content: "이전 세션에서 X 작업을 진행했습니다." },
                session_id: "claude-sess-away",
              },
              sdkSuccessResult("claude-sess-away", "done"),
            ]),
          ),
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(events.find((event) => event.type === "away_summary")).toEqual({
      type: "away_summary",
      content: "이전 세션에서 X 작업을 진행했습니다.",
    });
  });

  it("rate_limit defensive parser accepts camelCase keys + epoch seconds → ISO", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "allowed_warning",
                  resetsAt: 1779264000, // epoch seconds (2026-05-20)
                  rateLimitType: "five_hour",
                  utilization: 0.92,
                },
                session_id: "claude-sess-rl",
                uuid: "rl-1",
              },
              sdkSuccessResult("claude-sess-rl", "done"),
            ]),
          ),
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    const rl = events.find((event) => event.type === "rate_limit");
    expect(rl).toEqual({
      type: "rate_limit",
      status: "allowed_warning",
      resetsAt: "2026-05-20T08:00:00.000Z",
      rateLimitType: "five_hour",
      utilization: 0.92,
    });
  });

  it("rate_limit defensive parser accepts snake_case keys (Python wire fallback)", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "rejected",
                  resets_at: 1779264000,
                  rate_limit_type: "seven_day",
                  utilization: 1.0,
                },
                session_id: "claude-sess-rl-snake",
                uuid: "rl-snake-1",
              },
              sdkSuccessResult("claude-sess-rl-snake", "done"),
            ]),
          ),
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(events.find((event) => event.type === "rate_limit")).toEqual({
      type: "rate_limit",
      status: "rejected",
      resetsAt: "2026-05-20T08:00:00.000Z",
      rateLimitType: "seven_day",
      utilization: 1.0,
    });
  });

  it("rate_limit defensive parser accepts epoch milliseconds", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "allowed",
                  resetsAt: 1779264000000, // epoch ms (>1e12)
                  rateLimitType: "overage",
                },
                session_id: "claude-sess-rl-ms",
                uuid: "rl-ms-1",
              },
              sdkSuccessResult("claude-sess-rl-ms", "done"),
            ]),
          ),
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(
      (events.find((event) => event.type === "rate_limit") as { resetsAt?: string }).resetsAt,
    ).toBe("2026-05-20T08:00:00.000Z");
  });

  it("rate_limit defensive parser passes ISO string resetsAt through unchanged", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "allowed",
                  resetsAt: "2026-05-20T00:00:00Z",
                  rateLimitType: "five_hour",
                },
                session_id: "claude-sess-rl-iso",
                uuid: "rl-iso-1",
              },
              sdkSuccessResult("claude-sess-rl-iso", "done"),
            ]),
          ),
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(
      (events.find((event) => event.type === "rate_limit") as { resetsAt?: string }).resetsAt,
    ).toBe("2026-05-20T00:00:00Z");
  });

  it("wraps Claude executable startup failures with an explicit operator-facing error", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              throw new Error("spawn /missing/claude ENOENT");
            })(),
          ),
      },
      silentLogger,
    );

    await expect(
      collect(
        client.run(
          {
            prompt: "hi",
            workspaceDir: "/tmp/claude-work",
            env: { CLAUDE_CODE_EXECPATH: "/missing/claude" },
          },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(
      "Claude Code executable failed to start at CLAUDE_CODE_EXECPATH: spawn /missing/claude ENOENT",
    );
  });
});

async function collect(iterable: AsyncIterable<ClaudeClientEvent>): Promise<ClaudeClientEvent[]> {
  const events: ClaudeClientEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function collectIterator(
  iterator: AsyncIterator<ClaudeClientEvent>,
): Promise<ClaudeClientEvent[]> {
  const events: ClaudeClientEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return events;
    events.push(next.value);
  }
}

async function* sdkMessages(messages: unknown[]): AsyncGenerator<SDKMessage> {
  for (const message of messages) {
    yield message as SDKMessage;
  }
}

function makeQuery(generator: AsyncGenerator<SDKMessage>): ClaudeSdkQuery {
  return Object.assign(generator, {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  }) as unknown as ClaudeSdkQuery;
}

function sdkSystemInit(sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
  } as unknown as SDKMessage;
}

function sdkSuccessResult(sessionId: string, result: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: sessionId,
    usage: { input_tokens: 1, output_tokens: 1 },
    total_cost_usd: 0.01,
    stop_reason: "end_turn",
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage;
}

function messageText(message: SDKUserMessage): string {
  return typeof message.message.content === "string" ? message.message.content : "";
}
