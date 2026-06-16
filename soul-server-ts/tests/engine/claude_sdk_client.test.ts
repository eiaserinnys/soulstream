import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type PermissionResult,
  type Query as ClaudeSdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { ClaudeSdkClient } from "../../src/engine/claude_adapter.js";
import {
  resolveClaudeExecutableFromPath,
  type ClaudeSdkQueryFn,
  type ClaudeSdkQueryParams,
} from "../../src/engine/claude_sdk_client.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import { ClaudeSdkEventMapper } from "../../src/engine/claude_sdk_event_mapper.js";
import { ClaudeRuntimeState } from "../../src/engine/claude_sdk_runtime_state.js";

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

    const initialPrompt = captured[0]?.prompt as AsyncIterable<SDKUserMessage>;
    await expect(initialPrompt[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { type: "user", message: { role: "user", content: "hi" } },
    });
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
      SessionStart: [{ matcher: "compact", hooks: [expect.any(Function)] }],
      SubagentStart: [{ hooks: [expect.any(Function)] }],
      SubagentStop: [{ hooks: [expect.any(Function)] }],
      TaskCreated: [{ hooks: [expect.any(Function)] }],
      TaskCompleted: [{ hooks: [expect.any(Function)] }],
      Notification: [{ hooks: [expect.any(Function)] }],
      Stop: [{ hooks: [expect.any(Function)] }],
      PostToolUse: [{ hooks: [expect.any(Function)] }],
      PostToolUseFailure: [{ hooks: [expect.any(Function)] }],
      PostToolBatch: [{ hooks: [expect.any(Function)] }],
      PermissionRequest: [{ hooks: [expect.any(Function)] }],
      PermissionDenied: [{ hooks: [expect.any(Function)] }],
      WorktreeCreate: [{ hooks: [expect.any(Function)] }],
      WorktreeRemove: [{ hooks: [expect.any(Function)] }],
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
      sdkDedupeKey: "claude-sdk:assistant:assistant-1:2",
    });
    expect(events[4]).toMatchObject({
      type: "tool_result",
      toolName: "Read",
      result: "file",
      toolUseId: "toolu_1",
      sdkDedupeKey: "claude-sdk:user:user-1:0",
    });
    expect(events[5]).toMatchObject({
      type: "prompt_suggestion",
      text: "next?",
      sdkDedupeKey: "claude-sdk:prompt_suggestion:suggestion-1:0",
    });
    expect(events[1]).toMatchObject({
      type: "text",
      sdkDedupeKey: "claude-sdk:assistant:assistant-1:0",
    });
    expect(events[2]).toMatchObject({
      type: "thinking",
      sdkDedupeKey: "claude-sdk:assistant:assistant-1:1",
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

  it("dedupes uuid-less SDK messages by role and content hash", () => {
    const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState());
    const message = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "same resumed message" }],
      },
      parent_tool_use_id: null,
      session_id: "claude-sess-1",
    } as unknown as SDKMessage;

    const first = mapper.mapSdkMessage(message)[0] as ClaudeClientEvent & {
      sdkDedupeKey?: string;
    };
    const second = mapper.mapSdkMessage(message)[0] as ClaudeClientEvent & {
      sdkDedupeKey?: string;
    };

    expect(first.sdkDedupeKey).toMatch(
      /^claude-sdk:assistant:content:assistant:[a-f0-9]{32}:0$/,
    );
    expect(second.sdkDedupeKey).toBe(first.sdkDedupeKey);
  });

  it("omits SDK env options when run options omit env so the SDK can default to process.env", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    const client = new ClaudeSdkClient(
      {
        resolveClaudeExecutablePath: () => undefined,
        query: (params) => {
          captured.push(params);
          return makeQuery(sdkMessages([sdkSuccessResult("claude-sess-env", "done")]));
        },
      },
      silentLogger,
    );

    await collect(
      client.run(
        {
          prompt: "hi",
          workspaceDir: "/tmp/claude-work",
        },
        new AbortController().signal,
      ),
    );

    expect(captured[0]?.options).not.toHaveProperty("env");
    expect(captured[0]?.options).not.toHaveProperty("pathToClaudeCodeExecutable");
  });

  it("intercepts Claude schedule tools into the Soulstream durable scheduler and suppresses native denial noise", async () => {
    const permissionResults: PermissionResult[] = [];
    const scheduleHandler = vi.fn(async () => ({
      message: "Soulstream durable scheduler accepted ScheduleWakeup as sched-1.",
      data: { scheduleId: "sched-1" },
    }));
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const permission = await params.options?.canUseTool?.(
                "ScheduleWakeup",
                { delaySeconds: 60, prompt: "wake me" },
                {
                  signal: new AbortController().signal,
                  toolUseID: "toolu-schedule",
                },
              );
              if (permission) permissionResults.push(permission);
              yield {
                type: "system",
                subtype: "permission_denied",
                tool_name: "ScheduleWakeup",
                tool_use_id: "toolu-schedule",
                message: "Soulstream durable scheduler accepted ScheduleWakeup as sched-1.",
                session_id: "claude-sess-schedule",
              } as unknown as SDKMessage;
              yield {
                type: "user",
                message: {
                  role: "user",
                  content: [{
                    type: "tool_result",
                    tool_use_id: "toolu-schedule",
                    content: "permission denied",
                    is_error: true,
                  }],
                },
                uuid: "user-schedule-result",
                session_id: "claude-sess-schedule",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-schedule", "done");
            })(),
          ),
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        {
          prompt: "hi",
          workspaceDir: "/tmp/claude-work",
          env: {},
          agentSessionId: "sess-1",
          onScheduleToolUse: scheduleHandler,
        },
        new AbortController().signal,
      ),
    );

    expect(scheduleHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-1",
        toolUseId: "toolu-schedule",
        toolName: "ScheduleWakeup",
        input: { delaySeconds: 60, prompt: "wake me" },
        now: expect.any(Date),
      }),
    );
    expect(permissionResults).toEqual([
      {
        behavior: "deny",
        message: "Soulstream durable scheduler accepted ScheduleWakeup as sched-1.",
        toolUseID: "toolu-schedule",
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "result",
      "context_usage",
      "complete",
    ]);
  });

  it("passes CronList schedule details through the permission-deny message so the model can choose ids", async () => {
    const permissionResults: PermissionResult[] = [];
    const scheduleHandler = vi.fn(async () => ({
      message:
        "Soulstream durable scheduler has 1 schedule(s).\n"
        + 'id=sched-visible kind=cron status=active nextRunAt=2026-01-01T01:00:00.000Z prompt="summarize open loops"',
      data: {
        schedules: [{
          scheduleId: "sched-visible",
          nextRunAt: "2026-01-01T01:00:00.000Z",
        }],
      },
    }));
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const permission = await params.options?.canUseTool?.(
                "CronList",
                {},
                {
                  signal: new AbortController().signal,
                  toolUseID: "toolu-cron-list",
                },
              );
              if (permission) permissionResults.push(permission);
              yield sdkSuccessResult("claude-sess-cron-list", "done");
            })(),
          ),
      },
      silentLogger,
    );

    await collect(
      client.run(
        {
          prompt: "list schedules",
          workspaceDir: "/tmp/claude-work",
          env: {},
          agentSessionId: "sess-1",
          onScheduleToolUse: scheduleHandler,
        },
        new AbortController().signal,
      ),
    );

    expect(permissionResults[0]).toMatchObject({
      behavior: "deny",
      toolUseID: "toolu-cron-list",
    });
    expect(permissionResults[0]?.message).toContain("id=sched-visible");
    expect(permissionResults[0]?.message).toContain("nextRunAt=2026-01-01T01:00:00.000Z");
    expect(permissionResults[0]?.message).toContain('prompt="summarize open loops"');
  });

  it("clears intercepted schedule tool ids between runs so reused ids do not hide unrelated denials", async () => {
    let callCount = 0;
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          callCount += 1;
          if (callCount === 1) {
            return makeQuery(
              (async function* () {
                await params.options?.canUseTool?.(
                  "ScheduleWakeup",
                  { delaySeconds: 60 },
                  {
                    signal: new AbortController().signal,
                    toolUseID: "toolu-reused",
                  },
                );
                yield sdkSuccessResult("claude-sess-schedule", "done");
              })(),
            );
          }
          return makeQuery(
            sdkMessages([
              {
                type: "system",
                subtype: "permission_denied",
                tool_name: "Read",
                tool_use_id: "toolu-reused",
                message: "blocked by policy",
                session_id: "claude-sess-read",
              },
              sdkSuccessResult("claude-sess-read", "done"),
            ]),
          );
        },
      },
      silentLogger,
    );

    await collect(
      client.run(
        {
          prompt: "schedule",
          workspaceDir: "/tmp/claude-work",
          env: {},
          agentSessionId: "sess-1",
          onScheduleToolUse: async () => ({
            message: "Soulstream durable scheduler accepted ScheduleWakeup as sched-1.",
            data: { scheduleId: "sched-1" },
          }),
        },
        new AbortController().signal,
      ),
    );

    const events = await collect(
      client.run(
        {
          prompt: "read",
          workspaceDir: "/tmp/claude-work",
          env: {},
        },
        new AbortController().signal,
      ),
    );

    expect(events).toContainEqual({
      type: "error",
      fatal: false,
      errorCode: "permission_denied",
      message: "Read: blocked by policy",
    });
  });

  it("uses resolved Claude Code executable path without passing it through env", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    const client = new ClaudeSdkClient(
      {
        resolveClaudeExecutablePath: () => "/usr/local/bin/claude",
        query: (params) => {
          captured.push(params);
          return makeQuery(sdkMessages([sdkSuccessResult("claude-sess-path", "done")]));
        },
      },
      silentLogger,
    );

    await collect(
      client.run(
        {
          prompt: "hi",
          workspaceDir: "/tmp/claude-work",
        },
        new AbortController().signal,
      ),
    );

    expect(captured[0]?.options).not.toHaveProperty("env");
    expect(captured[0]?.options?.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
  });

  it("resolves only native Claude Code exe candidates on Windows PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-windows-path-"));
    try {
      const shimDir = join(dir, "npm");
      const nativeDir = join(dir, "local-bin");
      mkdirSync(shimDir, { recursive: true });
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(shimDir, "claude"), "", { mode: 0o755 });
      writeFileSync(join(shimDir, "claude.cmd"), "", { mode: 0o755 });
      writeFileSync(join(shimDir, "claude.ps1"), "", { mode: 0o755 });
      writeFileSync(join(nativeDir, "claude.exe"), "", { mode: 0o755 });

      expect(
        resolveClaudeExecutableFromPath(
          {
            PATH: [shimDir, nativeDir].join(delimiter),
            PATHEXT: ".COM;.EXE;.CMD;.PS1",
          },
          "win32",
        ),
      ).toBe(join(nativeDir, "claude.exe"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps non-Windows Claude Code PATH resolution unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-posix-path-"));
    try {
      const binDir = join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "claude"), "", { mode: 0o755 });

      expect(
        resolveClaudeExecutableFromPath({ PATH: binDir }, "linux"),
      ).toBe(join(binDir, "claude"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("keeps bypassPermissions as the default and forwards opt-in permission mode", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          captured.push(params);
          return makeQuery(sdkMessages([sdkSuccessResult("claude-sess-perm", "done")]));
        },
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    await collect(client.run({ prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} }, new AbortController().signal));
    await collect(
      client.run(
        {
          prompt: "hi",
          workspaceDir: "/tmp/claude-work",
          env: {},
          claudePermissionMode: "default",
        },
        new AbortController().signal,
      ),
    );

    expect(captured[0]?.options).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    expect(captured[1]?.options).toMatchObject({ permissionMode: "default" });
    expect(captured[1]?.options).not.toHaveProperty("allowDangerouslySkipPermissions");
  });

  it("forwards the DB-backed SessionStore mirror options to the Claude SDK", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    const sessionStore = {
      append: vi.fn(async () => undefined),
      load: vi.fn(async () => null),
      listSubkeys: vi.fn(async () => []),
    };
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          captured.push(params);
          return makeQuery(sdkMessages([sdkSuccessResult("claude-sess-store", "done")]));
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
          sessionStore,
          sessionStoreFlush: "batched",
          loadTimeoutMs: 60000,
        },
        new AbortController().signal,
      ),
    );

    expect(captured[0]?.options).toMatchObject({
      sessionStore,
      sessionStoreFlush: "batched",
      loadTimeoutMs: 60000,
    });
  });

  it("captures PushNotification and RemoteTrigger tools as Soulstream runtime events without invoking external push infra", async () => {
    const permissionResults: PermissionResult[] = [];
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const push = await params.options?.canUseTool?.(
                "PushNotification",
                { title: "Heads up", message: "review is waiting", priority: "high" },
                {
                  signal: new AbortController().signal,
                  toolUseID: "toolu-push",
                },
              );
              if (push) permissionResults.push(push);
              const remote = await params.options?.canUseTool?.(
                "RemoteTrigger",
                { trigger: "intervention", prompt: "continue now" },
                {
                  signal: new AbortController().signal,
                  toolUseID: "toolu-remote",
                },
              );
              if (remote) permissionResults.push(remote);
              yield {
                type: "system",
                subtype: "permission_denied",
                tool_name: "PushNotification",
                tool_use_id: "toolu-push",
                message:
                  "Soulstream in-app notification captured. External APNs/Expo push is not configured for this runtime.",
                session_id: "claude-sess-remote-tools",
              } as unknown as SDKMessage;
              yield {
                type: "system",
                subtype: "permission_denied",
                tool_name: "RemoteTrigger",
                tool_use_id: "toolu-remote",
                message:
                  "Soulstream intervention/capability routing is already the remote trigger path for this session.",
                session_id: "claude-sess-remote-tools",
              } as unknown as SDKMessage;
              yield {
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "toolu-push",
                      content: "permission denied",
                      is_error: true,
                    },
                    {
                      type: "tool_result",
                      tool_use_id: "toolu-remote",
                      content: "permission denied",
                      is_error: true,
                    },
                  ],
                },
                uuid: "user-runtime-tool-result",
                session_id: "claude-sess-remote-tools",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-remote-tools", "done");
            })(),
          ),
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(permissionResults).toEqual([
      expect.objectContaining({
        behavior: "deny",
        toolUseID: "toolu-push",
        message: expect.stringContaining("Soulstream in-app notification"),
      }),
      expect.objectContaining({
        behavior: "deny",
        toolUseID: "toolu-remote",
        message: expect.stringContaining("Soulstream intervention"),
      }),
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "claude_runtime_notification",
          notificationId: "toolu-push",
          source: "tool_use",
          toolUseId: "toolu-push",
          title: "Heads up",
          message: "review is waiting",
          priority: "high",
        }),
        expect.objectContaining({
          type: "claude_runtime_remote_trigger",
          triggerId: "toolu-remote",
          source: "tool_use",
          toolUseId: "toolu-remote",
          triggerType: "intervention",
          prompt: "continue now",
          payload: { trigger: "intervention", prompt: "continue now" },
        }),
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", errorCode: "permission_denied" }),
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_result", toolUseId: "toolu-push" }),
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_result", toolUseId: "toolu-remote" }),
      ]),
    );
  });

  it("maps SDK notification, remote-origin user message, and mirror_error into runtime events", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "system",
                subtype: "notification",
                text: "permission prompt waiting",
                key: "permission",
                priority: "high",
                uuid: "notif-1",
                session_id: "claude-sess-p2",
              },
              {
                type: "user",
                message: {
                  role: "user",
                  content: "continue from phone",
                },
                origin: {
                  kind: "peer",
                  from: "ios-device",
                  name: "iPhone",
                },
                priority: "now",
                uuid: "remote-user-1",
                session_id: "claude-sess-p2",
              },
              {
                type: "system",
                subtype: "mirror_error",
                error: "db unavailable",
                key: {
                  projectKey: "project-a",
                  sessionId: "claude-sess-p2",
                  subpath: "subagents/agent-a",
                },
                uuid: "mirror-1",
                session_id: "claude-sess-p2",
              },
              sdkSuccessResult("claude-sess-p2", "done"),
            ]),
          ),
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "claude_runtime_notification",
          notificationId: "notif-1",
          source: "system",
          message: "permission prompt waiting",
          key: "permission",
          priority: "high",
          sessionId: "claude-sess-p2",
        }),
        expect.objectContaining({
          type: "claude_runtime_remote_trigger",
          triggerId: "remote-user-1",
          source: "message_origin",
          originKind: "peer",
          originFrom: "ios-device",
          originName: "iPhone",
          priority: "now",
          prompt: "continue from phone",
          sessionId: "claude-sess-p2",
        }),
        expect.objectContaining({
          type: "claude_runtime_transcript_mirror_error",
          mirrorId: "mirror-1",
          sessionId: "claude-sess-p2",
          projectKey: "project-a",
          transcriptSessionId: "claude-sess-p2",
          subpath: "subagents/agent-a",
          error: "db unavailable",
        }),
      ]),
    );
  });

  it("preserves generic SDK hooks and updates worktree mode from worktree hooks", async () => {
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const hooks = params.options.hooks!;
              await hooks.PostToolUse?.[0]?.hooks[0]?.({
                hook_event_name: "PostToolUse",
                session_id: "claude-sess-hooks",
                tool_name: "Read",
                tool_use_id: "toolu-read",
                tool_input: { file_path: "a.ts" },
                tool_response: "large file contents",
                tool_calls: [
                  {
                    tool_name: "Read",
                    tool_response: "nested large file contents",
                  },
                ],
              } as never, "toolu-read", { signal: new AbortController().signal });
              await hooks.PermissionRequest?.[0]?.hooks[0]?.({
                hook_event_name: "PermissionRequest",
                tool_name: "Bash",
                tool_input: { command: "date" },
              } as never, undefined, { signal: new AbortController().signal });
              await hooks.PermissionDenied?.[0]?.hooks[0]?.({
                hook_event_name: "PermissionDenied",
                tool_name: "Bash",
                tool_use_id: "toolu-denied",
                tool_input: { command: "rm -rf /tmp/x" },
                reason: "policy",
              } as never, "toolu-denied", { signal: new AbortController().signal });
              await hooks.WorktreeCreate?.[0]?.hooks[0]?.({
                hook_event_name: "WorktreeCreate",
                session_id: "claude-sess-hooks",
                name: "feature-x",
              } as never, undefined, { signal: new AbortController().signal });
              await hooks.WorktreeRemove?.[0]?.hooks[0]?.({
                hook_event_name: "WorktreeRemove",
                session_id: "claude-sess-hooks",
                worktree_path: "/tmp/worktrees/feature-x",
              } as never, undefined, { signal: new AbortController().signal });
              yield sdkSuccessResult("claude-sess-hooks", "done");
            })(),
          ),
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "claude_runtime_hook_event",
          hookEventName: "PostToolUse",
          sessionId: "claude-sess-hooks",
          toolName: "Read",
          toolUseId: "toolu-read",
        }),
        expect.objectContaining({
          type: "claude_runtime_hook_event",
          hookEventName: "PermissionRequest",
          toolName: "Bash",
        }),
        expect.objectContaining({
          type: "claude_runtime_mode_state",
          mode: "worktree",
          active: true,
          source: "hook",
          worktreeName: "feature-x",
        }),
        expect.objectContaining({
          type: "claude_runtime_mode_state",
          mode: "worktree",
          active: false,
          source: "hook",
          worktreePath: "/tmp/worktrees/feature-x",
        }),
      ]),
    );
    const postToolUseEvent = events.find(
      (event) =>
        event.type === "claude_runtime_hook_event" &&
        event.hookEventName === "PostToolUse",
    );
    expect(postToolUseEvent).toMatchObject({
      hookInput: {
        tool_input: { file_path: "a.ts" },
        tool_response: "[stripped: persisted in tool_result]",
        tool_calls: [
          {
            tool_name: "Read",
            tool_response: "[stripped: persisted in tool_result]",
          },
        ],
      },
    });
  });

  it("updates plan and worktree mode from assistant tool_use events", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "assistant",
                message: {
                  content: [
                    { type: "tool_use", id: "toolu-plan-enter", name: "EnterPlanMode", input: {} },
                    {
                      type: "tool_use",
                      id: "toolu-wt-enter",
                      name: "EnterWorktree",
                      input: { name: "feature-x" },
                    },
                    {
                      type: "tool_use",
                      id: "toolu-wt-exit",
                      name: "ExitWorktree",
                      input: { action: "keep" },
                    },
                    { type: "tool_use", id: "toolu-plan-exit", name: "ExitPlanMode", input: {} },
                  ],
                },
                parent_tool_use_id: null,
                uuid: "assistant-mode",
                session_id: "claude-sess-mode",
              },
              sdkSuccessResult("claude-sess-mode", "done"),
            ]),
          ),
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "claude_runtime_mode_state",
          mode: "plan",
          active: true,
          source: "tool_use",
          toolUseId: "toolu-plan-enter",
        }),
        expect.objectContaining({
          type: "claude_runtime_mode_state",
          mode: "worktree",
          active: true,
          source: "tool_use",
          toolUseId: "toolu-wt-enter",
          worktreeName: "feature-x",
        }),
        expect.objectContaining({
          type: "claude_runtime_mode_state",
          mode: "worktree",
          active: false,
          source: "tool_use",
          toolUseId: "toolu-wt-exit",
          worktreeAction: "keep",
        }),
        expect.objectContaining({
          type: "claude_runtime_mode_state",
          mode: "plan",
          active: false,
          source: "tool_use",
          toolUseId: "toolu-plan-exit",
        }),
      ]),
    );
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

  it("loads workspace .mcp.json and adds current agent session id header to soulstream MCP servers only", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "claude-mcp-json-session-"));
    try {
      writeFileSync(
        join(workspaceDir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            soulstream: {
              type: "http",
              url: "http://127.0.0.1:3105/mcp",
            },
            atom: {
              type: "http",
              url: "http://localhost:4200/mcp",
            },
            trello: {
              type: "sse",
              url: "http://localhost:8001/sse",
            },
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

      await collect(client.run({
        prompt: "hi",
        workspaceDir,
        env: {},
        agentSessionId: "parent-sess-1",
      }, new AbortController().signal));

      const mcpServers = captured[0]?.options?.mcpServers as Record<string, {
        type: string;
        headers?: Record<string, string>;
      }>;
      expect(mcpServers.soulstream?.headers).toEqual({
        "x-soulstream-agent-session-id": "parent-sess-1",
      });
      expect(mcpServers.atom?.headers).toBeUndefined();
      expect(mcpServers.trello?.headers).toBeUndefined();
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("adds current agent session id header to legacy soulstream HTTP MCP servers", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "claude-mcp-session-"));
    try {
      writeFileSync(
        join(workspaceDir, "mcp_config.json"),
        JSON.stringify({
          mcpServers: {
            soulstream: {
              type: "sse",
              url: "http://localhost:3105/cogito-mcp/sse",
              headers: {
                authorization: "Bearer secret",
                "x-soulstream-agent-session-id": "stale-session",
              },
            },
            "soulstream-cogito": {
              type: "streamable_http",
              url: "http://localhost:3105/mcp",
              headers: {
                "x-other": "kept",
              },
            },
            localStdio: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
            externalHttp: {
              type: "http",
              url: "https://example.invalid/mcp",
            },
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

      await collect(client.run({
        prompt: "hi",
        workspaceDir,
        env: {},
        agentSessionId: "parent-sess-1",
      }, new AbortController().signal));

      const mcpServers = captured[0]?.options?.mcpServers as Record<string, {
        type: string;
        headers?: Record<string, string>;
      }>;
      expect(mcpServers.soulstream?.headers).toEqual({
        authorization: "Bearer secret",
        "x-soulstream-agent-session-id": "parent-sess-1",
      });
      expect(mcpServers["soulstream-cogito"]?.headers).toEqual({
        "x-other": "kept",
        "x-soulstream-agent-session-id": "parent-sess-1",
      });
      expect(mcpServers.localStdio?.headers).toBeUndefined();
      expect(mcpServers.externalHttp?.headers).toBeUndefined();
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
      {
        type: "claude_runtime_task_progress",
        taskId: "task-1",
        sessionId: "claude-sess-progress",
        description: "Analyzing files",
        usage: { total_tokens: 10, tool_uses: 1, duration_ms: 1000 },
      },
      { type: "progress", text: "hook output" },
      {
        type: "error",
        fatal: true,
        errorCode: "claude_runtime_ended_before_idle",
        message: "Claude SDK stream ended while runtime work was still pending.",
      },
    ]);
  });

  it("omits SDK model and executable options when caller does not provide them", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    const client = new ClaudeSdkClient(
      {
        resolveClaudeExecutablePath: () => undefined,
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

  it("installs a non-mutating Agent PreToolUse hook that records run_in_background intent", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    let hookResult: unknown;
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          captured.push(params);
          return makeQuery(
            (async function* () {
              const hook = params.options?.hooks?.PreToolUse?.[0]?.hooks[0];
              hookResult = await hook?.(
                {
                  hook_event_name: "PreToolUse",
                  tool_name: "Agent",
                  tool_use_id: "toolu-agent-pretool",
                  tool_input: {
                    prompt: "review",
                    run_in_background: true,
                  },
                  session_id: "claude-sess-hooks",
                  transcript_path: "/tmp/transcript.jsonl",
                  cwd: "/tmp/claude-work",
                } as any,
                "pretool-agent-bg",
                { signal: new AbortController().signal },
              );
              yield sdkSuccessResult("claude-sess-hooks", "done");
            })(),
          );
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

    expect(captured[0]?.options?.hooks?.PreToolUse).toMatchObject([
      { matcher: "Agent", hooks: [expect.any(Function)] },
    ]);
    expect(hookResult).toEqual({});
  });

  it("marks background Agent tasks without emitting foreground subagent events", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "assistant",
                message: {
                  content: [
                    {
                      type: "tool_use",
                      id: "toolu-agent-bg",
                      name: "Agent",
                      input: {
                        prompt: "review the diff",
                        description: "Review diff",
                        run_in_background: true,
                      },
                    },
                  ],
                },
                parent_tool_use_id: null,
                uuid: "assistant-agent-bg",
                session_id: "claude-sess-agent-bg",
              },
              {
                type: "system",
                subtype: "task_started",
                task_id: "agent-task-1",
                tool_use_id: "toolu-agent-bg",
                description: "Review diff",
                session_id: "claude-sess-agent-bg",
              },
              {
                type: "system",
                subtype: "task_notification",
                task_id: "agent-task-1",
                tool_use_id: "toolu-agent-bg",
                status: "completed",
                output_file: "/tmp/agent-task-1.out",
                summary: "review complete",
                session_id: "claude-sess-agent-bg",
              },
              sdkSuccessResult("claude-sess-agent-bg", "done"),
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

    expect(events.map((event) => event.type)).not.toContain("subagent_start");
    expect(events.map((event) => event.type)).not.toContain("subagent_stop");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_start",
          toolName: "Agent",
          toolInput: expect.objectContaining({ run_in_background: true }),
          toolUseId: "toolu-agent-bg",
        }),
        expect.objectContaining({
          type: "claude_runtime_task_started",
          taskId: "agent-task-1",
          toolUseId: "toolu-agent-bg",
          taskType: "agent",
        }),
        expect.objectContaining({
          type: "claude_runtime_task_updated",
          taskId: "agent-task-1",
          patch: expect.objectContaining({
            status: "running",
            is_backgrounded: true,
            task_type: "agent",
            tool_use_id: "toolu-agent-bg",
          }),
        }),
      ]),
    );
  });

  it("emits Claude SDK TaskCreated and TaskCompleted hook lifecycle events", async () => {
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const createdHook = params.options?.hooks?.TaskCreated?.[0]?.hooks[0];
              const completedHook = params.options?.hooks?.TaskCompleted?.[0]?.hooks[0];
              await createdHook?.(
                {
                  hook_event_name: "TaskCreated",
                  task_id: "sdk-task-1",
                  task_subject: "Investigate queue",
                  task_description: "Check pending queue",
                  teammate_name: "analyst",
                  team_name: "runtime",
                  session_id: "claude-sess-task-hook",
                } as any,
                "task-hook-created",
                { signal: new AbortController().signal },
              );
              await completedHook?.(
                {
                  hook_event_name: "TaskCompleted",
                  task_id: "sdk-task-1",
                  task_subject: "Investigate queue",
                  task_description: "Check pending queue",
                  teammate_name: "analyst",
                  team_name: "runtime",
                  session_id: "claude-sess-task-hook",
                } as any,
                "task-hook-completed",
                { signal: new AbortController().signal },
              );
              yield sdkSuccessResult("claude-sess-task-hook", "done");
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

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "claude_runtime_task_created",
          taskId: "sdk-task-1",
          subject: "Investigate queue",
          description: "Check pending queue",
          teammateName: "analyst",
          teamName: "runtime",
        }),
        expect.objectContaining({
          type: "claude_runtime_task_completed",
          taskId: "sdk-task-1",
          subject: "Investigate queue",
          description: "Check pending queue",
          teammateName: "analyst",
          teamName: "runtime",
        }),
      ]),
    );
  });

  it("keeps post-result drain open until delayed SDK TaskCompleted hook settles TaskCreated", async () => {
    let queryRef: ClaudeSdkQuery | undefined;
    const resultDraining = deferred<void>();
    const allowTaskComplete = deferred<void>();
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          queryRef = makeQuery(
            (async function* () {
              const createdHook = params.options?.hooks?.TaskCreated?.[0]?.hooks[0];
              const completedHook = params.options?.hooks?.TaskCompleted?.[0]?.hooks[0];
              await createdHook?.(
                {
                  hook_event_name: "TaskCreated",
                  task_id: "sdk-task-delayed",
                  task_subject: "Delayed task",
                  session_id: "claude-sess-task-delayed",
                } as any,
                "task-hook-created",
                { signal: new AbortController().signal },
              );
              yield sdkSuccessResult("claude-sess-task-delayed", "done");
              resultDraining.resolve();
              await allowTaskComplete.promise;
              await completedHook?.(
                {
                  hook_event_name: "TaskCompleted",
                  task_id: "sdk-task-delayed",
                  task_subject: "Delayed task",
                  session_id: "claude-sess-task-delayed",
                } as any,
                "task-hook-completed",
                { signal: new AbortController().signal },
              );
            })(),
          );
          return queryRef;
        },
        postResultDrainMs: 5,
        runtimeDrainMaxMs: 250,
      },
      silentLogger,
    );

    const eventsPromise = collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    await resultDraining.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(queryRef?.close).not.toHaveBeenCalled();

    allowTaskComplete.resolve();
    const events = await eventsPromise;
    expect(events.map((event) => event.type)).toEqual([
      "claude_runtime_task_created",
      "claude_runtime_task_completed",
      "result",
      "context_usage",
      "complete",
    ]);
    expect(queryRef?.close).toHaveBeenCalledTimes(1);
  });

  it("suppresses SDK SubagentStart and SubagentStop hooks for run_in_background Agent tasks", async () => {
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const startHook = params.options?.hooks?.SubagentStart?.[0]?.hooks[0];
              const stopHook = params.options?.hooks?.SubagentStop?.[0]?.hooks[0];
              yield {
                type: "assistant",
                message: {
                  content: [
                    {
                      type: "tool_use",
                      id: "toolu-agent-hook-bg",
                      name: "Agent",
                      input: {
                        prompt: "review the diff",
                        description: "Review diff",
                        run_in_background: true,
                      },
                    },
                  ],
                },
                parent_tool_use_id: null,
                uuid: "assistant-agent-hook-bg",
                session_id: "claude-sess-agent-hook-bg",
              } as unknown as SDKMessage;
              yield {
                type: "system",
                subtype: "task_started",
                task_id: "agent-task-hook-bg",
                tool_use_id: "toolu-agent-hook-bg",
                description: "Review diff",
                session_id: "claude-sess-agent-hook-bg",
              } as unknown as SDKMessage;
              await startHook?.(
                {
                  hook_event_name: "SubagentStart",
                  agent_id: "agent-task-hook-bg",
                  agent_type: "agent",
                } as any,
                "subagent-start-bg",
                { signal: new AbortController().signal },
              );
              yield sdkSuccessResult("claude-sess-agent-hook-bg", "done");
              await stopHook?.(
                {
                  hook_event_name: "SubagentStop",
                  stop_hook_active: false,
                  agent_id: "agent-task-hook-bg",
                  agent_transcript_path: "/tmp/agent-task-hook-bg.jsonl",
                  agent_type: "agent",
                } as any,
                "subagent-stop-bg",
                { signal: new AbortController().signal },
              );
              yield {
                type: "system",
                subtype: "task_notification",
                task_id: "agent-task-hook-bg",
                tool_use_id: "toolu-agent-hook-bg",
                status: "completed",
                output_file: "/tmp/agent-task-hook-bg.out",
                summary: "review complete",
                session_id: "claude-sess-agent-hook-bg",
              } as unknown as SDKMessage;
            })(),
          ),
        postResultDrainMs: 5,
        runtimeDrainMaxMs: 200,
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
      "tool_start",
      "claude_runtime_task_started",
      "claude_runtime_task_updated",
      "claude_runtime_task_notification",
      "result",
      "context_usage",
      "complete",
    ]);
    expect(events.map((event) => event.type)).not.toContain("subagent_start");
    expect(events.map((event) => event.type)).not.toContain("subagent_stop");
    expect(events[2]).toMatchObject({
      type: "claude_runtime_task_updated",
      taskId: "agent-task-hook-bg",
      patch: expect.objectContaining({ is_backgrounded: true }),
    });
  });

  it("suppresses background Agent subagent hooks even when SubagentStart arrives before task_started", async () => {
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const preToolHook = params.options?.hooks?.PreToolUse?.[0]?.hooks[0];
              const startHook = params.options?.hooks?.SubagentStart?.[0]?.hooks[0];
              const stopHook = params.options?.hooks?.SubagentStop?.[0]?.hooks[0];
              await preToolHook?.(
                {
                  hook_event_name: "PreToolUse",
                  tool_name: "Agent",
                  tool_use_id: "toolu-agent-reverse-bg",
                  tool_input: {
                    prompt: "review the diff",
                    description: "Review diff",
                    run_in_background: true,
                  },
                  session_id: "claude-sess-agent-reverse-bg",
                  transcript_path: "/tmp/transcript.jsonl",
                  cwd: "/tmp/claude-work",
                } as any,
                "pretool-agent-reverse-bg",
                { signal: new AbortController().signal },
              );
              await startHook?.(
                {
                  hook_event_name: "SubagentStart",
                  agent_id: "toolu-agent-reverse-bg",
                  agent_type: "agent",
                } as any,
                "subagent-start-reverse-bg",
                { signal: new AbortController().signal },
              );
              yield {
                type: "assistant",
                message: {
                  content: [
                    {
                      type: "tool_use",
                      id: "toolu-agent-reverse-bg",
                      name: "Agent",
                      input: {
                        prompt: "review the diff",
                        description: "Review diff",
                        run_in_background: true,
                      },
                    },
                  ],
                },
                parent_tool_use_id: null,
                uuid: "assistant-agent-reverse-bg",
                session_id: "claude-sess-agent-reverse-bg",
              } as unknown as SDKMessage;
              yield {
                type: "system",
                subtype: "task_started",
                task_id: "agent-task-reverse-bg",
                tool_use_id: "toolu-agent-reverse-bg",
                description: "Review diff",
                session_id: "claude-sess-agent-reverse-bg",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-agent-reverse-bg", "done");
              await stopHook?.(
                {
                  hook_event_name: "SubagentStop",
                  stop_hook_active: false,
                  agent_id: "toolu-agent-reverse-bg",
                  agent_transcript_path: "/tmp/agent-task-reverse-bg.jsonl",
                  agent_type: "agent",
                } as any,
                "subagent-stop-reverse-bg",
                { signal: new AbortController().signal },
              );
              yield {
                type: "system",
                subtype: "task_notification",
                task_id: "agent-task-reverse-bg",
                tool_use_id: "toolu-agent-reverse-bg",
                status: "completed",
                output_file: "/tmp/agent-task-reverse-bg.out",
                summary: "review complete",
                session_id: "claude-sess-agent-reverse-bg",
              } as unknown as SDKMessage;
            })(),
          ),
        postResultDrainMs: 5,
        runtimeDrainMaxMs: 200,
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
      "tool_start",
      "claude_runtime_task_started",
      "claude_runtime_task_updated",
      "claude_runtime_task_notification",
      "result",
      "context_usage",
      "complete",
    ]);
    expect(events.map((event) => event.type)).not.toContain("subagent_start");
    expect(events.map((event) => event.type)).not.toContain("subagent_stop");
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

  it("SessionStart compact hook adds model-visible system context before the same SDK continuation answers", async () => {
    const hookOutputs: unknown[] = [];
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const hook = params.options?.hooks?.SessionStart?.[0]?.hooks[0];
              hookOutputs.push(
                await hook?.(
                  {
                    hook_event_name: "SessionStart",
                    source: "compact",
                    model: "claude-opus-4-6",
                  } as any,
                  undefined,
                  { signal: new AbortController().signal },
                ),
              );
              yield {
                type: "system",
                subtype: "compact_boundary",
                compact_metadata: { trigger: "auto", pre_tokens: 199000 },
                uuid: "compact-boundary-post-hook",
                session_id: "claude-sess-postcompact",
              } as unknown as SDKMessage;
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: "after compact" }] },
                parent_tool_use_id: null,
                uuid: "assistant-after-postcompact",
                session_id: "claude-sess-postcompact",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-postcompact", "final");
            })(),
          ),
        postResultDrainMs: 200,
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        {
          prompt: "hi",
          workspaceDir: "/tmp/claude-work",
          env: {},
          systemPrompt: "STABLE SYSTEM PROMPT\n\n키키 페르소나를 유지한다.",
        },
        new AbortController().signal,
      ),
    );

    const hookOutput = hookOutputs[0] as {
      systemMessage?: string;
      hookSpecificOutput?: {
        hookEventName?: string;
        additionalContext?: string;
      };
    };
    expect(hookOutput.systemMessage).toBeUndefined();
    expect(hookOutput.hookSpecificOutput).toMatchObject({
      hookEventName: "SessionStart",
    });
    expect(hookOutput.hookSpecificOutput?.additionalContext).toContain(
      "Conversation compaction just occurred.",
    );
    expect(hookOutput.hookSpecificOutput?.additionalContext).toContain("STABLE SYSTEM PROMPT");
    expect(hookOutput.hookSpecificOutput?.additionalContext).toContain("키키 페르소나를 유지한다.");
    expect(hookOutput.hookSpecificOutput?.additionalContext).not.toContain(
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    );
    expect(events.map((event) => event.type)).toEqual([
      "compact",
      "text",
      "result",
      "context_usage",
      "complete",
    ]);
    expect(events[1]).toMatchObject({ type: "text", text: "after compact" });
    expect(events[2]).toMatchObject({ type: "result", output: "final" });
  });

  it("does not register compact system reminder hook when no system prompt exists", async () => {
    const captured: ClaudeSdkQueryParams[] = [];
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          captured.push(params);
          return makeQuery(sdkMessages([sdkSuccessResult("claude-sess-no-system", "done")]));
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

    expect(captured[0]?.options?.hooks).not.toHaveProperty("SessionStart");
  });

  it("interruptActiveTurnForSteer calls query.interrupt and lets aborted_streaming success complete", async () => {
    const streamedMessages: SDKUserMessage[] = [];
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const release = deferred<void>();
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          return makeQuery(
            (async function* () {
              const input = params.prompt as AsyncIterable<SDKUserMessage>;
              const iterator = input[Symbol.asyncIterator]();
              const first = await iterator.next();
              if (!first.done) streamedMessages.push(first.value);
              yield sdkSystemInit("claude-sess-stream");

              await release.promise;
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: "partial before interrupt" }] },
                parent_tool_use_id: null,
                uuid: "assistant-stream",
                session_id: "claude-sess-stream",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-stream", "partial before interrupt", {
                stop_reason: null,
                terminal_reason: "aborted_streaming",
              });
            })(),
            { interrupt },
          );
        },
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    const iterator = client.run(
      {
        prompt: "first",
        workspaceDir: "/tmp/claude-work",
        env: {},
      },
      new AbortController().signal,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "session", sessionId: "claude-sess-stream" },
    });
    await expect(client.interruptActiveTurnForSteer()).resolves.toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(1);
    release.resolve();
    const events = await collectIterator(iterator);

    expect(streamedMessages.map((message) => message.message.content)).toEqual([
      "first",
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "partial before interrupt" }),
        expect.objectContaining({
          type: "result",
          stopReason: null,
          terminalReason: "aborted_streaming",
        }),
        expect.objectContaining({ type: "complete", result: "partial before interrupt" }),
      ]),
    );
    await expect(client.steerActiveTurn({ prompt: "late" })).resolves.toMatchObject({
      status: "not_supported",
    });
  });

  it("maps ede diagnostic user-terminal errors as recoverable so queued steer can drain", async () => {
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const input = params.prompt as AsyncIterable<SDKUserMessage>;
              const iterator = input[Symbol.asyncIterator]();
              await iterator.next();
              yield sdkSystemInit("claude-sess-user-result");
              yield {
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                result: "",
                errors: [
                  "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
                ],
                session_id: "claude-sess-user-result",
                usage: { input_tokens: 1, output_tokens: 1 },
                total_cost_usd: 0.01,
                stop_reason: null,
                modelUsage: {},
                permission_denials: [],
              } as unknown as SDKMessage;
            })(),
          ),
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    const iterator = client.run(
      {
        prompt: "first",
        workspaceDir: "/tmp/claude-work",
        env: {},
      },
      new AbortController().signal,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "session", sessionId: "claude-sess-user-result" },
    });
    const events = await collectIterator(iterator);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "result", success: false, stopReason: null }),
        expect.objectContaining({
          type: "error",
          fatal: false,
          errorCode: "error_during_execution",
        }),
      ]),
    );
  });

  it("maps ede diagnostic tool_use execution errors as recoverable", async () => {
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeQuery(
            (async function* () {
              const input = params.prompt as AsyncIterable<SDKUserMessage>;
              const iterator = input[Symbol.asyncIterator]();
              await iterator.next();
              yield sdkSystemInit("claude-sess-tool-use-diagnostic");
              yield {
                type: "result",
                subtype: "error_during_execution",
                is_error: true,
                result: "",
                errors: [
                  "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
                ],
                session_id: "claude-sess-tool-use-diagnostic",
                usage: { input_tokens: 1, output_tokens: 1 },
                total_cost_usd: 0.01,
                stop_reason: "tool_use",
                modelUsage: {},
                permission_denials: [],
              } as unknown as SDKMessage;
            })(),
          ),
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "first", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "result",
          success: false,
          stopReason: "tool_use",
        }),
        expect.objectContaining({
          type: "error",
          fatal: false,
          errorCode: "error_during_execution",
        }),
      ]),
    );
  });

  it("keeps non-ede execution diagnostic and max-turn results fatal", async () => {
    for (const resultMessage of [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "",
        errors: ["tool failed without diagnostic"],
        session_id: "claude-sess-non-ede",
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0.01,
        stop_reason: "tool_use",
        modelUsage: {},
        permission_denials: [],
      },
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        result: "",
        errors: ["maximum turns reached"],
        session_id: "claude-sess-max-turns",
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0.01,
        stop_reason: null,
        modelUsage: {},
        permission_denials: [],
      },
    ]) {
      const client = new ClaudeSdkClient(
        {
          query: () => makeQuery(sdkMessages([resultMessage])),
          postResultDrainMs: 10,
        },
        silentLogger,
      );

      const events = await collect(
        client.run(
          { prompt: "first", workspaceDir: "/tmp/claude-work", env: {} },
          new AbortController().signal,
        ),
      );

      expect(events.find((event) => event.type === "error")).toMatchObject({
        type: "error",
        fatal: true,
      });
    }
  });

  it("keeps tool_result continuation output-only with no live input stream", async () => {
    const promptKinds: string[] = [];
    const client = new ClaudeSdkClient(
      {
        query: (params) => {
          promptKinds.push(typeof params.prompt);
          return makeQuery(
            sdkMessages([
              {
                type: "assistant",
                message: {
                  content: [
                    {
                      type: "tool_use",
                      id: "toolu-query-only",
                      name: "Bash",
                      input: { command: "true" },
                    },
                  ],
                },
                parent_tool_use_id: null,
                uuid: "assistant-tool-query-only",
                session_id: "claude-sess-query-only",
              } as unknown as SDKMessage,
              sdkSuccessResult("claude-sess-query-only", "", { stop_reason: "tool_use" }),
              {
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "toolu-query-only",
                      content: "done",
                      is_error: false,
                    },
                  ],
                },
                parent_tool_use_id: null,
                uuid: "user-tool-query-only",
                session_id: "claude-sess-query-only",
              } as unknown as SDKMessage,
              {
                type: "assistant",
                message: { content: [{ type: "text", text: "continued safely" }] },
                parent_tool_use_id: null,
                uuid: "assistant-after-query-only",
                session_id: "claude-sess-query-only",
              } as unknown as SDKMessage,
              sdkSuccessResult("claude-sess-query-only", "done"),
            ]),
          );
        },
      },
      silentLogger,
    );

    const events = await collect(
      client.run(
        { prompt: "first", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );

    expect(promptKinds).toEqual(["object"]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_result", toolUseId: "toolu-query-only" }),
        expect.objectContaining({ type: "text", text: "continued safely" }),
        expect.objectContaining({ type: "complete", result: "done" }),
      ]),
    );
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error" }),
      ]),
    );
  });

  it("keeps image attachment input open during the turn and closes it after result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-query-image-"));
    try {
      const imagePath = join(dir, "sample.webp");
      const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46]);
      writeFileSync(imagePath, bytes);
      let firstInput: SDKUserMessage | undefined;
      let inputIterator: AsyncIterator<SDKUserMessage> | undefined;
      const client = new ClaudeSdkClient(
        {
          query: (params) =>
            makeQuery(
              (async function* () {
                const input = params.prompt as AsyncIterable<SDKUserMessage>;
                inputIterator = input[Symbol.asyncIterator]();
                const first = await inputIterator.next();
                firstInput = first.value;
                yield sdkSuccessResult("claude-sess-img-query", "done");
              })(),
            ),
        },
        silentLogger,
      );

      await collect(
        client.run(
          {
            prompt: "describe image",
            workspaceDir: "/tmp/claude-work",
            env: {},
            imageAttachmentPaths: [imagePath],
          },
          new AbortController().signal,
        ),
      );

      expect(firstInput?.message.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "describe image" }),
          expect.objectContaining({ type: "image" }),
        ]),
      );
      await expect(inputIterator?.next()).resolves.toMatchObject({ done: true });
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
    expect(captured[1]?.prompt).toBe("/compact");
  });

  it("drains a prompt_suggestion that arrives after the result message (Python receive_loop._drain_after_result parity)", async () => {
    // SDK 0.2.x typedef: "prompt_suggestion arrives after the result message. Consumers
    // must keep iterating the stream after result to receive it."
    // Legacy drain contract drains 1 message for PROMPT_SUGGESTION_DRAIN_TIMEOUT (2s).
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

  it("keeps the query open after result until Claude runtime reaches idle and no task is pending", async () => {
    let queryRef: ClaudeSdkQuery | undefined;
    const client = new ClaudeSdkClient(
      {
        query: () => {
          queryRef = makeQuery(
            (async function* () {
              yield {
                type: "system",
                subtype: "session_state_changed",
                state: "running",
                uuid: "runtime-running",
                session_id: "claude-sess-runtime",
              } as unknown as SDKMessage;
              yield {
                type: "system",
                subtype: "task_started",
                task_id: "task-bg-1",
                tool_use_id: "toolu-bg",
                description: "sleep in background",
                task_type: "bash",
                uuid: "task-started",
                session_id: "claude-sess-runtime",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-runtime", "done");
              yield {
                type: "system",
                subtype: "task_notification",
                task_id: "task-bg-1",
                tool_use_id: "toolu-bg",
                status: "completed",
                output_file: "/tmp/task.out",
                summary: "background complete",
                uuid: "task-notification",
                session_id: "claude-sess-runtime",
              } as unknown as SDKMessage;
              yield {
                type: "system",
                subtype: "session_state_changed",
                state: "idle",
                uuid: "runtime-idle",
                session_id: "claude-sess-runtime",
              } as unknown as SDKMessage;
            })(),
          );
          return queryRef;
        },
        postResultDrainMs: 10,
        runtimeDrainMaxMs: 200,
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
      "claude_runtime_session_state",
      "subagent_start",
      "claude_runtime_task_started",
      "subagent_stop",
      "claude_runtime_task_notification",
      "claude_runtime_session_state",
      "result",
      "context_usage",
      "complete",
    ]);
    expect(events[0]).toMatchObject({ type: "claude_runtime_session_state", state: "running" });
    expect(events[5]).toMatchObject({ type: "claude_runtime_session_state", state: "idle" });
    expect(events[4]).toMatchObject({
      type: "claude_runtime_task_notification",
      taskId: "task-bg-1",
      status: "completed",
    });
    expect(queryRef?.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "stringified BashOutput content",
      content: JSON.stringify({
        backgroundTaskId: "bg-task-1",
        rawOutputPath: "/tmp/bg-task-1.out",
      }),
      taskId: "bg-task-1",
      outputFile: "/tmp/bg-task-1.out",
    },
    {
      label: "content block list",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            backgroundTaskId: "bg-task-2",
            rawOutputPath: "/tmp/bg-task-2.out",
          }),
        },
      ],
      taskId: "bg-task-2",
      outputFile: "/tmp/bg-task-2.out",
    },
    {
      label: "top-level tool_use_result",
      content: "Background task started",
      toolUseResult: {
        stdout: "",
        stderr: "",
        interrupted: false,
        backgroundTaskId: "bg-task-3",
        rawOutputPath: "/tmp/bg-task-3.out",
      },
      taskId: "bg-task-3",
      outputFile: "/tmp/bg-task-3.out",
    },
  ])(
    "extracts BashOutput backgroundTaskId from $label into Claude runtime task wire",
    async ({ content, outputFile, taskId, toolUseResult }) => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              sdkSystemInit("claude-sess-bg"),
              {
                type: "assistant",
                message: {
                  content: [
                    {
                      type: "tool_use",
                      id: "toolu-bash",
                      name: "Bash",
                      input: { command: "sleep 30 &" },
                    },
                  ],
                },
                parent_tool_use_id: null,
                uuid: "assistant-bg",
                session_id: "claude-sess-bg",
              },
              {
                type: "user",
                message: {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "toolu-bash",
                      content,
                      is_error: false,
                    },
                  ],
                },
                ...(toolUseResult ? { tool_use_result: toolUseResult } : {}),
                parent_tool_use_id: null,
                uuid: "user-bg",
                session_id: "claude-sess-bg",
              },
              sdkSuccessResult("claude-sess-bg", "done"),
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

    expect(events.map((event) => event.type)).toContain("claude_runtime_task_started");
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "claude_runtime_task_started",
          taskId,
          toolUseId: "toolu-bash",
          taskType: "bash",
        }),
        expect.objectContaining({
          type: "claude_runtime_task_updated",
          taskId,
          patch: expect.objectContaining({
            status: "running",
            is_backgrounded: true,
            task_type: "bash",
            tool_use_id: "toolu-bash",
            output_file: outputFile,
          }),
        }),
      ]),
    );
  },
  );

  it("propagates Query.backgroundTasks false as no_match", async () => {
    const readyForBackground = deferred<void>();
    const finishRun = deferred<void>();
    const backgroundTasks = vi.fn(async () => false);
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              readyForBackground.resolve();
              await finishRun.promise;
              yield sdkSuccessResult("claude-sess-bg-no-match", "done");
            })(),
            { backgroundTasks },
          ),
      },
      silentLogger,
    );

    const eventsPromise = collect(
      client.run(
        { prompt: "hi", workspaceDir: "/tmp/claude-work", env: {} },
        new AbortController().signal,
      ),
    );
    await readyForBackground.promise;

    await expect(client.backgroundClaudeRuntimeTasks("toolu-missing")).resolves.toMatchObject({
      status: "no_match",
      message: expect.stringContaining("toolu-missing"),
    });
    expect(backgroundTasks).toHaveBeenCalledWith("toolu-missing");

    finishRun.resolve();
    await eventsPromise;
  });

  it("uses a bounded runtime drain when Claude never reports idle", async () => {
    let queryRef: ClaudeSdkQuery | undefined;
    const client = new ClaudeSdkClient(
      {
        query: () => {
          queryRef = makeQuery(
            (async function* () {
              yield {
                type: "system",
                subtype: "session_state_changed",
                state: "running",
                uuid: "runtime-running",
                session_id: "claude-sess-timeout",
              } as unknown as SDKMessage;
              yield {
                type: "system",
                subtype: "task_started",
                task_id: "task-bg-timeout",
                tool_use_id: "toolu-timeout",
                description: "never settles",
                task_type: "bash",
                uuid: "task-started-timeout",
                session_id: "claude-sess-timeout",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-timeout", "done");
              await new Promise<never>(() => {});
            })(),
          );
          return queryRef;
        },
        postResultDrainMs: 10,
        runtimeDrainMaxMs: 30,
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
      "claude_runtime_session_state",
      "subagent_start",
      "claude_runtime_task_started",
      "debug",
      "claude_runtime_task_notification",
      "claude_runtime_session_state",
      "error",
    ]);
    expect(events[3]).toMatchObject({
      type: "debug",
      message: "Claude runtime drain timed out after 30ms; closing query.",
    });
    expect(events[4]).toMatchObject({
      type: "claude_runtime_task_notification",
      taskId: "task-bg-timeout",
      status: "failed",
    });
    expect(events[5]).toMatchObject({
      type: "claude_runtime_session_state",
      state: "idle",
    });
    expect(events[6]).toMatchObject({
      type: "error",
      fatal: true,
      errorCode: "claude_runtime_timeout",
    });
    expect(queryRef?.close).toHaveBeenCalledTimes(1);
  });

  it("drains runtime idle after a tool_use continuation result before emitting terminal events", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              yield sdkSuccessResult("claude-sess-tool-runtime", "", {
                stop_reason: "tool_use",
              });
              yield {
                type: "system",
                subtype: "session_state_changed",
                state: "running",
                uuid: "runtime-running-after-tool",
                session_id: "claude-sess-tool-runtime",
              } as unknown as SDKMessage;
              yield sdkSuccessResult("claude-sess-tool-runtime", "final");
              yield {
                type: "system",
                subtype: "session_state_changed",
                state: "idle",
                uuid: "runtime-idle-after-tool",
                session_id: "claude-sess-tool-runtime",
              } as unknown as SDKMessage;
            })(),
          ),
        postResultDrainMs: 10,
        runtimeDrainMaxMs: 200,
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
      "claude_runtime_session_state",
      "claude_runtime_session_state",
      "result",
      "context_usage",
      "complete",
    ]);
    expect(events[0]).toMatchObject({ type: "claude_runtime_session_state", state: "running" });
    expect(events[1]).toMatchObject({ type: "claude_runtime_session_state", state: "idle" });
    expect(events[2]).toMatchObject({ type: "result", output: "final" });
  });

  it("emits a fatal error when the SDK stream ends before pending runtime work reaches idle", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              {
                type: "system",
                subtype: "session_state_changed",
                state: "running",
                uuid: "runtime-running",
                session_id: "claude-sess-eos",
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

    expect(events.map((event) => event.type)).toEqual([
      "claude_runtime_session_state",
      "error",
    ]);
    expect(events[1]).toMatchObject({
      type: "error",
      fatal: true,
      errorCode: "claude_runtime_ended_before_idle",
    });
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

  it("re-enters the receive loop when PreCompact fires but the SDK pass ends without a result", async () => {
    let receiveLoopEntries = 0;
    const client = new ClaudeSdkClient(
      {
        query: (params) =>
          makeReenterableQuery([
            () =>
              (async function* () {
                receiveLoopEntries += 1;
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
              })(),
            () =>
              (async function* () {
                receiveLoopEntries += 1;
                yield {
                  type: "assistant",
                  message: { content: [{ type: "text", text: "after compact retry" }] },
                  parent_tool_use_id: null,
                  uuid: "assistant-after-no-result-compact",
                  session_id: "claude-sess-no-result-compact",
                } as unknown as SDKMessage;
                yield sdkSuccessResult("claude-sess-no-result-compact", "final");
              })(),
          ]),
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

    expect(receiveLoopEntries).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "compact",
      "text",
      "result",
      "context_usage",
      "complete",
    ]);
    expect(events[0]).toMatchObject({ type: "compact", trigger: "auto" });
    expect(events[1]).toMatchObject({ type: "text", text: "after compact retry" });
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

  it("does not use subtype=success as the fatal error code when the result is marked is_error", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            sdkMessages([
              sdkSuccessResult("claude-sess-result-error", "API Error: 400 invalid JSON", {
                is_error: true,
                stop_reason: "stop_sequence",
              }),
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

    const result = events.find((event) => event.type === "result");
    const error = events.find((event) => event.type === "error");
    expect(result).toMatchObject({
      type: "result",
      success: false,
      error: "API Error: 400 invalid JSON",
      stopReason: "stop_sequence",
    });
    expect(error).toMatchObject({
      type: "error",
      fatal: true,
      errorCode: "claude_sdk_result_error",
      message: "API Error: 400 invalid JSON",
    });
  });

  it("marks post-result drain iterator errors as fatal instead of completing the turn", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              yield sdkSuccessResult("claude-sess-drain-error", "done");
              throw new Error("drain exploded");
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

    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        fatal: true,
        errorCode: "claude_sdk_drain_error",
        message: "Claude SDK post-result drain failed: drain exploded",
      }),
    ]);
  });

  it("maps ede diagnostic post-result drain errors as recoverable", async () => {
    const client = new ClaudeSdkClient(
      {
        query: () =>
          makeQuery(
            (async function* () {
              yield sdkSuccessResult("claude-sess-ede-drain-error", "done");
              throw new Error(
                "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
              );
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

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "complete",
          result: "done",
        }),
        expect.objectContaining({
          type: "error",
          fatal: false,
          errorCode: "claude_sdk_drain_error",
          message: expect.stringContaining("[ede_diagnostic]"),
        }),
      ]),
    );
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function expectPromisePending<T>(promise: Promise<T>, timeoutMs = 30): Promise<void> {
  const pending = Symbol("pending");
  const result = await Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), timeoutMs)),
  ]);
  expect(result).toBe(pending);
}

async function* sdkMessages(messages: unknown[]): AsyncGenerator<SDKMessage> {
  for (const message of messages) {
    yield message as SDKMessage;
  }
}

function makeQuery(
  generator: AsyncGenerator<SDKMessage>,
  overrides: Partial<ClaudeSdkQuery> = {},
): ClaudeSdkQuery {
  return Object.assign(generator, {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    ...overrides,
  }) as unknown as ClaudeSdkQuery;
}

function makeReenterableQuery(
  factories: Array<() => AsyncGenerator<SDKMessage>>,
  overrides: Partial<ClaudeSdkQuery> = {},
): ClaudeSdkQuery {
  let iteratorIndex = 0;
  return {
    interrupt: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    next: vi.fn(async () => ({ done: true as const, value: undefined as unknown as SDKMessage })),
    return: vi.fn(async () => ({ done: true as const, value: undefined })),
    throw: vi.fn(async (err?: unknown) => {
      throw err;
    }),
    [Symbol.asyncIterator]() {
      const factory = factories[Math.min(iteratorIndex, factories.length - 1)];
      iteratorIndex += 1;
      return factory();
    },
    ...overrides,
  } as unknown as ClaudeSdkQuery;
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
