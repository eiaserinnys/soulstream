import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type PermissionResult,
  type Query as ClaudeSdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      systemPrompt: ["system", SYSTEM_PROMPT_DYNAMIC_BOUNDARY],
      resume: "resume-1",
      pathToClaudeCodeExecutable: "/opt/claude",
    });
    expect(captured[0]?.options?.canUseTool).toEqual(expect.any(Function));
    expect(captured[0]?.options?.hooks).toMatchObject({
      PreToolUse: [{ matcher: "Agent", hooks: [expect.any(Function)] }],
      PreCompact: [{ hooks: [expect.any(Function)] }],
      SubagentStart: [{ hooks: [expect.any(Function)] }],
      SubagentStop: [{ hooks: [expect.any(Function)] }],
      Notification: [{ hooks: [expect.any(Function)] }],
      Stop: [{ hooks: [expect.any(Function)] }],
    });
    expect(events.map((event) => event.type)).toEqual([
      "session",
      "text",
      "thinking",
      "tool_start",
      "tool_result",
      "prompt_suggestion",
      "result",
      "context_usage",
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
      type: "context_usage",
      usedTokens: 2,
      maxTokens: 200000,
      percent: 0,
    });
    expect(events[8]).toMatchObject({
      type: "complete",
      result: "done",
      claudeSessionId: "claude-sess-1",
    });
  });

  it("context_usage includes cached input tokens because they still occupy the request context", async () => {
    const queryFn: ClaudeSdkQueryFn = () => makeQuery(
      sdkMessages([
        sdkSuccessResult("claude-sess-1", "done", {
          usage: {
            input_tokens: 6,
            output_tokens: 2,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
          },
        }),
      ]),
    );
    const client = new ClaudeSdkClient({ query: queryFn }, silentLogger);

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

    expect(events.find((event) => event.type === "context_usage")).toMatchObject({
      type: "context_usage",
      usedTokens: 38,
    });
  });

  it("initial image attachments are embedded as Claude image content blocks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-image-"));
    try {
      const imagePath = join(dir, "sample.png");
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      writeFileSync(imagePath, bytes);
      const captured: ClaudeSdkQueryParams[] = [];
      const client = new ClaudeSdkClient(
        {
          query: (params) => {
            captured.push(params);
            return makeQuery(sdkMessages([sdkSuccessResult("claude-sess-img", "done")]));
          },
        },
        silentLogger,
      );

      await collect(
        client.run(
          {
            prompt: "이미지 설명해줘",
            workspaceDir: "/tmp/claude-work",
            env: {},
            imageAttachmentPaths: [imagePath],
          },
          new AbortController().signal,
        ),
      );

      const prompt = captured[0]?.prompt as AsyncIterable<SDKUserMessage>;
      const first = await prompt[Symbol.asyncIterator]().next();
      expect(first.value.message.content).toEqual([
        { type: "text", text: "이미지 설명해줘" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: bytes.toString("base64"),
          },
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("loads workspace mcp_config.json unless useMcp is false", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "claude-mcp-"));
    try {
      writeFileSync(
        join(workspaceDir, "mcp_config.json"),
        JSON.stringify({
          mcpServers: {
            soulstream: { type: "sse", url: "http://localhost:3105/cogito-mcp/sse" },
          },
        }),
      );

      const captured: ClaudeSdkQueryParams[] = [];
      const client = new ClaudeSdkClient(
        {
          query: (params) => {
            captured.push(params);
            return makeQuery(sdkMessages([sdkSuccessResult("claude-sess-mcp", "done")]));
          },
          postResultDrainMs: 10,
        },
        silentLogger,
      );

      await collect(client.run({ prompt: "hi", workspaceDir, env: {} }, new AbortController().signal));
      await collect(
        client.run(
          { prompt: "hi", workspaceDir, env: {}, useMcp: false },
          new AbortController().signal,
        ),
      );

      expect(captured[0]?.options?.mcpServers).toEqual({
        soulstream: { type: "sse", url: "http://localhost:3105/cogito-mcp/sse" },
      });
      expect(captured[1]?.options).not.toHaveProperty("mcpServers");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("maps SDK task_progress and hook_progress system messages to progress events", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "system",
                subtype: "task_progress",
                task_id: "task-1",
                description: "Analyzing files",
                usage: { total_tokens: 10, tool_uses: 1, duration_ms: 1000 },
                session_id: "claude-sess-progress",
              } as unknown as SDKMessage,
              {
                type: "system",
                subtype: "hook_progress",
                hook_id: "hook-1",
                hook_name: "Stop",
                hook_event: "Stop",
                stdout: "hook stdout",
                stderr: "",
                output: "hook output",
                uuid: "hook-progress-1",
                session_id: "claude-sess-progress",
              } as unknown as SDKMessage,
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

    expect(events).toEqual([
      { type: "progress", text: "Analyzing files" },
      { type: "progress", text: "hook output" },
    ]);
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

    expect(events.map((event) => event.type)).toEqual(["result", "context_usage", "complete"]);
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
    expect(remaining.map((event) => event.type)).toEqual(["result", "context_usage", "complete"]);
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

  it("PreToolUse Agent hook removes run_in_background before Claude sees the tool input", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          captured.push(params);
          return makeQuery(sdkMessages([sdkSuccessResult("claude-sess-hooks", "done")]));
        },
      },
      silentLogger,
    );

    await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    const hook = captured[0]?.options?.hooks?.PreToolUse?.[0]?.hooks[0];
    expect(hook).toEqual(expect.any(Function));
    const result = await hook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_input: { prompt: "review", run_in_background: true },
        tool_use_id: "toolu_agent",
      } as any,
      "toolu_agent",
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { prompt: "review" },
      },
    });
  });

  it("Notification hook emits Python DebugEvent-compatible client event", async () => {
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const hook = params.options?.hooks?.Notification?.[0]?.hooks[0];
              await hook?.(
                {
                  hook_event_name: "Notification",
                  title: "Input needed",
                  message: "Approve tool use",
                  notification_type: "permission",
                } as any,
                undefined,
                { signal: new AbortController().signal },
              );
              yield sdkSuccessResult("claude-sess-notify-hook", "done");
            })(),
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

    expect(events[0]).toEqual({
      type: "debug",
      message: "[permission] Input needed: Approve tool use",
    });
  });

  it("PreCompact hook and SDK compact_boundary are deduped into one compact event", async () => {
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const hook = params.options?.hooks?.PreCompact?.[0]?.hooks[0];
              await hook?.(
                {
                  hook_event_name: "PreCompact",
                  trigger: "auto",
                  custom_instructions: null,
                } as any,
                undefined,
                { signal: new AbortController().signal },
              );
              yield {
                type: "system",
                subtype: "compact_boundary",
                compact_metadata: { trigger: "auto", pre_tokens: 199000 },
                uuid: "compact-boundary-from-sdk",
                session_id: "claude-sess-precompact",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-precompact", "done");
            })(),
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

    expect(events.filter((event) => event.type === "compact")).toEqual([
      {
        type: "compact",
        trigger: "auto",
        message: "Claude session compacted (auto)",
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

  it("injects running intervention image attachments as content blocks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-intervention-image-"));
    try {
      const imagePath = join(dir, "sample.webp");
      const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46]);
      writeFileSync(imagePath, bytes);
      const contents: Array<SDKUserMessage["message"]["content"]> = [];
      const client = new ClaudeSdkClient(
        {
          query: (params) =>
            makeQuery(
              (async function* () {
                const input = params.prompt as AsyncIterable<SDKUserMessage>;
                const iterator = input[Symbol.asyncIterator]();
                const initial = await iterator.next();
                contents.push(initial.value.message.content);
                const injected = await iterator.next();
                contents.push(injected.value.message.content);
                yield sdkSuccessResult("claude-sess-img-in", "done");
              })(),
            ),
          interventionPollIntervalMs: 1,
        },
        silentLogger,
      );

      await collect(
        client.run(
          {
            prompt: "first",
            workspaceDir: "/tmp/claude-work",
            env: {},
            onIntervention: vi.fn()
              .mockResolvedValueOnce({
                prompt: "이미지 추가",
                imageAttachmentPaths: [imagePath],
              })
              .mockResolvedValue(null),
          },
          new AbortController().signal,
        ),
      );

      expect(contents[0]).toBe("first");
      expect(contents[1]).toEqual([
        { type: "text", text: "이미지 추가" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/webp",
            data: bytes.toString("base64"),
          },
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      "context_usage",
      "complete",
      "prompt_suggestion",
    ]);
    expect(events[4]).toEqual({
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

    expect(events.map((event) => event.type)).toEqual(["result", "context_usage", "complete"]);
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
    expect(events.map((event) => event.type)).toEqual(["result", "context_usage", "complete"]);
  });

  it("post-result drain treats compact_boundary after an empty result as compact retry", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              yield sdkSuccessResult("claude-sess-compact-retry", "");
              yield {
                type: "system",
                subtype: "compact_boundary",
                compact_metadata: { trigger: "auto", pre_tokens: 199000 },
                uuid: "compact-boundary-1",
                session_id: "claude-sess-compact-retry",
              } as unknown as SDKMessage;
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: "after compact" }] },
                parent_tool_use_id: null,
                uuid: "assistant-after-compact",
                session_id: "claude-sess-compact-retry",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-compact-retry", "final");
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
      "compact",
      "text",
      "result",
      "context_usage",
      "complete",
    ]);
    expect(events[0]).toMatchObject({
      type: "compact",
      trigger: "auto",
      message: "Claude session compacted (auto)",
    });
    expect(events[1]).toMatchObject({ type: "text", text: "after compact" });
    expect(events[2]).toMatchObject({ type: "result", output: "final" });
  });

  it("continues after an empty tool_use result when the SDK emits another message", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              yield sdkSuccessResult("claude-sess-tool-use", "", { stop_reason: "tool_use" });
              yield sdkSystemInit("claude-sess-tool-use");
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: "after ask" }] },
                parent_tool_use_id: null,
                uuid: "assistant-after-ask",
                session_id: "claude-sess-tool-use",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-tool-use", "final");
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
      "text",
      "result",
      "context_usage",
      "complete",
    ]);
    expect(events[2]).toMatchObject({ type: "result", output: "final" });
    expect(events[4]).toMatchObject({ type: "complete", result: "final" });
  });

  it("continues after a non-empty tool_use result instead of completing the turn", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: "500 에러가 나서 재시도합니다." }] },
                parent_tool_use_id: null,
                uuid: "assistant-before-ask",
                session_id: "claude-sess-nonempty-tool-use",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-nonempty-tool-use", "500 에러가 나서 재시도합니다.", {
                stop_reason: "tool_use",
                permission_denials: ["AskUserQuestion:toolu_ask"],
              });
              yield sdkSystemInit("claude-sess-nonempty-tool-use");
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: "after ask" }] },
                parent_tool_use_id: null,
                uuid: "assistant-after-ask",
                session_id: "claude-sess-nonempty-tool-use",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-nonempty-tool-use", "final");
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
      "text",
      "session",
      "text",
      "result",
      "context_usage",
      "complete",
    ]);
    expect(events[0]).toMatchObject({ type: "text", text: "500 에러가 나서 재시도합니다." });
    expect(events[2]).toMatchObject({ type: "text", text: "after ask" });
    expect(events[3]).toMatchObject({ type: "result", output: "final" });
    expect(events[5]).toMatchObject({ type: "complete", result: "final" });
  });

  it("does not count empty tool_use continuations against compact retry limit", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              for (let i = 0; i < 3; i += 1) {
                yield sdkSuccessResult("claude-sess-tool-use-then-compact", "", {
                  stop_reason: "tool_use",
                });
                yield sdkSystemInit("claude-sess-tool-use-then-compact");
                yield {
                  type: "assistant",
                  message: { content: [{ type: "text", text: `after ask ${i + 1}` }] },
                  parent_tool_use_id: null,
                  uuid: `assistant-after-ask-${i + 1}`,
                  session_id: "claude-sess-tool-use-then-compact",
                } as unknown as SDKMessage;
              }
              yield sdkSuccessResult("claude-sess-tool-use-then-compact", "");
              yield {
                type: "system",
                subtype: "compact_boundary",
                compact_metadata: { trigger: "auto", pre_tokens: 123 },
                uuid: "compact-after-tool-use",
                session_id: "claude-sess-tool-use-then-compact",
              } as unknown as SDKMessage;
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: "after compact" }] },
                parent_tool_use_id: null,
                uuid: "assistant-after-compact-after-tool-use",
                session_id: "claude-sess-tool-use-then-compact",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-tool-use-then-compact", "final");
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
      "text",
      "session",
      "text",
      "session",
      "text",
      "compact",
      "text",
      "result",
      "context_usage",
      "complete",
    ]);
    expect(events[6]).toMatchObject({ type: "compact", trigger: "auto" });
    expect(events[8]).toMatchObject({ type: "result", output: "final" });
  });

  it("does not treat an empty end_turn result as continuation without an explicit signal", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              yield sdkSuccessResult("claude-sess-empty-end", "");
              yield sdkSystemInit("claude-sess-empty-end");
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: "should be ignored" }] },
                parent_tool_use_id: null,
                uuid: "assistant-after-empty-end",
                session_id: "claude-sess-empty-end",
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

    expect(events.map((event) => event.type)).toEqual(["result", "context_usage", "complete"]);
    expect(events[0]).toMatchObject({ type: "result", output: "", stopReason: "end_turn" });
  });

  it("SystemMessage subtype=notification emits debug event even without hook callback execution", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "system",
                subtype: "notification",
                key: "permission",
                text: "Approval needed",
                priority: "high",
                uuid: "notification-1",
                session_id: "claude-sess-notification",
              },
              sdkSuccessResult("claude-sess-notification", "done"),
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

    expect(events[0]).toEqual({
      type: "debug",
      message: "[high:permission] Approval needed",
    });
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

function sdkSuccessResult(
  sessionId: string,
  result: string,
  overrides: Record<string, unknown> = {},
): SDKMessage {
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
    ...overrides,
  } as unknown as SDKMessage;
}

function messageText(message: SDKUserMessage): string {
  return typeof message.message.content === "string" ? message.message.content : "";
}
