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
          sdkSuccessResult("claude-sess-1", "done"),
          {
            type: "prompt_suggestion",
            suggestion: "next?",
            uuid: "suggestion-1",
            session_id: "claude-sess-1",
          },
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
      "result",
      "prompt_suggestion",
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
    expect(events[6]).toMatchObject({
      type: "prompt_suggestion",
      text: "next?",
    });
    expect(events[7]).toMatchObject({
      type: "complete",
      result: "done",
      claudeSessionId: "claude-sess-1",
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
