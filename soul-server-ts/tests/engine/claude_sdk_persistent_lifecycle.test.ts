import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeEngineAdapter,
  ClaudeSdkClient,
} from "../../src/engine/claude_adapter.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";
import { ClaudeSessionClientRegistry } from
  "../../src/engine/claude_session_client_registry.js";
import {
  abortSignal,
  collect,
  collectSse,
  makeHarness,
  runOptions,
  sdkResult,
} from "./claude_sdk_persistent_test_harness.js";

const silentLogger = pino({ level: "silent" });

describe("ClaudeSdkClient persistent lifecycle", () => {
  it("retains a background Query across foreground Result, drain, and idle TTL", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      const client = new ClaudeSdkClient(
        {
          query: harness.queryFn,
          postResultDrainMs: 5,
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
        prompt: "start background",
      }));
      const input = await harness.nextInput();
      harness.push({
        type: "system",
        subtype: "background_tasks_changed",
        uuid: "background-membership-retained",
        session_id: "sdk-session",
        tasks: [{ task_id: "bg-retained", description: "long task" }],
      } as unknown as SDKMessage);
      harness.push({
        type: "system",
        subtype: "task_started",
        uuid: "task-started-retained",
        session_id: "sdk-session",
        task_id: "bg-retained",
        description: "long task",
      } as unknown as SDKMessage);
      harness.push(sdkResult("sdk-session", input.uuid, "foreground done"));
      await turn;
      await engine.close();

      await vi.advanceTimersByTimeAsync(25);
      expect(registry.has("agent-session")).toBe(true);
      expect(harness.close).not.toHaveBeenCalled();

      harness.push({
        type: "system",
        subtype: "task_notification",
        uuid: "task-notification-retained",
        session_id: "sdk-session",
        task_id: "bg-retained",
        status: "completed",
        summary: "background done",
      } as unknown as SDKMessage);
      await vi.waitFor(() => {
        expect(harness.detached).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "claude_runtime_task_notification",
            taskId: "bg-retained",
            status: "completed",
          }),
        );
      });
      await vi.advanceTimersByTimeAsync(10);
      await vi.waitFor(() => expect(registry.has("agent-session")).toBe(false));
      expect(harness.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects a real TaskCreated hook-pump signal into registry retention", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        postResultDrainMs: 5,
      },
      silentLogger,
    );
    const registry = new ClaudeSessionClientRegistry(
      (sessionId) =>
        sessionId === "agent-session"
          ? client
          : { async *run() {} },
      { idleTtlMs: 60_000, maxEntries: 1 },
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
      prompt: "create hooked task",
    }));
    const input = await harness.nextInput();
    harness.push({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "background-membership-hook-pump",
      session_id: "sdk-session",
      tasks: [{
        task_id: "hook-pump-task",
        description: "Queued hook work",
        task_type: "agent",
      }],
    } as unknown as SDKMessage);
    await vi.waitFor(() =>
      expect(client.persistentRuntimeActivity()).toMatchObject({
        backgroundTaskCount: 1,
      })
    );
    const createdHook =
      harness.captured[0]?.options?.hooks?.TaskCreated?.[0]?.hooks[0];
    const completedHook =
      harness.captured[0]?.options?.hooks?.TaskCompleted?.[0]?.hooks[0];
    await createdHook?.(
      {
        hook_event_name: "TaskCreated",
        task_id: "hook-pump-task",
        task_subject: "Queued hook work",
        session_id: "sdk-session",
      } as any,
      "hook-created",
      { signal: new AbortController().signal },
    );
    await vi.waitFor(() =>
      expect(client.persistentRuntimeActivity()).toMatchObject({
        backgroundTaskCount: 1,
        pendingRuntimeSignalCount: 1,
      })
    );
    harness.push(sdkResult("sdk-session", input.uuid, "foreground done"));
    await turn;
    await engine.close();

    expect(() => registry.acquire("next-session")).toThrow("capacity");

    await completedHook?.(
      {
        hook_event_name: "TaskCompleted",
        task_id: "hook-pump-task",
        task_subject: "Queued hook work",
        session_id: "sdk-session",
      } as any,
      "hook-completed",
      { signal: new AbortController().signal },
    );
    harness.push({
      type: "system",
      subtype: "task_notification",
      uuid: "task-notification-hook-pump",
      session_id: "sdk-session",
      task_id: "hook-pump-task",
      status: "completed",
      summary: "Queued hook work completed",
    } as unknown as SDKMessage);
    harness.push({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "background-membership-hook-pump-empty",
      session_id: "sdk-session",
      tasks: [],
    } as unknown as SDKMessage);
    await vi.waitFor(() =>
      expect(client.persistentRuntimeActivity()).toMatchObject({
        foregroundPhase: "idle",
        backgroundTaskCount: 0,
        pendingRuntimeSignalCount: 0,
      })
    );

    expect(registry.acquire("next-session")).toBeDefined();
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledTimes(1));
    await registry.shutdown();
  });

  it("emits an explicit killed terminal with close reason before forced Query close", async () => {
    const harness = makeHarness();
    const runtimeEvents: ClaudeClientEvent[] = [];
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        runtimeEventSink: async (event) => {
          runtimeEvents.push(event);
          return true;
        },
      },
      silentLogger,
    );

    const turn = collect(client.runPersistent(runOptions("background"), abortSignal()));
    const input = await harness.nextInput();
    harness.push({
      type: "system",
      subtype: "background_tasks_changed",
      uuid: "background-membership-close",
      session_id: "sdk-session",
      tasks: [{
        task_id: "bg-close",
        description: "long task",
        task_type: "agent",
      }],
    } as unknown as SDKMessage);
    harness.push({
      type: "system",
      subtype: "task_started",
      uuid: "task-started-1",
      session_id: "sdk-session",
      task_id: "bg-close",
      description: "long task",
    } as unknown as SDKMessage);
    harness.push(sdkResult("sdk-session", input.uuid, "foreground done"));
    await turn;

    await client.close("registry_ttl");
    expect(runtimeEvents).toContainEqual(
      expect.objectContaining({
        type: "claude_runtime_task_updated",
        taskId: "bg-close",
        patch: expect.objectContaining({
          status: "killed",
          close_reason: "registry_ttl",
        }),
      }),
    );
    expect(harness.detached).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "claude_runtime_task_updated",
        taskId: "bg-close",
      }),
    );
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("still closes the Query when terminal persistence must defer to restart recovery", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        runtimeEventSink: async (event) => {
          if (event.type === "claude_runtime_task_updated") {
            throw new Error("temporary database outage");
          }
          return true;
        },
      },
      silentLogger,
    );

    const turn = collect(client.runPersistent(runOptions("background"), abortSignal()));
    const input = await harness.nextInput();
    harness.push({
      type: "system",
      subtype: "task_started",
      uuid: "task-started-recoverable",
      session_id: "sdk-session",
      task_id: "bg-recoverable",
      description: "long task",
    } as unknown as SDKMessage);
    harness.push(sdkResult("sdk-session", input.uuid, "foreground done"));
    await turn;

    await expect(client.close("shutdown")).resolves.toBeUndefined();
    expect(harness.close).toHaveBeenCalledTimes(1);
  });

  it("turns an uncorrelated Result into one bounded fatal recovery event", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      const client = new ClaudeSdkClient(
        {
          query: harness.queryFn,
          detachedEventSink: harness.detached,
          uncorrelatedResultTimeoutMs: 100,
        },
        silentLogger,
      );

      const turn = collect(client.runPersistent(runOptions("bounded"), abortSignal()));
      await harness.nextInput();
      harness.push(sdkResult("sdk-session", undefined, "uncorrelated"));
      await vi.advanceTimersByTimeAsync(100);

      await expect(turn).resolves.toEqual([
        expect.objectContaining({
          type: "error",
          fatal: true,
          errorCode: "claude_uncorrelated_result_timeout",
        }),
      ]);
      expect(harness.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
