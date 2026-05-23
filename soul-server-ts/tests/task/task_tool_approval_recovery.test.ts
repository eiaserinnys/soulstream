import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  buildToolApprovalOptions,
  ToolApprovalRecovery,
} from "../../src/task/task_tool_approval_recovery.js";
import type { Task } from "../../src/task/task_models.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-approval",
    prompt: "approve this",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makeSubject(initialTasks: Task[] = []) {
  const tasks = new Map(initialTasks.map((task) => [task.agentSessionId, task]));
  const loadEvictedTask = vi.fn();
  const rememberTask = vi.fn((task: Task) => {
    tasks.set(task.agentSessionId, task);
  });
  const persistToolApprovalResolved = vi.fn().mockResolvedValue(99);
  const emitSessionUpdated = vi.fn().mockResolvedValue(undefined);
  const logger = { warn: vi.fn() } as unknown as Logger;
  const recovery = new ToolApprovalRecovery({
    getTask: (sessionId) => tasks.get(sessionId),
    loadEvictedTask,
    rememberTask,
    persistToolApprovalResolved,
    emitSessionUpdated,
    logger,
  });

  return {
    recovery,
    tasks,
    loadEvictedTask,
    rememberTask,
    persistToolApprovalResolved,
    emitSessionUpdated,
    logger,
  };
}

describe("buildToolApprovalOptions", () => {
  it("preserves optional approval delivery flags without adding empty keys", () => {
    expect(buildToolApprovalOptions({
      agentSessionId: "sess-approval",
      approvalId: "approval-1",
      decision: "approved",
    })).toEqual({});

    expect(buildToolApprovalOptions({
      agentSessionId: "sess-approval",
      approvalId: "approval-1",
      decision: "rejected",
      message: "no prod write",
      alwaysApprove: false,
      alwaysReject: true,
    })).toEqual({
      message: "no prod write",
      alwaysApprove: false,
      alwaysReject: true,
    });
  });
});

describe("ToolApprovalRecovery.resolveTaskForApproval", () => {
  it("uses an in-memory task without touching evicted hydration", async () => {
    const task = makeTask();
    const { recovery, loadEvictedTask, rememberTask } = makeSubject([task]);

    await expect(recovery.resolveTaskForApproval("sess-approval")).resolves.toBe(task);
    expect(loadEvictedTask).not.toHaveBeenCalled();
    expect(rememberTask).not.toHaveBeenCalled();
  });

  it("hydrates and remembers an evicted task when memory lookup misses", async () => {
    const task = makeTask({
      agentSessionId: "sess-evicted-approval",
      hydratedFromDb: true,
      agentsRunState: "state-v1",
      agentsPendingApprovalId: "approval-1",
    });
    const { recovery, loadEvictedTask, rememberTask, tasks } = makeSubject();
    loadEvictedTask.mockResolvedValueOnce(task);

    await expect(
      recovery.resolveTaskForApproval("sess-evicted-approval"),
    ).resolves.toBe(task);

    expect(loadEvictedTask).toHaveBeenCalledWith("sess-evicted-approval");
    expect(rememberTask).toHaveBeenCalledWith(task);
    expect(tasks.get("sess-evicted-approval")).toBe(task);
  });

  it("returns null when neither memory nor evicted hydration finds a task", async () => {
    const { recovery, loadEvictedTask, rememberTask } = makeSubject();
    loadEvictedTask.mockResolvedValueOnce(null);

    await expect(recovery.resolveTaskForApproval("missing")).resolves.toBeNull();

    expect(loadEvictedTask).toHaveBeenCalledWith("missing");
    expect(rememberTask).not.toHaveBeenCalled();
  });
});

describe("ToolApprovalRecovery.tryQueueAgentsResume", () => {
  it("queues a matching Agents approval decision and resumes after resolved event broadcast", async () => {
    const task = makeTask({
      agentsRunState: "state-v1",
      agentsPendingApprovalId: "approval-1",
    });
    const {
      recovery,
      persistToolApprovalResolved,
      emitSessionUpdated,
    } = makeSubject();
    const onResume = vi.fn();

    const result = await recovery.tryQueueAgentsResume(
      task,
      {
        agentSessionId: "sess-approval",
        approvalId: "approval-1",
        decision: "rejected",
        message: "no prod write",
        alwaysReject: true,
      },
      onResume,
    );

    expect(task.agentsQueuedToolApproval).toEqual({
      approvalId: "approval-1",
      decision: "rejected",
      options: {
        message: "no prod write",
        alwaysReject: true,
      },
    });
    expect(result).toEqual({
      status: "delivered",
      approvalId: "approval-1",
      decision: "rejected",
      eventId: 99,
    });
    expect(persistToolApprovalResolved).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ approvalId: "approval-1" }),
    );
    expect(emitSessionUpdated).toHaveBeenCalledWith(task);
    expect(onResume).toHaveBeenCalledWith(task);
    expect(persistToolApprovalResolved.mock.invocationCallOrder[0])
      .toBeLessThan(emitSessionUpdated.mock.invocationCallOrder[0]);
    expect(emitSessionUpdated.mock.invocationCallOrder[0])
      .toBeLessThan(onResume.mock.invocationCallOrder[0]);
  });

  it("does not queue when approval id does not match the restored pending id", async () => {
    const task = makeTask({
      agentsRunState: "state-v1",
      agentsPendingApprovalId: "approval-1",
    });
    const { recovery, persistToolApprovalResolved, emitSessionUpdated } = makeSubject();
    const onResume = vi.fn();

    await expect(recovery.tryQueueAgentsResume(
      task,
      {
        agentSessionId: "sess-approval",
        approvalId: "other-approval",
        decision: "approved",
      },
      onResume,
    )).resolves.toBeUndefined();

    expect(task.agentsQueuedToolApproval).toBeUndefined();
    expect(persistToolApprovalResolved).not.toHaveBeenCalled();
    expect(emitSessionUpdated).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("does not queue without a resume callback or restored Agents run state", async () => {
    const { recovery, persistToolApprovalResolved } = makeSubject();
    const taskWithoutRunState = makeTask({ agentsPendingApprovalId: "approval-1" });
    const taskWithRunState = makeTask({
      agentsRunState: "state-v1",
      agentsPendingApprovalId: "approval-1",
    });

    await expect(recovery.tryQueueAgentsResume(
      taskWithRunState,
      {
        agentSessionId: "sess-approval",
        approvalId: "approval-1",
        decision: "approved",
      },
      undefined,
    )).resolves.toBeUndefined();

    await expect(recovery.tryQueueAgentsResume(
      taskWithoutRunState,
      {
        agentSessionId: "sess-approval",
        approvalId: "approval-1",
        decision: "approved",
      },
      vi.fn(),
    )).resolves.toBeUndefined();

    expect(persistToolApprovalResolved).not.toHaveBeenCalled();
  });

  it("isolates session_updated broadcast failure and still resumes", async () => {
    const task = makeTask({
      agentsRunState: "state-v1",
      agentsPendingApprovalId: "approval-1",
    });
    const { recovery, emitSessionUpdated, logger } = makeSubject();
    const warn = logger.warn as ReturnType<typeof vi.fn>;
    emitSessionUpdated.mockRejectedValueOnce(new Error("subscriber gone"));
    const onResume = vi.fn();

    const result = await recovery.tryQueueAgentsResume(
      task,
      {
        agentSessionId: "sess-approval",
        approvalId: "approval-1",
        decision: "approved",
      },
      onResume,
    );

    expect(result).toMatchObject({ status: "delivered", eventId: 99 });
    expect(warn).toHaveBeenCalledWith(
      { err: expect.any(Error), sessionId: "sess-approval" },
      "session_updated (tool approval resume) broadcast failed",
    );
    expect(onResume).toHaveBeenCalledWith(task);
  });
});
