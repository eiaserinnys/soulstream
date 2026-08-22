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
  sdkTaskNotificationInput,
  sdkTaskNotificationResult,
} from "./claude_sdk_persistent_test_harness.js";

const silentLogger = pino({ level: "silent" });

describe("ClaudeSdkClient persistent runtime", () => {
  it("omits SDK maxTurns from one persistent Query while preserving later turns", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      { query: harness.queryFn, detachedEventSink: harness.detached },
      silentLogger,
    );

    const first = collect(client.runPersistent(
      { ...runOptions("bounded-1"), maxTurns: 2 },
      abortSignal(),
    ));
    const firstInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", firstInput.uuid, "first done"));
    await first;

    const second = collect(client.runPersistent(
      { ...runOptions("bounded-2"), maxTurns: 2 },
      abortSignal(),
    ));
    const secondInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", secondInput.uuid, "second done"));
    await second;

    expect(harness.captured).toHaveLength(1);
    expect(harness.captured[0]?.options).not.toHaveProperty("maxTurns");
    await client.close();
  });

  it("interrupts an inactive foreground turn without closing the persistent Query", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        persistentTurnInactivityTimeoutMs: 10,
        postResultDrainMs: 1_000,
      },
      silentLogger,
    );

    const timedOut = collect(client.runPersistent(
      runOptions("long turn"),
      abortSignal(),
    ));
    const firstInput = await harness.nextInput();
    await vi.waitFor(() => {
      expect(harness.interrupt).toHaveBeenCalledTimes(1);
    });
    harness.push(sdkInterruptedResult("sdk-session", firstInput.uuid));

    await expect(timedOut).resolves.toContainEqual(
      expect.objectContaining({
        type: "error",
        fatal: true,
        errorCode: "claude_persistent_turn_timeout",
      }),
    );
    expect(harness.close).not.toHaveBeenCalled();

    const resumed = collect(client.runPersistent(
      runOptions("after timeout"),
      abortSignal(),
    ));
    const secondInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", secondInput.uuid, "recovered"));
    await expect(resumed).resolves.toContainEqual(
      expect.objectContaining({ type: "complete", result: "recovered" }),
    );
    expect(harness.captured).toHaveLength(1);
    await client.close();
  });

  it("keeps a foreground turn alive for hours while user-visible activity continues", async () => {
    vi.useFakeTimers();
    try {
      const inactivityTimeoutMs = 10 * 60_000;
      const harness = makeHarness();
      const client = new ClaudeSdkClient(
        {
          query: harness.queryFn,
          detachedEventSink: harness.detached,
          persistentTurnInactivityTimeoutMs: inactivityTimeoutMs,
        },
        silentLogger,
      );

      const turn = collect(client.runPersistent(runOptions("multi-hour turn"), abortSignal()));
      const input = await harness.nextInput();
      harness.push(input as SDKMessage);

      for (let index = 0; index < 20; index += 1) {
        await vi.advanceTimersByTimeAsync(9 * 60_000);
        if (index % 3 === 0) {
          harness.push(sdkAssistantText(`long-text-${index}`, `progress ${index}`));
        } else if (index % 3 === 1) {
          harness.push(sdkAssistantThinking(`long-thinking-${index}`, `thinking ${index}`));
        } else {
          harness.push(sdkToolResultInput(`long-tool-result-${index}`, "human", `tool-${index}`));
        }
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(harness.interrupt).not.toHaveBeenCalled();
      harness.push(sdkResult("sdk-session", input.uuid, "finished after three hours"));
      await expect(turn).resolves.toContainEqual(
        expect.objectContaining({ type: "complete", result: "finished after three hours" }),
      );
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a silent in-flight tool for the full interval and renews on tool_result", async () => {
    vi.useFakeTimers();
    try {
      const inactivityTimeoutMs = 10 * 60_000;
      const harness = makeHarness();
      const client = new ClaudeSdkClient(
        {
          query: harness.queryFn,
          detachedEventSink: harness.detached,
          persistentTurnInactivityTimeoutMs: inactivityTimeoutMs,
        },
        silentLogger,
      );

      const turn = collect(client.runPersistent(runOptions("large upload"), abortSignal()));
      const input = await harness.nextInput();
      harness.push(input as SDKMessage);
      harness.push(sdkAssistantToolStart("upload-start", "upload-tool"));
      await vi.advanceTimersByTimeAsync(inactivityTimeoutMs - 1_000);
      expect(harness.interrupt).not.toHaveBeenCalled();

      harness.push(sdkToolResultInput("upload-result", "human", "upload-tool"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(inactivityTimeoutMs - 1_000);
      expect(harness.interrupt).not.toHaveBeenCalled();

      harness.push(sdkResult("sdk-session", input.uuid, "upload complete"));
      await expect(turn).resolves.toContainEqual(
        expect.objectContaining({ type: "complete", result: "upload complete" }),
      );
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a silent runtime follow-up as a non-fatal no-op and keeps the Query on its Result", async () => {
    const harness = makeHarness({ receipt: { still_queued: [] } });
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        persistentTurnInactivityTimeoutMs: 30 * 60_000,
        runtimeFollowupNoOutputTimeoutMs: 10,
        postResultDrainMs: 1_000,
      },
      silentLogger,
    );

    const noOp = collect(client.runPersistent(
      {
        ...runOptions("runtime follow-up"),
        turnOrigin: { kind: "runtime_followup", id: "delivery-runtime-1" },
      },
      abortSignal(),
    ));
    const firstInput = await harness.nextInput();
    await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledTimes(1));
    harness.push(sdkInterruptedResult("sdk-session", firstInput.uuid));

    await expect(noOp).resolves.toEqual([]);
    expect(harness.close).not.toHaveBeenCalled();

    const resumed = collect(client.runPersistent(
      { ...runOptions("user turn"), turnOrigin: { kind: "user_message" } },
      abortSignal(),
    ));
    const secondInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", secondInput.uuid, "user response"));
    await expect(resumed).resolves.toContainEqual(
      expect.objectContaining({ type: "complete", result: "user response" }),
    );
    expect(harness.captured).toHaveLength(1);
    await client.close();
  });

  it("closes and recreates when a task-notification Result is not the interrupt Result", async () => {
    const harness = makeHarness({ receipt: { still_queued: [] } });
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        persistentTurnInactivityTimeoutMs: 30 * 60_000,
        runtimeFollowupNoOutputTimeoutMs: 10,
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    const noOp = collect(client.runPersistent(
      {
        ...runOptions("runtime follow-up during task notification"),
        turnOrigin: { kind: "runtime_followup", id: "delivery-runtime-notification" },
      },
      abortSignal(),
    ));
    await harness.nextInput();
    await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledTimes(1));

    harness.push(sdkTaskNotificationResult("sdk-session"));
    await expect(noOp).resolves.toEqual([]);
    expect(harness.close).toHaveBeenCalledTimes(1);

    const resumed = collect(client.runPersistent(
      { ...runOptions("user after task notification"), turnOrigin: { kind: "user_message" } },
      abortSignal(),
    ));
    const resumedInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", resumedInput.uuid, "fresh after task notification"));
    await expect(resumed).resolves.toContainEqual(
      expect.objectContaining({ type: "complete", result: "fresh after task notification" }),
    );
    expect(harness.captured).toHaveLength(2);
    await client.close();
  });

  it("settles a progressed runtime follow-up promptly when intervention follows a task-notification Result", async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ receipt: { still_queued: [] } });
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        persistentTurnInactivityTimeoutMs: 30 * 60_000,
        runtimeFollowupNoOutputTimeoutMs: 30_000,
        postResultDrainMs: 10,
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

    try {
      const warmup = collectSse(engine.execute({
        agentSessionId: "agent-session",
        prompt: "warm persistent query",
        turnOrigin: { kind: "user_message" },
      }));
      const warmupInput = await harness.nextInput();
      harness.push(warmupInput as SDKMessage);
      harness.push(sdkResult("sdk-session", warmupInput.uuid, "warm"));
      await warmup;

      harness.push(sdkTaskNotificationInput("sdk-session"));
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.detached).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "claude_runtime_remote_trigger",
          originKind: "task-notification",
        }),
      );

      let settled = false;
      const turn = collectSse(engine.execute({
        agentSessionId: "agent-session",
        prompt: "runtime follow-up colliding with a task notification",
        turnOrigin: { kind: "runtime_followup", id: "delivery-runtime-collision" },
      })).then((events) => {
        settled = true;
        return events;
      });
      await harness.nextInput();

      harness.push({
        type: "assistant",
        uuid: "assistant-task-notification-progress",
        session_id: "sdk-session",
        message: {
          id: "assistant-task-notification-progress",
          model: "claude",
          role: "assistant",
          content: [{ type: "text", text: "handling the completed background task" }],
        },
      } as unknown as SDKMessage);
      await vi.advanceTimersByTimeAsync(0);
      harness.push(sdkTaskNotificationResult("sdk-session"));
      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      await turn;
      await expect(engine.intervene({ prompt: "user priority message" })).resolves.toEqual({
        status: "not_delivered",
        mechanism: "interrupt_then_next_turn",
        reason: "no_active_turn",
      });
      expect(harness.interrupt).not.toHaveBeenCalled();
    } finally {
      await registry.shutdown();
      vi.useRealTimers();
    }
  });

  it("keeps the runtime-follow-up watchdog armed for task-notification assistant progress", async () => {
    const inputUuid = "21212121-2121-5212-8212-212121212121";
    const harness = makeHarness({ receipt: { still_queued: [inputUuid] } });
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        persistentTurnInactivityTimeoutMs: 30 * 60_000,
        runtimeFollowupNoOutputTimeoutMs: 10,
      },
      silentLogger,
    );

    const warmup = collect(client.runPersistent(runOptions("warm query"), abortSignal()));
    const warmupInput = await harness.nextInput();
    harness.push(warmupInput as SDKMessage);
    harness.push(sdkResult("sdk-session", warmupInput.uuid, "warm"));
    await warmup;
    harness.push(sdkTaskNotificationInput("sdk-session"));
    await vi.waitFor(() => {
      expect(harness.detached).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "claude_runtime_remote_trigger",
          originKind: "task-notification",
        }),
      );
    });

    const turn = collect(client.runPersistent(
      {
        ...runOptions("runtime follow-up behind a task notification"),
        inputUuid,
        turnOrigin: { kind: "runtime_followup", id: "delivery-runtime-foreign-progress" },
      },
      abortSignal(),
    ));
    await harness.nextInput();
    harness.push({
      type: "assistant",
      uuid: "assistant-task-notification-progress",
      session_id: "sdk-session",
      message: {
        id: "assistant-task-notification-progress",
        model: "claude",
        role: "assistant",
        content: [{ type: "text", text: "handling the completed background task" }],
      },
    } as unknown as SDKMessage);

    await expect(turn).resolves.toEqual([]);
    expect(harness.interrupt).toHaveBeenCalledTimes(1);
    expect(harness.close).toHaveBeenCalledTimes(1);
    expect(harness.detached).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "text",
        text: "handling the completed background task",
      }),
    );
    await client.close();
  });

  it("keeps a healthy follow-up alive when a second background task finishes", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        runtimeFollowupNoOutputTimeoutMs: 30_000,
      },
      silentLogger,
    );

    const turn = collect(client.runPersistent(
      {
        ...runOptions("healthy follow-up"),
        turnOrigin: { kind: "runtime_followup", id: "delivery-healthy" },
      },
      abortSignal(),
    ));
    const ownInput = await harness.nextInput();
    harness.push(ownInput as SDKMessage);
    harness.push(sdkAssistantText("step-one", "step one"));
    harness.push(sdkTaskNotificationInput("sdk-session"));
    harness.push(sdkTaskNotificationResult("sdk-session"));
    harness.push(sdkAssistantText("step-two", "step two"));
    harness.push(sdkResult("sdk-session", ownInput.uuid, "healthy result"));

    await expect(turn).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "step one" }),
      expect.objectContaining({ type: "text", text: "step two" }),
      expect.objectContaining({ type: "complete", result: "healthy result" }),
    ]));
    expect(harness.close).not.toHaveBeenCalled();
    await client.close();
  });

  it("keeps follow-up output foreground when a peer trigger arrives mid-turn", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        runtimeFollowupNoOutputTimeoutMs: 30_000,
      },
      silentLogger,
    );

    const turn = collect(client.runPersistent(
      {
        ...runOptions("follow-up with peer trigger"),
        turnOrigin: { kind: "runtime_followup", id: "delivery-peer" },
      },
      abortSignal(),
    ));
    const ownInput = await harness.nextInput();
    harness.push(ownInput as SDKMessage);
    harness.push(sdkRemoteInput("remote-peer", "peer", "peer update"));
    harness.push(sdkAssistantText("peer-progress", "working on the followup"));
    harness.push(sdkResult("sdk-session", ownInput.uuid, "peer-safe result"));

    await expect(turn).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "working on the followup" }),
      expect.objectContaining({ type: "complete", result: "peer-safe result" }),
    ]));
    expect(harness.detached).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "text", text: "working on the followup" }),
    );
    expect(harness.interrupt).not.toHaveBeenCalled();
    await client.close();
  });

  it.each([undefined, "human"])(
    "keeps output foreground across tool_result input with origin %s",
    async (originKind) => {
      const harness = makeHarness();
      const client = new ClaudeSdkClient(
        {
          query: harness.queryFn,
          detachedEventSink: harness.detached,
          runtimeFollowupNoOutputTimeoutMs: 30_000,
        },
        silentLogger,
      );

      const turn = collect(client.runPersistent(
        {
          ...runOptions("follow-up using a tool"),
          turnOrigin: { kind: "runtime_followup", id: "delivery-tool" },
        },
        abortSignal(),
      ));
      const ownInput = await harness.nextInput();
      harness.push(ownInput as SDKMessage);
      harness.push(sdkAssistantText("before-tool", "before tool"));
      harness.push(sdkToolResultInput("tool-result-input", originKind));
      harness.push(sdkAssistantText("after-tool", "after tool"));
      harness.push(sdkResult("sdk-session", ownInput.uuid, "tool result"));

      await expect(turn).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "before tool" }),
        expect.objectContaining({ type: "text", text: "after tool" }),
        expect.objectContaining({ type: "complete", result: "tool result" }),
      ]));
      expect(harness.detached).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "text", text: "after tool" }),
      );
      await client.close();
    },
  );

  it("closes a Query when the silent runtime follow-up remains queued", async () => {
    const inputUuid = "22222222-2222-5222-8222-222222222222";
    const harness = makeHarness({ receipt: { still_queued: [inputUuid] } });
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        runtimeFollowupNoOutputTimeoutMs: 10,
      },
      silentLogger,
    );

    const noOp = collect(client.runPersistent(
      {
        ...runOptions("queued runtime follow-up"),
        inputUuid,
        turnOrigin: { kind: "runtime_followup", id: "delivery-runtime-2" },
      },
      abortSignal(),
    ));
    await harness.nextInput();

    await expect(noOp).resolves.toEqual([]);
    expect(harness.close).toHaveBeenCalledTimes(1);

    const resumed = collect(client.runPersistent(
      { ...runOptions("user after queued follow-up"), turnOrigin: { kind: "user_message" } },
      abortSignal(),
    ));
    const resumedInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", resumedInput.uuid, "fresh query response"));
    await expect(resumed).resolves.toContainEqual(
      expect.objectContaining({ type: "complete", result: "fresh query response" }),
    );
    expect(harness.captured).toHaveLength(2);
    await client.close();
  });

  it("creates the next Query before a closing Query iterator finishes", async () => {
    const inputUuid = "23232323-2323-5232-8232-232323232323";
    const harness = makeHarness({
      receipt: { still_queued: [inputUuid] },
      deferQueryClose: true,
    });
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        runtimeFollowupNoOutputTimeoutMs: 10,
      },
      silentLogger,
    );

    const noOp = collect(client.runPersistent(
      {
        ...runOptions("queued runtime follow-up with delayed Query close"),
        inputUuid,
        turnOrigin: { kind: "runtime_followup", id: "delivery-runtime-close-race" },
      },
      abortSignal(),
    ));
    await harness.nextInput();
    await expect(noOp).resolves.toEqual([]);

    const resumed = collect(client.runPersistent(
      { ...runOptions("user after delayed close"), turnOrigin: { kind: "user_message" } },
      abortSignal(),
    ));
    const resumedInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", resumedInput.uuid, "new Query before old iterator end"));
    await expect(resumed).resolves.toContainEqual(
      expect.objectContaining({ type: "complete", result: "new Query before old iterator end" }),
    );
    expect(harness.captured).toHaveLength(2);

    harness.releaseClosedQueries();
    const reused = collect(client.runPersistent(
      { ...runOptions("reuse replacement Query"), turnOrigin: { kind: "user_message" } },
      abortSignal(),
    ));
    const reusedInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", reusedInput.uuid, "replacement remained current"));
    await expect(reused).resolves.toContainEqual(
      expect.objectContaining({ type: "complete", result: "replacement remained current" }),
    );
    expect(harness.captured).toHaveLength(2);

    const closePromise = client.close();
    await vi.waitFor(() => expect(harness.close).toHaveBeenCalledTimes(2));
    harness.releaseClosedQueries();
    await closePromise;
  });

  it("closes a Query when the runtime follow-up interrupt Result never arrives", async () => {
    const harness = makeHarness({ receipt: { still_queued: [] } });
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        runtimeFollowupNoOutputTimeoutMs: 10,
        postResultDrainMs: 10,
      },
      silentLogger,
    );

    const noOp = collect(client.runPersistent(
      {
        ...runOptions("runtime follow-up without Result"),
        turnOrigin: { kind: "runtime_followup", id: "delivery-runtime-3" },
      },
      abortSignal(),
    ));
    await harness.nextInput();

    await expect(noOp).resolves.toEqual([]);
    expect(harness.close).toHaveBeenCalledTimes(1);

    const resumed = collect(client.runPersistent(
      { ...runOptions("user after missing Result"), turnOrigin: { kind: "user_message" } },
      abortSignal(),
    ));
    const resumedInput = await harness.nextInput();
    harness.push(sdkResult("sdk-session", resumedInput.uuid, "recreated query response"));
    await expect(resumed).resolves.toContainEqual(
      expect.objectContaining({ type: "complete", result: "recreated query response" }),
    );
    expect(harness.captured).toHaveLength(2);
    await client.close();
  });

  it("lets assistant progress disarm only the runtime-follow-up watchdog", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        persistentTurnInactivityTimeoutMs: 30 * 60_000,
        runtimeFollowupNoOutputTimeoutMs: 10,
      },
      silentLogger,
    );

    const turn = collect(client.runPersistent(
      {
        ...runOptions("runtime follow-up with output"),
        turnOrigin: { kind: "runtime_followup" },
      },
      abortSignal(),
    ));
    const input = await harness.nextInput();
    harness.push(input as SDKMessage);
    harness.push({
      type: "assistant",
      uuid: "assistant-progress",
      session_id: "sdk-session",
      message: {
        id: "assistant-progress",
        model: "claude",
        role: "assistant",
        content: [{ type: "text", text: "working" }],
      },
    } as unknown as SDKMessage);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.interrupt).not.toHaveBeenCalled();
    harness.push(sdkResult("sdk-session", input.uuid, "done"));
    await expect(turn).resolves.toContainEqual(
      expect.objectContaining({ type: "text", text: "working" }),
    );
    await client.close();
  });

  it("keeps local progress ownership across an unrelated named Result", async () => {
    const harness = makeHarness();
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        persistentTurnInactivityTimeoutMs: 30 * 60_000,
        runtimeFollowupNoOutputTimeoutMs: 10,
      },
      silentLogger,
    );

    const turn = collect(client.runPersistent(
      {
        ...runOptions("runtime follow-up with a late detached Result"),
        turnOrigin: { kind: "runtime_followup" },
      },
      abortSignal(),
    ));
    const input = await harness.nextInput();
    harness.push(input as SDKMessage);
    harness.push(sdkResult("sdk-session", "unrelated-input", "late detached"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.push({
      type: "assistant",
      uuid: "assistant-after-detached-result",
      session_id: "sdk-session",
      message: {
        id: "assistant-after-detached-result",
        model: "claude",
        role: "assistant",
        content: [{ type: "text", text: "owned progress" }],
      },
    } as unknown as SDKMessage);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.interrupt).not.toHaveBeenCalled();
    harness.push(sdkResult("sdk-session", input.uuid, "done"));
    await expect(turn).resolves.toContainEqual(
      expect.objectContaining({ type: "text", text: "owned progress" }),
    );
    await client.close();
  });

  it("does not let background task or hook progress disarm the runtime-follow-up watchdog", async () => {
    const harness = makeHarness({ receipt: { still_queued: [] } });
    const client = new ClaudeSdkClient(
      {
        query: harness.queryFn,
        detachedEventSink: harness.detached,
        persistentTurnInactivityTimeoutMs: 30 * 60_000,
        runtimeFollowupNoOutputTimeoutMs: 10,
        postResultDrainMs: 1_000,
      },
      silentLogger,
    );

    const turn = collect(client.runPersistent(
      {
        ...runOptions("runtime follow-up with background progress"),
        turnOrigin: { kind: "runtime_followup", id: "delivery-runtime-progress" },
      },
      abortSignal(),
    ));
    const input = await harness.nextInput();
    harness.push({
      type: "system",
      subtype: "task_progress",
      uuid: "background-task-progress",
      session_id: "sdk-session",
      task_id: "task-1",
      summary: "background task is still running",
    } as unknown as SDKMessage);
    harness.push({
      type: "system",
      subtype: "hook_progress",
      uuid: "background-hook-progress",
      session_id: "sdk-session",
      output: "background hook is still running",
    } as unknown as SDKMessage);
    await vi.waitFor(() => expect(harness.interrupt).toHaveBeenCalledTimes(1));
    harness.push(sdkInterruptedResult("sdk-session", input.uuid));

    await expect(turn).resolves.toContainEqual(
      expect.objectContaining({ type: "progress", text: "background hook is still running" }),
    );
    expect(harness.close).not.toHaveBeenCalled();
    await client.close();
  });

  it("creates a fresh Query after worker restart with the persisted Claude session id", async () => {
    const persistedSessionId = "claude-session-before-worker-crash";
    const restartedHarness = makeHarness();
    const restartedClient = new ClaudeSdkClient(
      {
        query: restartedHarness.queryFn,
        detachedEventSink: restartedHarness.detached,
      },
      silentLogger,
    );

    const resumed = collect(restartedClient.runPersistent(
      {
        ...runOptions("resume pending delivery after restart"),
        resumeSessionId: persistedSessionId,
        maxTurns: 7,
      },
      abortSignal(),
    ));
    const input = await restartedHarness.nextInput();
    restartedHarness.push(sdkInit(persistedSessionId));
    restartedHarness.push(sdkResult(persistedSessionId, input.uuid, "recovered"));

    await expect(resumed).resolves.toContainEqual(
      expect.objectContaining({ type: "complete", result: "recovered" }),
    );
    expect(restartedHarness.captured).toHaveLength(1);
    expect(restartedHarness.captured[0]?.options).toMatchObject({
      resume: persistedSessionId,
    });
    expect(restartedHarness.captured[0]?.options).not.toHaveProperty("maxTurns");
    await restartedClient.close();
  });

  it("reuses a delivery-bound SDK input UUID after a worker restart", async () => {
    const inputUuid = "11111111-1111-5111-8111-111111111111";
    const beforeCrash = makeHarness();
    const firstClient = new ClaudeSdkClient(
      { query: beforeCrash.queryFn, detachedEventSink: beforeCrash.detached },
      silentLogger,
    );
    const firstTurn = collect(firstClient.runPersistent(
      { ...runOptions("delivery before crash"), inputUuid },
      abortSignal(),
    ));
    const firstInput = await beforeCrash.nextInput();
    beforeCrash.push(sdkResult("sdk-session", firstInput.uuid, "accepted"));
    await firstTurn;
    await firstClient.close();

    const afterCrash = makeHarness();
    const secondClient = new ClaudeSdkClient(
      { query: afterCrash.queryFn, detachedEventSink: afterCrash.detached },
      silentLogger,
    );
    const recoveredTurn = collect(secondClient.runPersistent(
      {
        ...runOptions("same durable delivery after restart"),
        inputUuid,
        resumeSessionId: "sdk-session",
      },
      abortSignal(),
    ));
    const recoveredInput = await afterCrash.nextInput();
    afterCrash.push(sdkResult("sdk-session", recoveredInput.uuid, "deduplicated"));
    await recoveredTurn;

    expect(firstInput.uuid).toBe(inputUuid);
    expect(recoveredInput.uuid).toBe(inputUuid);
    await secondClient.close();
  });

  it("clears the foreground timeout when the Query pump fails fatally", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      const client = new ClaudeSdkClient(
        {
          query: harness.queryFn,
          detachedEventSink: harness.detached,
          persistentTurnInactivityTimeoutMs: 30 * 60_000,
        },
        silentLogger,
      );
      const turn = collect(client.runPersistent(
        runOptions("query failure"),
        abortSignal(),
      ));
      await harness.nextInput();
      harness.fail(new Error("query exploded"));

      await expect(turn).rejects.toThrow("query exploded");
      await vi.waitFor(() => {
        expect(harness.detached).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "error",
            fatal: true,
            errorCode: "claude_persistent_query_failed",
          }),
        );
      });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
      expect(harness.interrupt).not.toHaveBeenCalled();
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the foreground timeout when a mapped SDK Result is fatal", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      const client = new ClaudeSdkClient(
        {
          query: harness.queryFn,
          detachedEventSink: harness.detached,
          persistentTurnInactivityTimeoutMs: 30 * 60_000,
          postResultDrainMs: 10,
        },
        silentLogger,
      );
      const turn = collect(client.runPersistent(
        runOptions("fatal result"),
        abortSignal(),
      ));
      const input = await harness.nextInput();
      harness.push({
        ...sdkResult("sdk-session", input.uuid, ""),
        subtype: "error_max_turns",
        is_error: true,
        errors: ["turn failed fatally"],
      } as unknown as SDKMessage);

      await expect(turn).resolves.toContainEqual(
        expect.objectContaining({
          type: "error",
          fatal: true,
        }),
      );
      // The foreground deadline is gone; only the normal post-Result drain
      // timer remains.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(11);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(harness.interrupt).not.toHaveBeenCalled();
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalizes a rejected rate-limit StopFailure without waiting for the foreground timeout", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness();
      const client = new ClaudeSdkClient(
        {
          query: harness.queryFn,
          detachedEventSink: harness.detached,
          persistentTurnInactivityTimeoutMs: 30 * 60_000,
          postResultDrainMs: 10,
        },
        silentLogger,
      );
      const turn = collect(client.runPersistent(
        runOptions("rate-limited turn"),
        abortSignal(),
      ));
      await harness.nextInput();

      harness.push({
        type: "rate_limit_event",
        uuid: "rate-limit-rejected",
        session_id: "sdk-session",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          utilization: 1,
        },
      } as unknown as SDKMessage);
      harness.push({
        type: "assistant",
        uuid: "assistant-rate-limit",
        session_id: "sdk-session",
        error: "rate_limit",
        message: {
          id: "assistant-rate-limit",
          model: "claude",
          role: "assistant",
          content: [{ type: "text", text: "You've hit your usage limit." }],
        },
      } as unknown as SDKMessage);
      await vi.advanceTimersByTimeAsync(0);

      const stopFailureHook =
        harness.captured[0]?.options?.hooks?.StopFailure?.[0]?.hooks[0];
      await stopFailureHook?.(
        {
          hook_event_name: "StopFailure",
          session_id: "sdk-session",
          error: "rate_limit",
        } as never,
        undefined,
        { signal: new AbortController().signal },
      );

      await expect(turn).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "rate_limit",
            status: "rejected",
            rateLimitType: "five_hour",
          }),
          expect.objectContaining({
            type: "assistant_error",
            errorType: "rate_limit",
          }),
          expect.objectContaining({
            type: "text",
            text: "You've hit your usage limit.",
          }),
          expect.objectContaining({
            type: "claude_runtime_hook_event",
            hookEventName: "StopFailure",
          }),
          expect.objectContaining({
            type: "error",
            fatal: true,
            errorCode: "claude_rate_limit_stop_failure",
          }),
        ]),
      );

      // Only the ordinary post-terminal drain remains. The 30-minute
      // foreground watchdog must be gone.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(11);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(harness.interrupt).not.toHaveBeenCalled();

      const resumed = collect(client.runPersistent(
        runOptions("after rate limit"),
        abortSignal(),
      ));
      const resumedInput = await harness.nextInput();
      harness.push(sdkResult("sdk-session", resumedInput.uuid, "resumed"));
      await expect(resumed).resolves.toContainEqual(
        expect.objectContaining({ type: "complete", result: "resumed" }),
      );
      await client.close();
    } finally {
      vi.useRealTimers();
    }
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

    await expect(engine.intervene({ prompt: "too late" })).resolves.toEqual({
      status: "not_delivered",
      mechanism: "interrupt_then_next_turn",
      reason: "not_accepting_input",
    });
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

function sdkAssistantText(uuid: string, text: string): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "sdk-session",
    message: {
      id: uuid,
      model: "claude",
      role: "assistant",
      content: [{ type: "text", text }],
    },
  } as unknown as SDKMessage;
}

function sdkRemoteInput(uuid: string, originKind: string, text: string): SDKMessage {
  return {
    type: "user",
    uuid,
    session_id: "sdk-session",
    parent_tool_use_id: null,
    origin: { kind: originKind },
    message: { role: "user", content: text },
  } as unknown as SDKMessage;
}

function sdkToolResultInput(
  uuid: string,
  originKind: string | undefined,
  toolUseId = "tool-1",
): SDKMessage {
  return {
    type: "user",
    uuid,
    session_id: "sdk-session",
    parent_tool_use_id: null,
    ...(originKind ? { origin: { kind: originKind } } : {}),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "done" }],
    },
  } as unknown as SDKMessage;
}

function sdkAssistantThinking(uuid: string, thinking: string): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "sdk-session",
    message: {
      id: uuid,
      model: "claude",
      role: "assistant",
      content: [{ type: "thinking", thinking }],
    },
  } as unknown as SDKMessage;
}

function sdkAssistantToolStart(uuid: string, toolUseId: string): SDKMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "sdk-session",
    message: {
      id: uuid,
      model: "claude",
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Upload", input: {} }],
    },
  } as unknown as SDKMessage;
}
