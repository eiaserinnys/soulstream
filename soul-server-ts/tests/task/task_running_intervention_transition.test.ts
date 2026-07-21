import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

function makeRunningTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "s1",
    prompt: "original prompt",
    status: "running",
    profileId: "claude-default",
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
  it("publishes acceptance before queueing and interrupting a steer-interrupt engine", async () => {
    const steerActiveTurn = vi.fn().mockResolvedValue({ status: "delivered" });
    const interruptForSteer = vi.fn().mockResolvedValue(true);
    const task = makeRunningTask({
      engine: {
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn,
        interruptForSteer,
      } as unknown as Task["engine"],
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
    });

    await expect(
      transition.deliver(task, {
        text: "redirect the active turn",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      }),
    ).resolves.toEqual({ steered: true, queuePosition: 1 });

    expect(interruptForSteer).toHaveBeenCalledTimes(1);
    expect(steerActiveTurn).not.toHaveBeenCalled();
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "redirect the active turn",
      }),
    );
    expect(task.interventionQueue).toEqual([
      {
        text: "redirect the active turn",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      },
    ]);
  });

  it("keeps the queued steer message when steer interrupt races with turn completion", async () => {
    const interruptForSteer = vi.fn().mockResolvedValue(false);
    const task = makeRunningTask({
      engine: {
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn: vi.fn(),
        interruptForSteer,
      } as unknown as Task["engine"],
    });
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
    });

    await expect(
      transition.deliver(task, { text: "race-safe steer", user: "alice" }),
    ).resolves.toEqual({ queued: true, queuePosition: 1 });

    expect(interruptForSteer).toHaveBeenCalledTimes(1);
    expect(task.interventionQueue).toEqual([{ text: "race-safe steer", user: "alice" }]);
  });

  it("delivers running interventions to a live engine and publishes intervention_sent immediately", async () => {
    const steerActiveTurn = vi.fn().mockResolvedValue({ status: "delivered" });
    const task = makeRunningTask({
      engine: {
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn,
      } as unknown as Task["engine"],
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
    });

    await expect(
      transition.deliver(task, {
        text: "reach the active turn",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      }),
    ).resolves.toEqual({ delivered: true });

    expect(steerActiveTurn).toHaveBeenCalledWith({
      prompt: "reach the active turn\n\n[첨부 파일 로컬 경로: /tmp/a.png]",
      imageAttachmentPaths: ["/tmp/a.png"],
    });
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "reach the active turn",
        attachments: ["/tmp/a.png"],
      }),
    );
    expect(task.interventionQueue).toEqual([]);
  });

  it("retries one transient live-steer boundary before falling back", async () => {
    const steerActiveTurn = vi
      .fn()
      .mockResolvedValueOnce({ status: "not_accepting_input" })
      .mockResolvedValueOnce({ status: "delivered" });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const task = makeRunningTask({
      engine: {
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn,
      } as unknown as Task["engine"],
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      liveRetryDelayMs: 25,
      sleep,
    });

    await expect(
      transition.deliver(task, { text: "safe boundary", user: "alice" }),
    ).resolves.toEqual({ delivered: true });

    expect(sleep).toHaveBeenCalledWith(25);
    expect(steerActiveTurn).toHaveBeenCalledTimes(2);
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "intervention_sent", text: "safe boundary" }),
    );
    expect(task.interventionQueue).toEqual([]);
  });

  it("falls back to the next-turn queue when transient live-steer boundary remains unsafe", async () => {
    const steerActiveTurn = vi
      .fn()
      .mockResolvedValueOnce({ status: "no_active_turn" })
      .mockResolvedValueOnce({ status: "not_accepting_input" });
    const task = makeRunningTask({
      engine: {
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn,
      } as unknown as Task["engine"],
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      liveRetryDelayMs: 0,
    });

    await expect(
      transition.deliver(task, { text: "queue after unsafe boundary", user: "alice" }),
    ).resolves.toEqual({ queued: true, queuePosition: 1 });

    expect(steerActiveTurn).toHaveBeenCalledTimes(2);
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "queue after unsafe boundary",
      }),
    );
    expect(task.interventionQueue).toEqual([
      { text: "queue after unsafe boundary", user: "alice" },
    ]);
  });

  it("falls back to the next-turn queue when the engine has no live delivery surface", async () => {
    const task = makeRunningTask();
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
    });

    await expect(
      transition.deliver(task, {
        text: "next turn only",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      }),
    ).resolves.toEqual({ queued: true, queuePosition: 1 });

    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "intervention_sent",
        text: "next turn only",
      }),
    );
    expect(task.interventionQueue).toEqual([
      {
        text: "next turn only",
        user: "alice",
        attachmentPaths: ["/tmp/a.png"],
      },
    ]);
  });

  it("preserves FIFO order and message metadata for the next query turn", async () => {
    const task = makeRunningTask({
      interventionQueue: [{ text: "first", user: "bob" }],
    });
    const callerInfo = { source: "slack", display_name: "Alice" };
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(),
      logger: silentLogger,
    });

    await expect(
      transition.deliver(task, {
        text: "second",
        user: "alice",
        callerInfo,
        attachmentPaths: ["/tmp/a.png", "/tmp/a.pdf"],
        context: [{ title: "trace", body: "line 1" }],
      }),
    ).resolves.toEqual({ queued: true, queuePosition: 2 });

    expect(task.interventionQueue).toEqual([
      { text: "first", user: "bob" },
      {
        text: "second",
        user: "alice",
        callerInfo,
        attachmentPaths: ["/tmp/a.png", "/tmp/a.pdf"],
        context: [{ title: "trace", body: "line 1" }],
      },
    ]);
  });

  it("can defer durable callers without mutating the queue", async () => {
    const task = makeRunningTask();
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
    });

    await expect(
      transition.deliver(
        task,
        { text: "durable caller will retry", user: "alice" },
        { queueIfUndelivered: false },
      ),
    ).resolves.toEqual({ deferred: true });

    expect(task.interventionQueue).toEqual([]);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("does not deliver or queue an accepted intervention when persistence fails", async () => {
    const steerActiveTurn = vi.fn().mockResolvedValue({ status: "delivered" });
    const task = makeRunningTask({
      engine: {
        backendId: "codex",
        workspaceDir: "/tmp/codex",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn,
      } as unknown as Task["engine"],
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      persistence: {
        persistEvent: vi.fn().mockRejectedValue(new Error("events DB unavailable")),
        handleSideEffects: vi.fn(),
      } as never,
    });

    await expect(
      transition.deliver(task, { text: "must be durable", user: "alice" }),
    ).rejects.toThrow("events DB unavailable");

    expect(steerActiveTurn).not.toHaveBeenCalled();
    expect(task.interventionQueue).toEqual([]);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("defer durable callers after a transient live-steer retry still cannot deliver", async () => {
    const steerActiveTurn = vi
      .fn()
      .mockResolvedValueOnce({ status: "not_accepting_input" })
      .mockResolvedValueOnce({ status: "no_active_turn" });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const task = makeRunningTask({
      engine: {
        backendId: "claude",
        workspaceDir: "/tmp/claude",
        async *execute(): AsyncIterable<never> {},
        async interrupt() { return true; },
        async close() {},
        steerActiveTurn,
      } as unknown as Task["engine"],
    });
    const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
    const transition = new RunningInterventionTransition({
      broadcaster: makeBroadcaster(emitEventEnvelope),
      logger: silentLogger,
      liveRetryDelayMs: 10,
      sleep,
    });

    await expect(
      transition.deliver(
        task,
        { text: "durable retry after boundary", user: "alice" },
        { queueIfUndelivered: false },
      ),
    ).resolves.toEqual({ deferred: true });

    expect(sleep).toHaveBeenCalledWith(10);
    expect(steerActiveTurn).toHaveBeenCalledTimes(2);
    expect(task.interventionQueue).toEqual([]);
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });
});
