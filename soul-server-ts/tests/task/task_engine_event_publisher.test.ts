import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { TaskEngineEventPublisher } from "../../src/task/task_engine_event_publisher.js";
import type { Task } from "../../src/task/task_models.js";
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
  const persistEvent = vi.fn(async () => 42);
  const handleSideEffects = vi.fn(async () => undefined);
  const persistence = {
    persistEvent,
    handleSideEffects,
  } as unknown as EventPersistence;

  const setClaudeSessionId = vi.fn(async () => undefined);
  const appendSupervisorEvent = vi.fn(async () => ({
    offset: 1,
    inserted: true,
    contiguousUpto: 1,
    highestSeenEventId: 1,
    gapStart: null,
    gapEnd: null,
  }));
  const getSupervisorRegistry = vi.fn(async () => null);
  const touchSupervisorRegistry = vi.fn(async () => null);
  const recordSupervisorUsageDelta = vi.fn(async () => undefined);
  const upsertSupervisorRegistry = vi.fn(async () => undefined);
  const db = {
    setClaudeSessionId,
    appendSupervisorEvent,
    getSupervisorRegistry,
    touchSupervisorRegistry,
    recordSupervisorUsageDelta,
    upsertSupervisorRegistry,
  } as unknown as SessionDB;
  const supervisorWakeScheduler = {
    ingest: vi.fn(async () => ({ scheduled: true })),
  };

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
    db,
    emitEventEnvelope,
    handleSideEffects,
    logger,
    persistEvent,
    persistence,
    getSupervisorRegistry,
    appendSupervisorEvent,
    recordSupervisorUsageDelta,
    supervisorWakeScheduler,
    touchSupervisorRegistry,
    upsertSupervisorRegistry,
    setClaudeSessionId,
  };
}

describe("TaskEngineEventPublisher", () => {
  it("persists event id before broadcast, then runs side effects", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();
    const event = {
      type: "assistant_message",
      content: "hello",
      timestamp: 1,
    } as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(deps.persistEvent).toHaveBeenCalledWith("sess-1", event);
    expect(task.lastEventId).toBe(42);
    expect((event as Record<string, unknown>)._event_id).toBe(42);
    expect(deps.emitEventEnvelope).toHaveBeenCalledWith("sess-1", event);
    expect(deps.handleSideEffects).toHaveBeenCalledWith("sess-1", event, task);
    expect(deps.persistEvent.mock.invocationCallOrder[0]).toBeLessThan(
      deps.emitEventEnvelope.mock.invocationCallOrder[0],
    );
    expect(deps.emitEventEnvelope.mock.invocationCallOrder[0]).toBeLessThan(
      deps.handleSideEffects.mock.invocationCallOrder[0],
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      { sessionId: "sess-1", eventType: "assistant_message" },
      "emitEventEnvelope dispatch",
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      { sessionId: "sess-1", eventType: "assistant_message" },
      "emitEventEnvelope completed",
    );
  });

  it("appends persisted events to supervisor_events and schedules wake routing", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher({
      ...deps,
      sourceNode: "node-1",
      supervisorWakeScheduler: deps.supervisorWakeScheduler,
    });
    const task = makeTask();
    const event = {
      type: "assistant_message",
      content: "hello",
      timestamp: 1,
    } as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(deps.appendSupervisorEvent).toHaveBeenCalledWith({
      sourceNode: "node-1",
      sourceSessionId: "sess-1",
      sourceEventId: 42,
      eventType: "assistant_message",
      payload: event,
      createdAt: new Date(1000),
    });
    expect(deps.supervisorWakeScheduler.ingest).toHaveBeenCalledWith(
      "assistant_message",
    );
  });

  it("touches supervisor heartbeat for non-usage activity events", async () => {
    const deps = makePublisherDeps();
    deps.getSupervisorRegistry.mockResolvedValueOnce({
      role: "ariela_codex",
      activeSessionId: "sess-1",
    } as never);
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({ profileId: "ariela_codex" });
    const event = {
      type: "assistant_message",
      content: "still working",
      timestamp: 1,
    } as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(deps.getSupervisorRegistry).toHaveBeenCalledWith("ariela_codex");
    expect(deps.touchSupervisorRegistry).toHaveBeenCalledWith(
      "ariela_codex",
      expect.any(Date),
    );
    expect(deps.recordSupervisorUsageDelta).not.toHaveBeenCalled();
  });

  it("does not touch supervisor heartbeat for stale sessions of the same role", async () => {
    const deps = makePublisherDeps();
    deps.getSupervisorRegistry.mockResolvedValueOnce({
      role: "ariela_codex",
      activeSessionId: "supervisor-current",
    } as never);
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({
      agentSessionId: "supervisor-old",
      profileId: "ariela_codex",
    });
    const event = {
      type: "assistant_message",
      content: "stale session output",
      timestamp: 1,
    } as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(deps.getSupervisorRegistry).toHaveBeenCalledWith("ariela_codex");
    expect(deps.touchSupervisorRegistry).not.toHaveBeenCalled();
  });

  it("skips heartbeat touch for non-supervisor profiles and throttles registry checks", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_000));
      const deps = makePublisherDeps();
      const publisher = new TaskEngineEventPublisher(deps);
      const task = makeTask({ profileId: "ordinary-agent" });
      const event = {
        type: "assistant_message",
        content: "still working",
        timestamp: 1,
      } as SSEEventPayload;

      await publisher.publishEngineEvent(task, event);
      await publisher.publishEngineEvent(task, event);
      await vi.advanceTimersByTimeAsync(15_000);
      await publisher.publishEngineEvent(task, event);

      expect(deps.getSupervisorRegistry).toHaveBeenCalledTimes(2);
      expect(deps.touchSupervisorRegistry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures only the first session id and still publishes every session event", async () => {
    const deps = makePublisherDeps();
    deps.persistEvent
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(9);
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
    expect(deps.setClaudeSessionId).toHaveBeenCalledTimes(1);
    expect(deps.setClaudeSessionId).toHaveBeenCalledWith("sess-1", "thr-first");
    expect(deps.persistEvent).toHaveBeenCalledTimes(2);
    expect(deps.emitEventEnvelope).toHaveBeenCalledTimes(2);
    expect(deps.handleSideEffects).toHaveBeenCalledTimes(2);
    expect(task.lastEventId).toBe(9);
  });

  it("isolates setClaudeSessionId failure before persistence and broadcast", async () => {
    const deps = makePublisherDeps();
    deps.setClaudeSessionId.mockRejectedValueOnce(new Error("db down"));
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();
    const event = {
      type: "session",
      session_id: "thr-first",
    } as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(task.codexThreadId).toBe("thr-first");
    expect(deps.persistEvent).toHaveBeenCalledWith("sess-1", event);
    expect(deps.emitEventEnvelope).toHaveBeenCalledWith("sess-1", event);
    expect(deps.handleSideEffects).toHaveBeenCalledWith("sess-1", event, task);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
        sessionId: "sess-1",
        threadId: "thr-first",
      },
      expect.stringContaining("setClaudeSessionId failed"),
    );
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

    expect(deps.persistEvent).not.toHaveBeenCalled();
    expect(task.lastEventId).toBe(99);
    expect((event as Record<string, unknown>)._event_id).toBeUndefined();
    expect(deps.emitEventEnvelope).toHaveBeenCalledWith("sess-1", event);
    expect(deps.handleSideEffects).toHaveBeenCalledWith("sess-1", event, task);
  });

  it("isolates persistence failure and broadcasts without _event_id", async () => {
    const deps = makePublisherDeps();
    deps.persistEvent.mockRejectedValueOnce(new Error("events db down"));
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({ lastEventId: 10 });
    const event = {
      type: "complete",
      usage: {},
      timestamp: 2,
    } as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(task.lastEventId).toBe(10);
    expect((event as Record<string, unknown>)._event_id).toBeUndefined();
    expect(deps.emitEventEnvelope).toHaveBeenCalledWith("sess-1", event);
    expect(deps.handleSideEffects).toHaveBeenCalledWith("sess-1", event, task);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
        sessionId: "sess-1",
        eventType: "complete",
      },
      "persistEvent failed",
    );
  });

  it("records complete usage delta for registered supervisor profile", async () => {
    const deps = makePublisherDeps();
    deps.getSupervisorRegistry.mockResolvedValueOnce({
      role: "ariela_codex",
      activeSessionId: "sess-1",
    } as never);
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({ profileId: "ariela_codex" });
    const event = {
      type: "complete",
      usage: {
        input_tokens: 11,
        output_tokens: 13,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      },
      timestamp: 2,
    } as unknown as SSEEventPayload;

    await publisher.publishEngineEvent(task, event);

    expect(deps.getSupervisorRegistry).toHaveBeenCalledWith("ariela_codex");
    expect(deps.recordSupervisorUsageDelta).toHaveBeenCalledWith({
      role: "ariela_codex",
      tokenDelta: 29,
      compactionDelta: 0,
      lastSeenAt: expect.any(Date),
    });
    expect(deps.touchSupervisorRegistry).not.toHaveBeenCalled();
    expect(deps.recordSupervisorUsageDelta.mock.invocationCallOrder[0]).toBeLessThan(
      deps.handleSideEffects.mock.invocationCallOrder[0],
    );
  });

  it("does not record usage delta for stale supervisor sessions", async () => {
    const deps = makePublisherDeps();
    deps.getSupervisorRegistry.mockResolvedValue({
      role: "ariela_codex",
      activeSessionId: "supervisor-current",
    } as never);
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({
      agentSessionId: "supervisor-old",
      profileId: "ariela_codex",
    });

    await publisher.publishEngineEvent(task, {
      type: "complete",
      usage: { input_tokens: 10, output_tokens: 5 },
      timestamp: 2,
    } as unknown as SSEEventPayload);

    expect(deps.recordSupervisorUsageDelta).not.toHaveBeenCalled();
    expect(deps.touchSupervisorRegistry).not.toHaveBeenCalled();
  });

  it("records only new complete usage for a repeated Codex turn id", async () => {
    const deps = makePublisherDeps();
    deps.getSupervisorRegistry.mockResolvedValue({
      role: "ariela_codex",
      activeSessionId: "sess-1",
    } as never);
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({ profileId: "ariela_codex" });

    await publisher.publishEngineEvent(task, {
      type: "complete",
      turn_id: "turn-1",
      usage: { input_tokens: 10, output_tokens: 5 },
      timestamp: 2,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "complete",
      turn_id: "turn-1",
      usage: { input_tokens: 10, output_tokens: 5 },
      timestamp: 3,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "complete",
      turn_id: "turn-1",
      usage: { input_tokens: 12, output_tokens: 8 },
      timestamp: 4,
    } as unknown as SSEEventPayload);

    expect(deps.recordSupervisorUsageDelta).toHaveBeenCalledTimes(2);
    expect(deps.recordSupervisorUsageDelta).toHaveBeenNthCalledWith(1, {
      role: "ariela_codex",
      tokenDelta: 15,
      compactionDelta: 0,
      lastSeenAt: expect.any(Date),
    });
    expect(deps.recordSupervisorUsageDelta).toHaveBeenNthCalledWith(2, {
      role: "ariela_codex",
      tokenDelta: 5,
      compactionDelta: 0,
      lastSeenAt: expect.any(Date),
    });
  });

  it("records Claude compact count and context usage delta", async () => {
    const deps = makePublisherDeps();
    deps.getSupervisorRegistry.mockResolvedValue({
      role: "ariela_claude",
      activeSessionId: "sess-1",
    } as never);
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({ profileId: "ariela_claude" });

    await publisher.publishEngineEvent(task, {
      type: "context_usage",
      used_tokens: 100,
      timestamp: 2,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "context_usage",
      used_tokens: 140,
      timestamp: 3,
    } as unknown as SSEEventPayload);
    await publisher.publishEngineEvent(task, {
      type: "compact",
      timestamp: 4,
    } as unknown as SSEEventPayload);

    expect(deps.recordSupervisorUsageDelta).toHaveBeenCalledTimes(3);
    expect(deps.recordSupervisorUsageDelta).toHaveBeenNthCalledWith(1, {
      role: "ariela_claude",
      tokenDelta: 100,
      compactionDelta: 0,
      lastSeenAt: expect.any(Date),
    });
    expect(deps.recordSupervisorUsageDelta).toHaveBeenNthCalledWith(2, {
      role: "ariela_claude",
      tokenDelta: 40,
      compactionDelta: 0,
      lastSeenAt: expect.any(Date),
    });
    expect(deps.recordSupervisorUsageDelta).toHaveBeenNthCalledWith(3, {
      role: "ariela_claude",
      tokenDelta: 0,
      compactionDelta: 1,
      lastSeenAt: expect.any(Date),
    });
  });

  it("persists supervisor hard pending state without marking handover_running from publisher", async () => {
    const now = new Date("2026-06-07T00:00:00.000Z");
    const deps = makePublisherDeps();
    deps.getSupervisorRegistry.mockResolvedValue({
      role: "ariela_codex",
      activeSessionId: "sess-1",
    } as never);
    deps.recordSupervisorUsageDelta.mockResolvedValueOnce({
      role: "ariela_codex",
      activeSessionId: "sess-supervisor",
      epoch: 4,
      cursorOffset: 11,
      handoverState: "idle",
      cumulativeTokens: 1_500_001,
      compactionCount: 0,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    } as never);
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({ profileId: "ariela_codex" });

    await publisher.publishEngineEvent(task, {
      type: "complete",
      turn_id: "turn-hard",
      usage: { input_tokens: 10 },
      timestamp: 2,
    } as unknown as SSEEventPayload);

    expect(deps.upsertSupervisorRegistry).toHaveBeenCalledWith({
      role: "ariela_codex",
      activeSessionId: "sess-supervisor",
      epoch: 4,
      cursorOffset: 11,
      handoverState: "hard_pending",
      cumulativeTokens: 1_500_001,
      compactionCount: 0,
      lastSeenAt: now,
    });
  });

  it("runs supervisor handover runner when a trigger is ready and runner is injected", async () => {
    const now = new Date("2026-06-07T00:00:00.000Z");
    const deps = makePublisherDeps();
    const registry = {
      role: "ariela_codex",
      activeSessionId: "sess-supervisor",
      epoch: 4,
      cursorOffset: 11,
      handoverState: "idle",
      cumulativeTokens: 1_500_001,
      compactionCount: 0,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
    deps.getSupervisorRegistry.mockResolvedValue({
      role: "ariela_codex",
      activeSessionId: "sess-1",
    } as never);
    deps.recordSupervisorUsageDelta.mockResolvedValueOnce(registry as never);
    const supervisorHandoverRunner = {
      run: vi.fn(async () => undefined),
    };
    const publisher = new TaskEngineEventPublisher({
      ...deps,
      supervisorHandoverRunner,
    });
    const task = makeTask({ profileId: "ariela_codex" });

    await publisher.publishEngineEvent(task, {
      type: "complete",
      turn_id: "turn-hard",
      usage: { input_tokens: 10 },
      timestamp: 2,
    } as unknown as SSEEventPayload);

    expect(supervisorHandoverRunner.run).toHaveBeenCalledWith(registry);
    expect(deps.upsertSupervisorRegistry).not.toHaveBeenCalled();
  });

  it("does not record complete usage when profile is not a supervisor registry", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask({ profileId: "ordinary-agent" });

    await publisher.publishEngineEvent(task, {
      type: "complete",
      usage: { input_tokens: 11, output_tokens: 13 },
      timestamp: 2,
    } as unknown as SSEEventPayload);

    expect(deps.getSupervisorRegistry).toHaveBeenCalledWith("ordinary-agent");
    expect(deps.recordSupervisorUsageDelta).not.toHaveBeenCalled();
  });

  it("records credential_alert as a pending limit_hit termination hint only", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();

    await publisher.publishEngineEvent(task, {
      type: "credential_alert",
      message: "rate limit",
      timestamp: 2,
    } as unknown as SSEEventPayload);

    expect(task.status).toBe("running");
    expect(task.pendingTerminationHint).toBe("limit_hit");
    expect(task.pendingTerminationDetail).toBe("rate limit");
    expect(task.terminationReason).toBeUndefined();
  });

  it("records fatal error as error_aborted hint before finalizer runs", async () => {
    const deps = makePublisherDeps();
    const publisher = new TaskEngineEventPublisher(deps);
    const task = makeTask();

    await publisher.publishEngineEvent(task, {
      type: "error",
      message: "backend died",
      error_code: "provider_shutdown",
      timestamp: 2,
    } as unknown as SSEEventPayload);

    expect(task.status).toBe("error");
    expect(task.error).toBe("backend died");
    expect(task.pendingTerminationHint).toBe("error_aborted");
    expect(task.pendingTerminationDetail).toBe("provider_shutdown");
    expect(task.terminationReason).toBeUndefined();
  });

  it("isolates broadcast failure and still runs side effects", async () => {
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

  it("captures Claude runtime state before persistence and broadcast", async () => {
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
    await publisher.publishEngineEvent(task, {
      type: "claude_runtime_task_notification",
      task_id: "task-bg-1",
      status: "completed",
      output_file: "/tmp/task.out",
      summary: "done",
      timestamp: 12,
    } as unknown as SSEEventPayload);
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
    expect(deps.persistEvent).toHaveBeenCalledTimes(10);
    expect(deps.emitEventEnvelope).toHaveBeenCalledTimes(10);
  });
});
