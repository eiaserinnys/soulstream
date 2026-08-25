import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EventPersistence } from "../../src/db/event_persistence.js";
import { attachClaudeBackgroundProvenance } from
  "../../src/engine/claude_background_provenance.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { TaskEngineEventPublisher } from "../../src/task/task_engine_event_publisher.js";
import type { Task } from "../../src/task/task_models.js";
import { TransientEventLogAggregator } from
  "../../src/task/transient_event_log_aggregator.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: "agent-1",
    createdAt: new Date(),
    lastEventId: 7,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}

function makePublisherDeps() {
  const enqueueEvent = vi.fn(async () => ({ source_seq: 42 }));
  const handleSideEffects = vi.fn(async () => undefined);
  const persistence = {
    enqueueEvent,
    handleSideEffects,
  } as unknown as EventPersistence;

  const emitEventEnvelope = vi.fn(async () => undefined);
  const broadcaster = {
    emitEventEnvelope,
  } as unknown as SessionBroadcaster;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;

  return {
    broadcaster,
    emitEventEnvelope,
    handleSideEffects,
    logger,
    enqueueEvent,
    persistence,
  };
}

describe("TaskEngineEventPublisher", () => {
  it("enqueues a persistent event without worker broadcast, then runs side effects", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();
    const event = {
      type: "assistant_message",
      content: "hello",
      timestamp: 1,
    } as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(deps.enqueueEvent).toHaveBeenCalledWith("sess-1", event, undefined);
    expect(task.lastEventId).toBe(7);
    expect((event as Record<string, unknown>)._event_id).toBeUndefined();
    expect(deps.emitEventEnvelope).not.toHaveBeenCalled();
    expect(deps.handleSideEffects).toHaveBeenCalledWith("sess-1", event, task);
    expect(deps.enqueueEvent.mock.invocationCallOrder[0]).toBeLessThan(
      deps.handleSideEffects.mock.invocationCallOrder[0],
    );
    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  it("carries semantic dedupe through durable ingress and clears the internal field", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({ lastEventId: 99 });
    const event = {
      type: "assistant_message",
      content: "resume replay",
      timestamp: 1,
      _dedupe_key: "claude-sdk:assistant:msg-1:0",
    } as unknown as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(task.lastEventId).toBe(99);
    expect((event as Record<string, unknown>)._event_id).toBeUndefined();
    expect((event as Record<string, unknown>)._dedupe_key).toBeUndefined();
    expect(deps.emitEventEnvelope).not.toHaveBeenCalled();
    expect(deps.handleSideEffects).toHaveBeenCalledWith("sess-1", event, task);
  });

  it("captures only the first session id and still publishes every session event", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();

    await publisher.publishEngineEvent(task, {
      type: "session",
      session_id: "thr-first",
    } as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "session",
      session_id: "thr-second",
    } as SSEEventPayload);

    expect(task.codexThreadId).toBe("thr-first");
    expect(deps.enqueueEvent).toHaveBeenCalledTimes(2);
    expect(deps.enqueueEvent.mock.calls.map((call) => call[2])).toEqual([
      { kind: "set_backend_session_id", backend_session_id: "thr-first" },
      undefined,
    ]);
    expect(deps.emitEventEnvelope).not.toHaveBeenCalled();
    expect(deps.handleSideEffects).toHaveBeenCalledTimes(2);
    expect(task.lastEventId).toBe(7);
  });

  it("persists the backend session id as an atomic ingress effect", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();
    const event = {
      type: "session",
      session_id: "thr-first",
    } as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(task.codexThreadId).toBe("thr-first");
    expect(deps.enqueueEvent).toHaveBeenCalledWith("sess-1", event, {
      kind: "set_backend_session_id",
      backend_session_id: "thr-first",
    });
    expect(deps.emitEventEnvelope).not.toHaveBeenCalled();
    expect(deps.handleSideEffects).toHaveBeenCalledWith("sess-1", event, task);
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it("broadcasts live-only events without persistence or lastEventId changes", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({ lastEventId: 99 });
    const event = {
      type: "text_delta",
      text: "live",
      timestamp: 1,
      _live_only: true,
    } as unknown as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(deps.enqueueEvent).not.toHaveBeenCalled();
    expect(task.lastEventId).toBe(99);
    expect((event as Record<string, unknown>)._event_id).toBeUndefined();
    expect(deps.emitEventEnvelope).toHaveBeenCalledWith("sess-1", event);
    expect(deps.handleSideEffects).toHaveBeenCalledWith("sess-1", event, task);
  });

  it("aggregates transient broadcast activity into one periodic info log", async () => {
    vi.useFakeTimers();
    try {
      const deps = makePublisherDeps();
      const transientEventLogAggregator = new TransientEventLogAggregator(deps.logger);
      const publishers = [
        new TaskEngineEventPublisher({ ...deps, transientEventLogAggregator }),
        new TaskEngineEventPublisher({ ...deps, transientEventLogAggregator }),
      ];
      const tasks = [makeTask(), makeTask(), makeTask({ agentSessionId: "sess-2" })];

      for (const [index, task] of tasks.entries()) {
        await publishers[index % publishers.length]!.publishEngineEvent(task, {
          type: "text_delta",
          text: `chunk-${index}`,
          timestamp: index,
          _live_only: true,
        } as unknown as SSEEventPayload);
      }

      expect(deps.logger.info).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(deps.logger.info).toHaveBeenCalledTimes(1);
      expect(deps.logger.info).toHaveBeenCalledWith(
        {
          windowMs: 30_000,
          dispatched: 3,
          completed: 3,
          failed: 0,
          sessionCount: 2,
        },
        "emitEventEnvelope activity summary",
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("propagates durable enqueue failure without broadcasting or side effects", async () => {
    const deps = makePublisherDeps();
    deps.enqueueEvent.mockRejectedValueOnce(new Error("events db down"));
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({ lastEventId: 10 });
    const event = {
      type: "complete",
      usage: {},
      timestamp: 2,
    } as SSEEventPayload;

    await expect(publisher.publishEngineEvent(task, event)).rejects.toThrow("events db down");

    expect(task.lastEventId).toBe(10);
    expect((event as Record<string, unknown>)._event_id).toBeUndefined();
    expect(deps.emitEventEnvelope).not.toHaveBeenCalled();
    expect(deps.handleSideEffects).not.toHaveBeenCalled();
  });


  it("records a rejected credential_alert as a pending limit_hit termination hint only", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();

    await publisher.publishEngineEvent(task, {
      type: "credential_alert",
      status: "rejected",
      message: "rate limit",
      timestamp: 2,
    } as unknown as SSEEventPayload);

    expect(task.status).toBe("running");
    expect(task.pendingTerminationHint).toBe("limit_hit");
    expect(task.pendingTerminationDetail).toBe("rate limit");
    expect(task.terminationReason).toBeUndefined();
  });

  it("keeps an allowed credential warning observational", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();

    await publisher.publishEngineEvent(task, {
      type: "credential_alert",
      status: "allowed_warning",
      utilization: 0.94,
      timestamp: 2,
    } as unknown as SSEEventPayload);

    expect(task.status).toBe("running");
    expect(task.pendingTerminationHint).toBeUndefined();
    expect(task.terminationReason).toBeUndefined();
  });

  it("publishes duplicate fatal errors without mutating session failure state", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({ result: "completed result" });
    const event = {
      type: "error",
      message: "backend died",
      error_code: "provider_shutdown",
      timestamp: 2,
    } as unknown as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);
    await publisher.publishEngineEvent(task, event);

    expect(task.status).toBe("running");
    expect(task.error).toBeUndefined();
    expect(task.result).toBe("completed result");
    expect(task.pendingTerminationHint).toBeUndefined();
    expect(task.pendingTerminationDetail).toBeUndefined();
    expect(task.terminationReason).toBeUndefined();
  });

  it("isolates broadcast failure and still runs side effects", async () => {
    vi.useFakeTimers();
    try {
      const deps = makePublisherDeps();
      deps.emitEventEnvelope.mockRejectedValueOnce(new Error("upstream down"));
      const publisher = new TaskEngineEventPublisher(deps);
      const task = makeTask();
      const event = {
        type: "text_delta",
        text: "hello",
        timestamp: 1,
      } as SSEEventPayload;

      await publisher.publishEngineEvent(task, event);

      expect(deps.handleSideEffects).toHaveBeenCalledWith("sess-1", event, task);
      expect(deps.logger.warn).toHaveBeenCalledWith(
        {
          err: expect.any(Error),
          sessionId: "sess-1",
          eventType: "text_delta",
        },
        "emitEventEnvelope failed",
      );
      expect(deps.logger.info).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(deps.logger.info).toHaveBeenCalledWith(
        {
          windowMs: 30_000,
          dispatched: 1,
          completed: 0,
          failed: 1,
          sessionCount: 1,
        },
        "emitEventEnvelope activity summary",
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("isolates side-effect failure", async () => {
    const deps = makePublisherDeps();
    deps.handleSideEffects.mockRejectedValueOnce(new Error("last_message down"));
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();
    const event = {
      type: "text_delta",
      text: "hello",
      timestamp: 1,
    } as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(deps.emitEventEnvelope).toHaveBeenCalledWith("sess-1", event);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
        sessionId: "sess-1",
        eventType: "text_delta",
      },
      "handleSideEffects threw",
    );
  });

  it("captures Claude runtime state before durable enqueue", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();

    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_session_state",
      state: "running",
      session_id: "claude-sess-runtime",
      timestamp: 10,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_task_started",
      task_id: "task-bg-1",
      tool_use_id: "toolu-bg",
      description: "background bash",
      task_type: "bash",
      timestamp: 11,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_task_created",
      task_id: "sdk-task-1",
      subject: "Investigate queue",
      description: "Check pending queue",
      teammate_name: "analyst",
      team_name: "runtime",
      timestamp: 11.5,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_task_completed",
      task_id: "sdk-task-1",
      subject: "Investigate queue",
      description: "Check pending queue",
      teammate_name: "analyst",
      team_name: "runtime",
      timestamp: 11.6,
    } as unknown as SSEEventPayload);
    const backgroundNotification = {
      type: "claude_runtime_task_notification",
      task_id: "task-bg-1",
      status: "completed",
      output_file: "/tmp/task.out",
      summary: "done",
      timestamp: 12,
    } as unknown as SSEEventPayload;
    attachClaudeBackgroundProvenance(backgroundNotification, "sdk_membership");
    await publisher.publishEngineEvent(task, backgroundNotification);
    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_mode_state",
      mode: "plan",
      active: true,
      source: "tool_use",
      tool_use_id: "toolu-plan",
      tool_name: "EnterPlanMode",
      timestamp: 12.5,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_notification",
      notification_id: "notif-1",
      source: "system",
      message: "permission prompt waiting",
      key: "permission",
      priority: "high",
      session_id: "claude-sess-runtime",
      timestamp: 12.6,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_remote_trigger",
      trigger_id: "remote-1",
      source: "message_origin",
      origin_kind: "peer",
      origin_from: "ios-device",
      origin_name: "iPhone",
      priority: "now",
      prompt: "continue",
      session_id: "claude-sess-runtime",
      timestamp: 12.7,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_transcript_mirror_error",
      mirror_id: "mirror-1",
      session_id: "claude-sess-runtime",
      project_key: "project-a",
      transcript_session_id: "claude-sess-runtime",
      subpath: "subagents/agent-a",
      error: "db unavailable",
      timestamp: 12.8,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_session_state",
      state: "idle",
      session_id: "claude-sess-runtime",
      timestamp: 13,
    } as unknown as SSEEventPayload);

    expect(task.claudeRuntime).toMatchObject({
      sessionState: "idle",
      sessionId: "claude-sess-runtime",
      tasks: {
        "task-bg-1": {
          taskId: "task-bg-1",
          status: "completed",
          toolUseId: "toolu-bg",
          description: "background bash",
          taskType: "bash",
          isBackgrounded: true,
          outputFile: "/tmp/task.out",
          summary: "done",
        },
        "sdk-task-1": {
          taskId: "sdk-task-1",
          status: "completed",
          subject: "Investigate queue",
          description: "Check pending queue",
          teammateName: "analyst",
          teamName: "runtime",
        },
      },
      planMode: {
        active: true,
        source: "tool_use",
        toolUseId: "toolu-plan",
        toolName: "EnterPlanMode",
      },
      notifications: {
        "notif-1": {
          notificationId: "notif-1",
          source: "system",
          message: "permission prompt waiting",
          key: "permission",
          priority: "high",
        },
      },
      remoteTriggers: {
        "remote-1": {
          triggerId: "remote-1",
          source: "message_origin",
          originKind: "peer",
          originFrom: "ios-device",
          originName: "iPhone",
          priority: "now",
          prompt: "continue",
        },
      },
      transcriptMirror: {
        lastError: "db unavailable",
        errorCount: 1,
        projectKey: "project-a",
        transcriptSessionId: "claude-sess-runtime",
        subpath: "subagents/agent-a",
      },
    });
    expect(deps.enqueueEvent).toHaveBeenCalledTimes(10);
    expect(deps.emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("keeps provenance-less synchronous task notifications out of background state", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();

    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_task_started",
      task_id: "task-sync-1",
      tool_use_id: "toolu-sync",
      description: "foreground bash",
      task_type: "bash",
      timestamp: 20,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_task_notification",
      task_id: "task-sync-1",
      status: "completed",
      summary: "consumed in the foreground turn",
      timestamp: 21,
    } as unknown as SSEEventPayload);

    expect(task.claudeRuntime?.tasks["task-sync-1"]).toMatchObject({
      taskId: "task-sync-1",
      status: "completed",
      toolUseId: "toolu-sync",
      taskType: "bash",
    });
    expect(task.claudeRuntime?.tasks["task-sync-1"]?.isBackgrounded).not.toBe(true);
  });
});
