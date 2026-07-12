import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import { buildSupervisorWakeText } from "../../src/supervisor/wake_text.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeMocks(options: {
  sourceNode?: string;
  supervisorWakeScheduler?: { ingest(eventType: string): Promise<{ scheduled: boolean }> };
} = {}) {
  const updateSession = vi.fn().mockResolvedValue(undefined);
  const appendEvent = vi.fn().mockResolvedValue(8);
  const appendSupervisorEvent = vi.fn().mockResolvedValue({
    offset: 1,
    inserted: true,
    contiguousUpto: 8,
    highestSeenEventId: 8,
    gapStart: null,
    gapEnd: null,
  });
  const db = { updateSession, appendEvent, appendSupervisorEvent } as unknown as SessionDB;

  const emitSessionUpdated = vi.fn().mockResolvedValue(undefined);
  const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
  const broadcaster = { emitSessionUpdated, emitEventEnvelope } as unknown as SessionBroadcaster;

  const transition = new TaskLifecycleTransition({
    db,
    broadcaster,
    logger: silentLogger,
    sourceNode: options.sourceNode,
    supervisorWakeScheduler: options.supervisorWakeScheduler,
  });

  return {
    transition,
    updateSession,
    appendEvent,
    appendSupervisorEvent,
    emitSessionUpdated,
    emitEventEnvelope,
  };
}

describe("TaskLifecycleTransition.cancelRunningTask", () => {
  it("marks running tasks interrupted before calling engine.interrupt", async () => {
    const { transition } = makeMocks();
    const task = makeTask();
    const interrupt = vi.fn(async () => {
      expect(task.status).toBe("interrupted");
      return true;
    });
    task.engine = { interrupt } as unknown as EnginePort;

    await expect(transition.cancelRunningTask(task)).resolves.toBe(true);

    expect(task.status).toBe("interrupted");
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("returns false without mutation when task is missing, terminal, or has no engine", async () => {
    const { transition } = makeMocks();
    const terminal = makeTask({ status: "completed" });
    terminal.engine = { interrupt: vi.fn() } as unknown as EnginePort;
    const noEngine = makeTask();

    await expect(transition.cancelRunningTask(undefined)).resolves.toBe(false);
    await expect(transition.cancelRunningTask(terminal)).resolves.toBe(false);
    await expect(transition.cancelRunningTask(noEngine)).resolves.toBe(false);

    expect(terminal.status).toBe("completed");
    expect(noEngine.status).toBe("running");
  });
});

describe("TaskLifecycleTransition.finalizeExternalTask", () => {
  it("records completed result, usage, and final-state side effects", async () => {
    const { transition, updateSession, emitSessionUpdated } = makeMocks();
    const task = makeTask();

    const result = await transition.finalizeExternalTask(task, {
      result: "done",
      llmUsage: { input_tokens: 1, output_tokens: 2 },
    });

    expect(result).toBe(task);
    expect(task.status).toBe("completed");
    expect(task.result).toBe("done");
    expect(task.error).toBeUndefined();
    expect(task.llmUsage).toEqual({ input_tokens: 1, output_tokens: 2 });
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(updateSession).toHaveBeenCalledWith("sess-1", {
      status: "completed",
      last_event_id: 8,
      termination_reason: "completed_ok",
      termination_detail: null,
      review_state: "not_required",
    });
    expect(emitSessionUpdated).toHaveBeenCalledWith(task);
    expect(emitSessionUpdated).toHaveBeenCalledTimes(1);
    expect(emitSessionUpdated.mock.invocationCallOrder[0]).toBeGreaterThan(
      updateSession.mock.invocationCallOrder[0],
    );
  });

  it("emits session_ended once when finalizing a completed task", async () => {
    const { transition, appendEvent, emitEventEnvelope } = makeMocks();
    const task = makeTask();

    await transition.finalizeExternalTask(task, { result: "done" });
    await transition.persistExecutorFinalState(task);

    expect(task.terminationReason).toBe("completed_ok");
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledWith({
      sessionId: "sess-1",
      eventType: "session_ended",
      payload: expect.stringContaining('"termination_reason":"completed_ok"'),
      searchableText: "",
      createdAt: task.completedAt,
    });
    expect(emitEventEnvelope).toHaveBeenCalledTimes(1);
    expect(emitEventEnvelope).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "session_ended",
        status: "completed",
        termination_reason: "completed_ok",
        _event_id: 8,
      }),
    );
  });

  it("routes session_ended into supervisor wake text with session summary", async () => {
    const supervisorWakeScheduler = {
      ingest: vi.fn(async () => ({ scheduled: true })),
    };
    const { transition, appendSupervisorEvent } = makeMocks({
      sourceNode: "node-1",
      supervisorWakeScheduler,
    });
    const task = makeTask();

    await transition.finalizeExternalTask(task, { result: "done" });
    const supervisorEvent = appendSupervisorEvent.mock.calls[0]?.[0];
    const wakeText = buildSupervisorWakeText({
      supervisorId: "ariela_codex",
      wakeClass: "wake",
      events: [
        {
          offset: 1,
          sourceSessionId: supervisorEvent.sourceSessionId,
          eventType: supervisorEvent.eventType,
          payload: supervisorEvent.payload,
        },
      ],
      sessions: {
        "sess-1": {
          sessionId: "sess-1",
          title: "Finished task",
          status: "completed",
          awaySummary: "Completed after checking the queue.",
        },
      },
    });

    expect(appendSupervisorEvent).toHaveBeenCalledWith({
      sourceNode: "node-1",
      sourceSessionId: "sess-1",
      sourceEventId: 8,
      eventType: "session_ended",
      payload: expect.objectContaining({
        type: "session_ended",
        status: "completed",
        termination_reason: "completed_ok",
        _event_id: 8,
      }),
      createdAt: task.completedAt,
    });
    expect(supervisorWakeScheduler.ingest).toHaveBeenCalledWith("session_ended");
    expect(wakeText).toContain("최근: Completed after checking the queue.");
  });

  it("lets completed_ok outrank a prior limit_hit hint", async () => {
    const { transition, updateSession } = makeMocks();
    const task = makeTask({
      pendingTerminationHint: "limit_hit",
      pendingTerminationDetail: "rate limited once",
    });

    await transition.finalizeExternalTask(task, { result: "done" });

    expect(task.terminationReason).toBe("completed_ok");
    expect(updateSession).toHaveBeenCalledWith("sess-1", {
      status: "completed",
      last_event_id: 8,
      termination_reason: "completed_ok",
      termination_detail: null,
      review_state: "not_required",
    });
  });

  it("records error result and clears stale completed result", async () => {
    const { transition, updateSession } = makeMocks();
    const task = makeTask({ result: "old" });

    await transition.finalizeExternalTask(task, { error: "boom" });

    expect(task.status).toBe("error");
    expect(task.error).toBe("boom");
    expect(task.result).toBeUndefined();
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(updateSession).toHaveBeenCalledWith("sess-1", {
      status: "error",
      last_event_id: 8,
      termination_reason: "unknown",
      termination_detail: null,
      review_state: "not_required",
    });
  });

  it("marks every human-owned terminal result as needs_review", async () => {
    const { transition, updateSession, emitSessionUpdated } = makeMocks();
    const task = makeTask({
      reviewRequired: true,
      reviewState: "acknowledged",
    });

    await transition.finalizeExternalTask(task, { result: "new result" });

    expect(task.reviewState).toBe("needs_review");
    expect(updateSession).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ review_state: "needs_review" }),
    );
    expect(emitSessionUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ reviewState: "needs_review" }),
    );
  });

  it("does not reopen an acknowledged review when finalization is retried", async () => {
    const { transition, updateSession, emitSessionUpdated } = makeMocks();
    const task = makeTask({
      status: "completed",
      completedAt: new Date("2026-05-23T01:05:00.000Z"),
      terminationReason: "completed_ok",
      terminationDetail: null,
      reviewRequired: true,
      reviewState: "acknowledged",
    });

    await transition.persistExecutorFinalState(task);

    expect(task.reviewState).toBe("acknowledged");
    expect(updateSession).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ review_state: "acknowledged" }),
    );
    expect(emitSessionUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ reviewState: "acknowledged" }),
    );
  });

  it("uses pending termination hints by precedence for non-completed final states", async () => {
    const { transition, updateSession } = makeMocks();
    const task = makeTask({
      pendingTerminationHint: "limit_hit",
      pendingTerminationDetail: "rate limit",
    });

    await transition.finalizeExternalTask(task, { error: "boom" });

    expect(task.terminationReason).toBe("limit_hit");
    expect(updateSession).toHaveBeenCalledWith("sess-1", {
      status: "error",
      last_event_id: 8,
      termination_reason: "limit_hit",
      termination_detail: "rate limit",
      review_state: "not_required",
    });
  });
});

describe("TaskLifecycleTransition.persistExecutorFinalState", () => {
  it("persists and broadcasts the existing final status without mutating it", async () => {
    const { transition, updateSession, emitSessionUpdated } = makeMocks();
    const completedAt = new Date("2026-05-23T01:05:00.000Z");
    const task = makeTask({ status: "interrupted", completedAt });

    await transition.persistExecutorFinalState(task);

    expect(task.status).toBe("interrupted");
    expect(task.completedAt).toBe(completedAt);
    expect(updateSession).toHaveBeenCalledWith("sess-1", {
      status: "interrupted",
      last_event_id: 8,
      termination_reason: "unknown",
      termination_detail: null,
      review_state: "not_required",
    });
    expect(emitSessionUpdated).toHaveBeenCalledWith(task);
  });

  it("isolates final-state DB and broadcast failures", async () => {
    const { transition, updateSession, emitSessionUpdated } = makeMocks();
    updateSession.mockRejectedValueOnce(new Error("db down"));
    emitSessionUpdated.mockRejectedValueOnce(new Error("ws down"));
    const task = makeTask({ status: "completed" });

    await expect(transition.persistExecutorFinalState(task)).resolves.toBeUndefined();

    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(emitSessionUpdated).toHaveBeenCalledTimes(1);
  });
});

describe("TaskLifecycleTransition shutdown/delete interrupt helpers", () => {
  it("marks running tasks interrupted for shutdown and persists that state", async () => {
    const { transition, updateSession, emitSessionUpdated } = makeMocks();
    const task = makeTask();
    const shutdownAt = new Date("2026-05-23T01:10:00.000Z");

    await transition.markRunningTaskInterruptedForShutdown(task, shutdownAt);

    expect(task.status).toBe("interrupted");
    expect(task.completedAt).toBe(shutdownAt);
    expect(updateSession).toHaveBeenCalledWith("sess-1", {
      status: "interrupted",
      last_event_id: 8,
      termination_reason: "killed",
      termination_detail: "shutdown",
      review_state: "not_required",
    });
    expect(emitSessionUpdated).toHaveBeenCalledWith(task);
  });

  it("does not mutate terminal tasks during shutdown interrupt preparation", async () => {
    const { transition, updateSession, emitSessionUpdated } = makeMocks();
    const completedAt = new Date("2026-05-23T01:05:00.000Z");
    const task = makeTask({ status: "completed", completedAt });

    await transition.markRunningTaskInterruptedForShutdown(task, new Date());

    expect(task.status).toBe("completed");
    expect(task.completedAt).toBe(completedAt);
    expect(updateSession).not.toHaveBeenCalled();
    expect(emitSessionUpdated).not.toHaveBeenCalled();
  });

  it("delete interrupt helper waits for drain and isolates interrupt/drain failures", async () => {
    const { transition } = makeMocks();
    const task = makeTask({
      executionPromise: Promise.reject(new Error("drain rejected")),
    });
    const interrupt = vi.fn().mockRejectedValue(new Error("already closed"));
    task.engine = { interrupt } as unknown as EnginePort;

    await expect(transition.interruptAndDrain(task)).resolves.toBeUndefined();

    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("shutdown interrupt helper lets callers collect drain without awaiting it", async () => {
    const { transition } = makeMocks();
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const task = makeTask({ executionPromise: drain });
    const interrupt = vi.fn().mockResolvedValue(true);
    task.engine = { interrupt } as unknown as EnginePort;

    await transition.interruptForShutdown(task);
    const drainPromise = transition.getDrainPromise(task);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(drainPromise).toBeDefined();
    releaseDrain();
    await expect(drainPromise).resolves.toBeUndefined();
  });
});
