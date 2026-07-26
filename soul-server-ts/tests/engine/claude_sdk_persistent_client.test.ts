import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeEngineAdapter,
  ClaudeSdkClient,
} from "../../src/engine/claude_adapter.js";
import { ClaudeSessionClientRegistry } from "../../src/engine/claude_session_client_registry.js";
import {
  abortSignal,
  collect,
  collectRemaining,
  collectSse,
  makeHarness,
  runOptions,
  sdkInit,
  sdkInterruptedResult,
  sdkResult,
} from "./claude_sdk_persistent_test_harness.js";

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

  it("does not bind a UUID-less late Result to the active foreground turn", async () => {
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

    let secondSettled = false;
    const second = collect(
      client.runPersistent(runOptions("second"), abortSignal()),
    ).finally(() => {
      secondSettled = true;
    });
    const secondInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", undefined, "late uncorrelated"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(secondSettled).toBe(false);
    expect(harness.detached).not.toHaveBeenCalledWith(
      expect.objectContaining({ output: "late uncorrelated" }),
    );

    harness.push(sdkResult("sdk-session", secondInput.uuid, "second done"));
    await expect(second).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "complete", result: "second done" }),
      ]),
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
    const registry = new ClaudeSessionClientRegistry(
      () => client,
      { idleTtlMs: 300_000, maxEntries: 16 },
    );
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

  it("adapter release lets the registry reclaim the real persistent Query after idle TTL", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      const client = new ClaudeSdkClient(
        {
          query: harness.queryFn,
          postResultDrainMs: 1,
          detachedEventSink: harness.detached,
        },
        silentLogger,
      );
      const registry = new ClaudeSessionClientRegistry(
        () => client,
        { idleTtlMs: 10, maxEntries: 2 },
      );
      const engine = new ClaudeEngineAdapter(
        {
          workspaceDir: "/tmp/claude-persistent",
          persistentSessionRegistry: registry,
          processEnv: {},
        },
        silentLogger,
      );

      const turn = collectSse(engine.execute({
        agentSessionId: "agent-session",
        prompt: "finish",
      }));
      const input = await harness.nextInput();
      harness.push(sdkResult("sdk-session", input.uuid, "done"));
      await turn;
      await engine.close();

      expect(registry.has("agent-session")).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(registry.has("agent-session")).toBe(false));
      expect(harness.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late turn reacquires the same Query through a new turn-scoped adapter", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        postResultDrainMs: 10_000,
        detachedEventSink: harness.detached,
      },
      silentLogger,
    );
    const registry = new ClaudeSessionClientRegistry(
      () => client,
      { idleTtlMs: 300_000, maxEntries: 16 },
    );
    const firstEngine = new ClaudeEngineAdapter(
      {
        workspaceDir: "/tmp/claude-persistent",
        persistentSessionRegistry: registry,
        processEnv: {},
      },
      silentLogger,
    );

    const first = collectSse(firstEngine.execute({
      agentSessionId: "agent-session",
      prompt: "first",
    }));
    const firstInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", firstInput.uuid, "first done"));
    await first;
    await firstEngine.close();

    const secondEngine = new ClaudeEngineAdapter(
      {
        workspaceDir: "/tmp/claude-persistent",
        persistentSessionRegistry: registry,
        processEnv: {},
      },
      silentLogger,
    );
    const second = collectSse(secondEngine.execute({
      agentSessionId: "agent-session",
      prompt: "late input",
    }));
    const secondInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", secondInput.uuid, "second done"));

    await expect(second).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "complete", result: "second done" }),
      ]),
    );
    expect(harness.captured).toHaveLength(1);
    expect(harness.close).not.toHaveBeenCalled();
    await secondEngine.close();
    await registry.shutdown();
  });
});
