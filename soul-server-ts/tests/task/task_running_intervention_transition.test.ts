import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EventPersistence } from "../../src/db/event_persistence.js";
import {
  ClaudeEngineAdapter,
  type ClaudeClient,
  type ClaudeClientEvent,
} from "../../src/engine/claude_adapter.js";
import type {
  EnginePort,
  SupportsLiveTurnSteering,
} from "../../src/engine/protocol.js";
import { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

function makeRunningTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "s1",
    prompt: "original prompt",
    status: "running",
    profileId: "codex-default",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 3,
    interventionQueue: [],
    ...overrides,
  };
}

function makeBroadcaster(
  emitEventEnvelope = vi.fn().mockResolvedValue(undefined),
): SessionBroadcaster {
  return { emitEventEnvelope } as unknown as SessionBroadcaster;
}

describe("RunningInterventionTransition", () => {
  it("ClaudeEngineAdapter live steering delivered → intervention_sent 유지 + queue 없음", async () => {
    const release = deferred<void>();
    const steered: unknown[] = [];
    const client: ClaudeClient = {
      async *run(): AsyncIterable<ClaudeClientEvent> {
        yield { type: "session", sessionId: "claude-sess-live" };
        await release.promise;
        yield { type: "complete" };
      },
      steerActiveTurn(input) {
        steered.push(input);
        return true;
      },
    };
    const engine = new ClaudeEngineAdapter(
      { workspaceDir: "/tmp/claude", client, processEnv: {} },
      silentLogger,
    );
    const iterator = engine.execute({ prompt: "hi" })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "session", session_id: "claude-sess-live" },
    });

    const task = makeRunningTask({ engine });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
    });

    await expect(
      transition.deliver(task, {
        text: "지금 반영",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      }),
    ).resolves.toEqual({ delivered: true });

    expect(task.interventionQueue).toEqual([]);
    expect(steered).toEqual([
      {
        prompt: "지금 반영",
        imageAttachmentPaths: ["/tmp/a.png"],
      },
    ]);
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "지금 반영",
      }),
    );

    release.resolve();
    await collectIterator(iterator);
  });

  it("persists and broadcasts intervention_sent before live steering; delivered skips fallback queue", async () => {
    const order: string[] = [];
    const callerInfo = { source: "slack", display_name: "Alice" };
    const steerActiveTurn = vi.fn(async (input) => {
      order.push("steerActiveTurn");
      expect(input).toEqual({
        prompt: "focus on the failing test",
        imageAttachmentPaths: ["/tmp/a.png"],
      });
      return { status: "delivered" as const };
    });
    const task = makeRunningTask({
      engine: {
        backendId: "codex",
        workspaceDir: "/tmp/codex",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn,
      } as EnginePort & SupportsLiveTurnSteering,
    });

    const persistEvent = vi.fn(async (_sessionId, event) => {
      order.push("persistEvent");
      expect(event).toMatchObject({
        type: "intervention_sent",
        user: "alice",
        text: "focus on the failing test",
        caller_info: callerInfo,
        attachments: ["/tmp/a.png"],
      });
      expect(typeof (event as Record<string, unknown>).timestamp).toBe("number");
      expect((event as Record<string, unknown>)._event_id).toBeUndefined();
      return 222;
    });
    const handleSideEffects = vi.fn(async (_sessionId, event, handledTask) => {
      order.push("handleSideEffects");
      expect(handledTask).toBe(task);
      expect(task.lastEventId).toBe(222);
      expect((event as Record<string, unknown>)._event_id).toBe(222);
    });
    const persistence = { persistEvent, handleSideEffects } as unknown as EventPersistence;
    const emitEventEnvelope = vi.fn(async (_sessionId, event) => {
      order.push("emitEventEnvelope");
      expect(event).toMatchObject({
        type: "intervention_sent",
        user: "alice",
        text: "focus on the failing test",
        caller_info: callerInfo,
        attachments: ["/tmp/a.png"],
        _event_id: 222,
      });
      expect(typeof (event as Record<string, unknown>).timestamp).toBe("number");
    });

    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence,
    });

    await expect(
      transition.deliver(task, {
        text: "focus on the failing test",
        user: "alice",
        callerInfo,
        attachmentPaths: ["/tmp/a.png"],
      }),
    ).resolves.toEqual({ delivered: true });

    expect(order).toEqual([
      "persistEvent",
      "handleSideEffects",
      "emitEventEnvelope",
      "steerActiveTurn",
    ]);
    expect(task.interventionQueue).toEqual([]);
  });

  it("returns queued fallback with liveSteerStatus when live steering is not delivered", async () => {
    const steerActiveTurn = vi.fn().mockResolvedValue({
      status: "no_active_turn",
      message: "active turn missing",
    });
    const task = makeRunningTask({
      engine: {
        backendId: "codex",
        workspaceDir: "/tmp/codex",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn,
      } as EnginePort & SupportsLiveTurnSteering,
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
    });

    await expect(
      transition.deliver(task, { text: "queue me", user: "alice" }),
    ).resolves.toEqual({
      queued: true,
      queuePosition: 1,
      liveSteerStatus: "no_active_turn",
    });

    expect(emitEventEnvelope).toHaveBeenCalledTimes(1);
    expect(steerActiveTurn).toHaveBeenCalledWith({ prompt: "queue me" });
    expect(task.interventionQueue).toEqual([{ text: "queue me", user: "alice" }]);
  });

  it("keeps intervention_sent visible and queues when Claude is not accepting live input", async () => {
    const steerActiveTurn = vi.fn().mockResolvedValue({
      status: "not_accepting_input",
      message: "Claude active input is not accepting steering",
    });
    const task = makeRunningTask({
      engine: {
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn,
      } as EnginePort & SupportsLiveTurnSteering,
    });
    const persistEvent = vi.fn().mockResolvedValue(444);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence: {
        persistEvent,
        handleSideEffects,
      } as unknown as EventPersistence,
    });

    await expect(
      transition.deliver(task, { text: "wait until tool result", user: "alice" }),
    ).resolves.toEqual({
      queued: true,
      queuePosition: 1,
      liveSteerStatus: "not_accepting_input",
    });

    expect(persistEvent).toHaveBeenCalledTimes(1);
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "wait until tool result",
        _event_id: 444,
      }),
    );
    expect(task.interventionQueue).toEqual([
      { text: "wait until tool result", user: "alice" },
    ]);
  });

  it("can defer running fallback without persisting or using the in-memory queue", async () => {
    const steerActiveTurn = vi.fn().mockResolvedValue({
      status: "no_active_turn",
      message: "active turn missing",
    });
    const task = makeRunningTask({
      engine: {
        backendId: "codex",
        workspaceDir: "/tmp/codex",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn,
      } as EnginePort & SupportsLiveTurnSteering,
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const persistEvent = vi.fn().mockResolvedValue(333);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence: {
        persistEvent,
        handleSideEffects: vi.fn().mockResolvedValue(undefined),
      } as unknown as EventPersistence,
    });

    await expect(
      transition.deliver(
        task,
        { text: "scheduler prompt", user: "Soulstream Scheduler" },
        { queueIfUndelivered: false },
      ),
    ).resolves.toEqual({
      deferred: true,
      liveSteerStatus: "no_active_turn",
    });

    expect(steerActiveTurn).toHaveBeenCalledWith({ prompt: "scheduler prompt" });
    expect(task.interventionQueue).toEqual([]);
    expect(persistEvent).not.toHaveBeenCalled();
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("queues without liveSteerStatus when the engine has no live steering capability", async () => {
    const task = makeRunningTask({
      interventionQueue: [{ text: "already queued", user: "bob" }],
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
    });

    await expect(
      transition.deliver(task, { text: "second", user: "alice" }),
    ).resolves.toEqual({ queued: true, queuePosition: 2 });

    expect(task.interventionQueue).toEqual([
      { text: "already queued", user: "bob" },
      { text: "second", user: "alice" },
    ]);
    expect(emitEventEnvelope).toHaveBeenCalledTimes(1);
    const event = emitEventEnvelope.mock.calls[0][1] as Record<string, unknown>;
    expect(event).toMatchObject({
      type: "intervention_sent",
      user: "alice",
      text: "second",
    });
    expect(typeof event.timestamp).toBe("number");
    expect(event.caller_info).toBeUndefined();
    expect(event.attachments).toBeUndefined();
  });

  it("isolates persistence failure and still broadcasts, steers, and queues failed live steering", async () => {
    const steerActiveTurn = vi.fn().mockRejectedValue(new Error("steer down"));
    const task = makeRunningTask({
      engine: {
        backendId: "codex",
        workspaceDir: "/tmp/codex",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn,
      } as EnginePort & SupportsLiveTurnSteering,
    });
    const persistEvent = vi.fn().mockRejectedValue(new Error("events db down"));
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { persistEvent, handleSideEffects } as unknown as EventPersistence;
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence,
    });

    await expect(
      transition.deliver(task, { text: "fallback", user: "alice" }),
    ).resolves.toEqual({
      queued: true,
      queuePosition: 1,
      liveSteerStatus: "failed",
    });

    expect(handleSideEffects).not.toHaveBeenCalled();
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.not.objectContaining({ _event_id: expect.anything() }),
    );
    expect(steerActiveTurn).toHaveBeenCalledTimes(1);
    expect(task.interventionQueue).toEqual([{ text: "fallback", user: "alice" }]);
  });

  it("isolates broadcast failure and still queues the intervention", async () => {
    const task = makeRunningTask();
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(vi.fn().mockRejectedValue(new Error("ws down"))),
      logger: silentLogger,
    });

    await expect(
      transition.deliver(task, { text: "keep going", user: "alice" }),
    ).resolves.toEqual({ queued: true, queuePosition: 1 });
    expect(task.interventionQueue).toEqual([{ text: "keep going", user: "alice" }]);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function collectIterator<T>(iterator: AsyncIterator<T>): Promise<T[]> {
  const items: T[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return items;
    items.push(next.value);
  }
}
