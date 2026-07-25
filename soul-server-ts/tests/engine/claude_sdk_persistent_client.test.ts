import type {
  Query as ClaudeSdkQuery,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeEngineAdapter,
  ClaudeSdkClient,
} from "../../src/engine/claude_adapter.js";
import { ClaudeSessionClientRegistry } from "../../src/engine/claude_session_client_registry.js";
import type {
  ClaudeSdkQueryFn,
  ClaudeSdkQueryParams,
} from "../../src/engine/claude_sdk_client.js";
import { createEventQueue } from "../../src/engine/claude_sdk_event_queue.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";

const silentLogger = pino({ level: "silent" });

describe("ClaudeSdkClient persistent runtime", () => {
  it("fails closed instead of turning per-turn maxTurns into a session-global cap", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      { query: harness.queryFn, detachedEventSink: harness.detached },
      silentLogger,
    );

    await expect(collect(client.runPersistent(
      { ...runOptions("bounded"), maxTurns: 2 },
      abortSignal(),
    ))).rejects.toThrow("cannot preserve per-turn maxTurns");
    expect(harness.captured).toHaveLength(0);
  });

  it("keeps one Query open across Results and queues a drain-phase input without interrupt", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        postResultDrainMs: 10_000,
        detachedEventSink: harness.detached,
      },
      silentLogger,
    );

    const first = collect(client.runPersistent(runOptions("first"), abortSignal()));
    const firstInput = await harness.nextInput();
    harness.push(sdkInit("sdk-session"));
    harness.push(sdkResult("sdk-session", firstInput.uuid, "first done"));
    await expect(first).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "result", success: true }),
        expect.objectContaining({ type: "complete", result: "first done" }),
      ]),
    );

    await expect(client.interruptActiveTurnForSteer()).resolves.toBe(false);
    expect(harness.interrupt).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();

    const second = collect(client.runPersistent(runOptions("second"), abortSignal()));
    const secondInput = await harness.nextInput();
    expect(secondInput.priority).toBe("next");
    harness.push(sdkResult("sdk-session", secondInput.uuid, "second done"));
    await expect(second).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "complete", result: "second done" }),
      ]),
    );

    expect(harness.captured).toHaveLength(1);
    expect(harness.close).not.toHaveBeenCalled();
    await client.close();
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("interrupts only generating and suppresses the expected EDE error event", async () => {
    const harness = makeHarness({
      receipt: { still_queued: [] },
    });
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
      },
      silentLogger,
    );

    const turn = collect(client.runPersistent(runOptions("long work"), abortSignal()));
    const input = await harness.nextInput();
    harness.push(sdkInit("sdk-session"));

    await expect(client.interruptActiveTurnForSteer()).resolves.toBe(true);
    expect(harness.interrupt).toHaveBeenCalledTimes(1);
    harness.push(sdkInterruptedResult("sdk-session", input.uuid));

    const events = await turn;
    expect(events).toContainEqual(
      expect.objectContaining({ type: "result", success: false }),
    );
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(harness.detached).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
    await client.close();
  });

  it("routes background terminal events after foreground Result to durable detached output", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
      },
      silentLogger,
    );

    const turn = collect(client.runPersistent(runOptions("background"), abortSignal()));
    const input = await harness.nextInput();
    harness.push(sdkResult("sdk-session", input.uuid, "foreground done"));
    await turn;

    harness.push({
      type: "system",
      subtype: "task_notification",
      uuid: "task-notification-1",
      session_id: "sdk-session",
      task_id: "bg-1",
      tool_use_id: "tool-1",
      status: "completed",
      summary: "background done",
    } as unknown as SDKMessage);
    await vi.waitFor(() => {
      expect(harness.detached).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "claude_runtime_task_notification",
          taskId: "bg-1",
          status: "completed",
        }),
      );
    });
    expect(harness.interrupt).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
    await client.close();
  });

  it("suppresses a late duplicate Result without closing the next foreground turn", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        postResultDrainMs: 10_000,
        detachedEventSink: harness.detached,
      },
      silentLogger,
    );

    const first = collect(client.runPersistent(runOptions("first"), abortSignal()));
    const firstInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", firstInput.uuid, "first done"));
    await first;

    const second = collect(client.runPersistent(runOptions("second"), abortSignal()));
    const secondInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", firstInput.uuid, "late duplicate"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.push(sdkResult("sdk-session", secondInput.uuid, "second done"));

    await expect(second).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "complete", result: "second done" }),
      ]),
    );
    expect(harness.detached).not.toHaveBeenCalledWith(
      expect.objectContaining({ output: "late duplicate" }),
    );
    await client.close();
  });

  it("adapter drain-window intervention emits no error and reaches the next turn exactly once", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        postResultDrainMs: 10_000,
        detachedEventSink: harness.detached,
      },
      silentLogger,
    );
    const registry = new ClaudeSessionClientRegistry(() => client);
    const engine = new ClaudeEngineAdapter(
      {
        workspaceDir: "/tmp/claude-persistent",
        persistentSessionRegistry: registry,
        processEnv: {},
      },
      silentLogger,
    );

    const firstIterator = engine.execute({
      agentSessionId: "agent-session",
      prompt: "first",
    })[Symbol.asyncIterator]();
    const firstEvent = firstIterator.next();
    const firstInput = await harness.nextInput();
    harness.push(sdkInit("sdk-session"));
    harness.push(sdkResult("sdk-session", firstInput.uuid, "first done"));
    await expect(firstEvent).resolves.toMatchObject({
      value: { type: "session" },
    });
    await expect(firstIterator.next()).resolves.toMatchObject({
      value: { type: "result", success: true },
    });

    await expect(engine.interruptForSteer()).resolves.toBe(false);
    expect(harness.interrupt).not.toHaveBeenCalled();
    const firstTail = await collectRemaining(firstIterator);
    expect(firstTail.filter((event) => event.type === "error")).toEqual([]);

    const second = collectSse(engine.execute({
      agentSessionId: "agent-session",
      prompt: "drain-window intervention",
    }));
    const secondInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", secondInput.uuid, "second done"));
    const secondEvents = await second;

    expect(secondEvents.filter((event) => event.type === "error")).toEqual([]);
    expect(secondEvents.filter((event) => event.type === "complete")).toHaveLength(1);
    expect(harness.captured).toHaveLength(1);
    await registry.shutdown();
  });
});

function makeHarness(
  options: { receipt?: SDKControlInterruptResponse } = {},
) {
  const output = createEventQueue<SDKMessage>();
  const captured: ClaudeSdkQueryParams[] = [];
  let input: AsyncIterable<SDKUserMessage> | null = null;
  const interrupt = vi.fn(async () => options.receipt);
  const close = vi.fn(() => output.close());
  const query = {
    interrupt,
    close,
    backgroundTasks: vi.fn(async () => false),
    stopTask: vi.fn(async () => undefined),
    [Symbol.asyncIterator]: () => output,
  } as unknown as ClaudeSdkQuery;
  const queryFn: ClaudeSdkQueryFn = (params) => {
    captured.push(params);
    input = params.prompt as AsyncIterable<SDKUserMessage>;
    return query;
  };
  return {
    captured,
    close,
    detached: vi.fn(async (_event: ClaudeClientEvent) => undefined),
    interrupt,
    push: (message: SDKMessage) => output.push(message),
    queryFn,
    async nextInput(): Promise<SDKUserMessage> {
      await vi.waitFor(() => expect(input).not.toBeNull());
      const next = await input![Symbol.asyncIterator]().next();
      if (next.done) throw new Error("Persistent input queue closed unexpectedly");
      return next.value;
    },
  };
}

function runOptions(prompt: string) {
  return {
    agentSessionId: "agent-session",
    prompt,
    workspaceDir: "/tmp/claude-persistent",
  };
}

function abortSignal(): AbortSignal {
  return new AbortController().signal;
}

function sdkInit(sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    uuid: `init-${sessionId}`,
    session_id: sessionId,
    cwd: "/tmp/claude-persistent",
    tools: [],
    mcp_servers: [],
    model: "claude",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: "test",
    output_style: "default",
    agents: [],
    skills: [],
    plugins: [],
  } as unknown as SDKMessage;
}

function sdkResult(
  sessionId: string,
  userMessageUuid: string | undefined,
  result: string,
): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    uuid: `result-${result}`,
    session_id: sessionId,
    user_message_uuid: userMessageUuid,
    is_error: false,
    result,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: {},
      service_tier: "standard",
    },
    modelUsage: {},
    permission_denials: [],
  } as unknown as SDKMessage;
}

function sdkInterruptedResult(
  sessionId: string,
  userMessageUuid: string | undefined,
): SDKMessage {
  return {
    ...sdkResult(sessionId, userMessageUuid, ""),
    subtype: "error_during_execution",
    is_error: true,
    errors: [
      "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null (aborted_streaming)",
    ],
    stop_reason: null,
  } as unknown as SDKMessage;
}

async function collect(
  iterable: AsyncIterable<ClaudeClientEvent>,
): Promise<ClaudeClientEvent[]> {
  const events: ClaudeClientEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function collectSse(
  iterable: AsyncIterable<SSEEventPayload>,
): Promise<SSEEventPayload[]> {
  return await collectRemaining(iterable[Symbol.asyncIterator]());
}

async function collectRemaining<T>(
  iterator: AsyncIterator<T>,
): Promise<T[]> {
  const values: T[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return values;
    values.push(next.value);
  }
}
