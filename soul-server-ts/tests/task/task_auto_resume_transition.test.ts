import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentRegistry } from "../../src/agent_registry.js";
import type { ExecutionContextBuilder } from "../../src/context/context_builder.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import { createInProcessTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import type { Task } from "../../src/task/task_models.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

function makeTerminalTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "s1",
    prompt: "original prompt",
    status: "completed",
    profileId: "codex-default",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    completedAt: new Date("2026-05-23T01:05:00.000Z"),
    lastEventId: 7,
    terminalEventId: 6,
    lastReadEventId: 3,
    result: "old result",
    error: "old error",
    interventionQueue: [],
    metadata: [],
    ...overrides,
  };
}

describe("AutoResumeTransition", () => {
  it("accepts an already-running ownerless session through the non-terminal transition", async () => {
    const task = makeTerminalTask({
      status: "running",
      completedAt: undefined,
      terminalEventId: undefined,
      result: undefined,
      error: undefined,
    });
    const persistenceDouble = makeEventPersistenceTestDouble(undefined, [], {
      capabilityProfile: "execution_ownership",
    });
    persistenceDouble.enqueueRunningTransitionAndWaitForApplication
      .mockImplementationOnce(async (_sessionId, input) => ({
        eventId: 8,
        applied: input.expectedTerminalEventId === undefined,
        canonicalSession: {
          status: "running",
          termination_reason: null,
          termination_detail: null,
          review_state: input.reviewState,
          last_assistant_text: null,
          termination_event_id: null,
          updated_at: "2026-09-01T00:00:00.000Z",
          last_event_id: 8,
        },
      }));
    const onResume = vi.fn((
      resumedTask: Task,
      activation: NonNullable<Task["executionActivation"]>,
    ) => {
      resumedTask.status = "running";
      resumedTask.executionActivation = undefined;
      activation.resolve();
    });
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(transition.resume(
      task,
      { text: "resume ownerless running", user: "u" },
      onResume,
    )).resolves.toEqual({ autoResumed: true });

    expect(persistenceDouble.enqueueRunningTransitionAndWaitForApplication)
      .toHaveBeenCalledWith("s1", expect.not.objectContaining({
        expectedTerminalEventId: expect.anything(),
      }));
    expect(onResume).toHaveBeenCalledWith(task, expect.any(Object));
  });

  it("rejects direct auto-resume while a running session has live execution evidence", async () => {
    const close = vi.fn(async () => undefined);
    const runner = createInProcessTaskRunnerRuntime({
      backendId: "codex",
      workspaceDir: "/tmp/codex-work",
      async *execute(): AsyncIterable<never> {},
      interrupt: vi.fn(async () => true),
      close,
    } as unknown as EnginePort);
    vi.spyOn(runner.dispatcher, "hasActiveExecution").mockReturnValue(true);
    const task = makeTerminalTask({
      status: "running",
      completedAt: undefined,
      terminalEventId: undefined,
      runner,
    });
    const persistenceDouble = makeEventPersistenceTestDouble(undefined, [], {
      capabilityProfile: "execution_ownership",
    });
    const onResume = vi.fn();
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(transition.resume(
      task,
      { text: "must stay on the live turn", user: "u" },
      onResume,
    )).rejects.toThrow("auto-resume running transition rejected");

    expect(close).not.toHaveBeenCalled();
    expect(persistenceDouble.enqueueEvent).not.toHaveBeenCalled();
    expect(persistenceDouble.enqueueRunningTransitionAndWaitForApplication)
      .not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("[A1] resumes through the durable running transition without ownership activation", async () => {
    const task = makeTerminalTask({ status: "error" });
    const persistenceDouble = makeEventPersistenceTestDouble(undefined, [], {
      capabilityProfile: "execution_ownership",
    });
    const recordExecutionGenerationAndWaitForApplication = vi.fn();
    const persistence = Object.assign(persistenceDouble.persistence, {
      recordExecutionGenerationAndWaitForApplication,
    });
    const startNewExecution = vi.fn((
      resumedTask: Task,
      activation: NonNullable<Task["executionActivation"]>,
    ) => {
      expect(resumedTask.status).toBe("initializing");
      expect(resumedTask.executionActivation).toBe(activation);
      expect(resumedTask.pendingExecutionExpectedTerminalEventId).toBeUndefined();
      resumedTask.status = "running";
      resumedTask.executionActivation = undefined;
      activation.resolve();
    });
    const onResume = vi.fn((
      resumedTask: Task,
      activation: NonNullable<Task["executionActivation"]>,
    ) => {
      startNewExecution(resumedTask, activation);
    });
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence,
    });

    await expect(
      transition.resume(task, { text: "owned resume", user: "u" }, onResume),
    ).resolves.toEqual({ autoResumed: true });

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith(task, expect.any(Object));
    expect(startNewExecution).toHaveBeenCalledTimes(1);
    expect(startNewExecution).toHaveBeenCalledWith(task, expect.any(Object));
    expect(persistenceDouble.enqueueRunningTransitionAndWaitForApplication)
      .toHaveBeenCalledTimes(1);
    expect(recordExecutionGenerationAndWaitForApplication).not.toHaveBeenCalled();
  });

  it("fences a resume running transition to the terminal revision captured before async metadata work", async () => {
    const task = makeTerminalTask();
    let releaseMetadata!: () => void;
    const metadataBlocked = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    const persistenceDouble = makeEventPersistenceTestDouble(undefined, [], {
      capabilityProfile: "execution_ownership",
    });
    const enqueueMetadataEffect = vi.fn(async () => await metadataBlocked);
    const persistence = Object.assign(persistenceDouble.persistence, {
      recordExecutionGenerationAndWaitForApplication: vi.fn(),
      enqueueMetadataEffect,
    });
    const transition = new AutoResumeTransition({ logger: silentLogger, persistence });
    const onResume = vi.fn();

    const resuming = transition.resume(task, {
      text: "fenced resume",
      user: "u",
      callerInfo: { source: "browser", display_name: "Alice" },
    }, onResume);
    await vi.waitFor(() => expect(enqueueMetadataEffect).toHaveBeenCalledOnce());
    task.terminalEventId = 99;
    releaseMetadata();
    await resuming;

    expect(persistenceDouble.enqueueRunningTransitionAndWaitForApplication)
      .toHaveBeenCalledWith("s1", expect.objectContaining({
        expectedTerminalEventId: 6,
      }));
    expect(task.pendingExecutionExpectedTerminalEventId).toBeUndefined();
    expect(onResume).toHaveBeenCalledOnce();
  });

  it("promotes resume through one durable running effect without a direct status broadcast", async () => {
    const order: string[] = [];
    const task = makeTerminalTask();
    const callerInfo = { source: "slack", display_name: "Alice" };

    const appendMetadata = vi.fn(async () => {
      order.push("appendMetadata");
      return 1;
    });
    const enqueueEvent = vi.fn(async (_sessionId, event, effect) => {
      order.push("enqueueEvent");
      expect(event).toMatchObject({
        type: "user_message",
        user: "Alice",
        text: "resume text",
        caller_info: callerInfo,
        attachments: ["/tmp/a.png"],
      });
      expect(effect).toBeUndefined();
      expect((event as Record<string, unknown>)._event_id).toBeUndefined();
      return { source_seq: 1 };
    });
    const enqueueRunningTransition = vi.fn(async (_sessionId, input) => {
      order.push("enqueueRunningTransition");
      expect(input).toMatchObject({
        reviewState: "not_required",
        transitionId: "resume:7",
        expectedTerminalEventId: 6,
      });
      return { source_seq: 2 };
    });
    const enqueueRunningTransitionAndWaitForApplication = vi.fn(
      async (sessionId, input) => {
        await enqueueRunningTransition(sessionId, input);
        return {
          eventId: 8,
          applied: true,
          canonicalSession: {
            status: "running",
            termination_reason: null,
            termination_detail: null,
            review_state: "not_required",
            last_assistant_text: null,
            termination_event_id: null,
            updated_at: "2026-08-11T00:00:00.000Z",
            last_event_id: 8,
          },
        };
      },
    );
    const handleSideEffects = vi.fn(async (_sessionId, event, handledTask) => {
      order.push("handleSideEffects");
      expect(handledTask).toBe(task);
      expect(task.lastEventId).toBe(7);
      expect((event as Record<string, unknown>)._event_id).toBeUndefined();
    });
    const persistence = {
      enqueueEvent,
      enqueueRunningTransition,
      enqueueRunningTransitionAndWaitForApplication,
      handleSideEffects,
      enqueueMetadataEffect: appendMetadata,
    } as unknown as EventPersistence;

    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence,
    });
    const onResume = vi.fn((
      resumedTask: Task,
      activation: NonNullable<Task["executionActivation"]>,
    ) => {
      order.push("onResume");
      expect(resumedTask).toBe(task);
      expect(resumedTask.status).toBe("initializing");
      expect(resumedTask.interventionQueue).toHaveLength(1);
      resumedTask.status = "running";
      resumedTask.executionActivation = undefined;
      activation.resolve();
    });

    await expect(
      transition.resume(task, {
        text: "resume text",
        user: "alice",
        callerInfo,
        attachmentPaths: ["/tmp/a.png"],
      }, onResume),
    ).resolves.toEqual({ autoResumed: true });

    expect(order).toEqual([
      "appendMetadata",
      "enqueueEvent",
      "enqueueRunningTransition",
      "handleSideEffects",
      "onResume",
    ]);
    expect(task.prompt).toBe("resume text");
    expect(task.clientId).toBe("alice");
    expect(task.callerInfo).toBe(callerInfo);
    expect(task.attachmentPaths).toEqual(["/tmp/a.png"]);
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(enqueueRunningTransition).toHaveBeenCalledTimes(1);
    expect(handleSideEffects).toHaveBeenCalledTimes(1);
    expect(task.metadata).toContainEqual({ type: "caller_info", value: callerInfo });
    expect(appendMetadata).toHaveBeenCalledWith("s1", {
      type: "caller_info",
      value: callerInfo,
    });
  });

  it("keeps the local task on the canonical terminal row when resume CAS is rejected", async () => {
    const task = makeTerminalTask({
      status: "interrupted",
      terminationReason: "killed",
      terminationDetail: "operator stop",
      reviewState: "needs_review",
      lastAssistantText: "canonical answer",
    });
    const persistenceDouble = makeEventPersistenceTestDouble(undefined, [], {
      capabilityProfile: "legacy_transition_only",
    });
    persistenceDouble.enqueueRunningTransitionAndWaitForApplication
      .mockResolvedValueOnce({
        eventId: 9,
        applied: false,
        canonicalSession: {
          status: "interrupted",
          termination_reason: "killed",
          termination_detail: "operator stop",
          review_state: "needs_review",
          last_assistant_text: "canonical answer",
          termination_event_id: 6,
          updated_at: "2026-08-11T00:00:00.000Z",
          last_event_id: 9,
        },
      });
    const onResume = vi.fn();
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await expect(
      transition.resume(task, { text: "resume", user: "u" }, onResume),
    ).rejects.toThrow("auto-resume running transition rejected");

    expect(task).toMatchObject({
      status: "interrupted",
      terminationReason: "killed",
      terminationDetail: "operator stop",
      reviewState: "needs_review",
      terminalEventId: 6,
      lastEventId: 9,
      lastAssistantText: "canonical answer",
    });
    expect(task.completedAt?.toISOString()).toBe("2026-08-11T00:00:00.000Z");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("rejects auto-resume before changing task state when user_message persistence fails", async () => {
    const task = makeTerminalTask({ status: "interrupted" });
    const enqueueEvent = vi.fn().mockRejectedValue(new Error("events DB unavailable"));
    const onResume = vi.fn();
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: {
        enqueueEvent,
        handleSideEffects: vi.fn(),
      } as unknown as EventPersistence,
    });

    await expect(
      transition.resume(task, { text: "resume", user: "u" }, onResume),
    ).rejects.toThrow("events DB unavailable");

    expect(task.status).toBe("interrupted");
    expect(task.interventionQueue).toEqual([]);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("rejects auto-resume before side effects when the persisted profile is unavailable", async () => {
    const task = makeTerminalTask({ status: "interrupted", profileId: "missing-profile" });
    const onResume = vi.fn();
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      agentRegistry: { get: vi.fn().mockReturnValue(undefined) } as unknown as AgentRegistry,
    });

    await expect(
      transition.resume(task, { text: "resume", user: "u" }, onResume),
    ).rejects.toThrow("unknown agent profile missing-profile");

    expect(task.status).toBe("interrupted");
    expect(task.interventionQueue).toEqual([]);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("accepts the session profile snapshot when the mutable registry no longer has the profile", async () => {
    const task = makeTerminalTask({
      profileId: "db-profile",
      agentProfileSnapshot: {
        id: "db-profile",
        name: "DB Profile",
        backend: "codex",
        workspace_dir: "/tmp/db-profile",
      },
    });
    const onResume = vi.fn((
      resumedTask: Task,
      activation: NonNullable<Task["executionActivation"]>,
    ) => {
      expect(resumedTask.executionActivation).toBe(activation);
      resumedTask.status = "running";
      resumedTask.executionActivation = undefined;
      activation.resolve();
    });
    const transition = new AutoResumeTransition({
      persistence: makeEventPersistenceTestDouble(undefined, [], {
        capabilityProfile: "execution_ownership",
      }).persistence,
      logger: silentLogger,
      agentRegistry: { get: vi.fn().mockReturnValue(undefined) } as unknown as AgentRegistry,
    });

    await expect(
      transition.resume(task, { text: "resume", user: "u" }, onResume),
    ).resolves.toEqual({ autoResumed: true });
    expect(onResume).toHaveBeenCalledWith(task, expect.any(Object));
  });

  it("clears termination state so a resumed turn can finalize with a fresh session_ended event", async () => {
    const task = makeTerminalTask({
      terminationReason: "completed_ok",
      terminationDetail: null,
      pendingTerminationHint: "limit_hit",
      pendingTerminationDetail: "stale limit",
      terminationEventRecorded: true,
    });
    const persistenceDouble = makeEventPersistenceTestDouble(undefined, [], {
      capabilityProfile: "legacy_transition_only",
    });
    const autoResume = new AutoResumeTransition({
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });
    const lifecycle = new TaskLifecycleTransition({
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await autoResume.resume(task, { text: "retry", user: "u" }, vi.fn());
    task.pendingTerminationHint = "limit_hit";
    task.pendingTerminationDetail = "fresh limit";
    await lifecycle.finalizeExternalTask(task, { error: "rate limited" });

    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ type: "user_message", text: "retry" }),
    );
    expect(persistenceDouble.enqueueRunningTransition).toHaveBeenCalledTimes(1);
    expect(task.terminationReason).toBe("limit_hit");
    expect(task.terminationDetail).toBe("fresh limit");
    expect(task.terminationEventRecorded).toBe(true);
    expect(persistenceDouble.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "session_ended",
        termination_reason: "limit_hit",
      }),
      expect.objectContaining({
        kind: "terminal_transition",
        termination_reason: "limit_hit",
      }),
    );
  });

  it("clears a stale drained engine before resuming the next user turn", async () => {
    const order: string[] = [];
    const close = vi.fn(async () => {
      order.push("close");
    });
    const engine = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-work",
      execute: vi.fn(),
      interrupt: vi.fn(),
      close,
    } as unknown as EnginePort;
    const task = makeTerminalTask({
      runner: createInProcessTaskRunnerRuntime(engine),
      executionPromise: Promise.resolve(),
    });
    const persistenceDouble = makeEventPersistenceTestDouble(
      async () => {
        order.push("handleSideEffects");
      },
      [],
      { capabilityProfile: "execution_ownership" },
    );

    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });
    const onResume = vi.fn((resumedTask: Task) => {
      order.push("onResume");
      expect(resumedTask.runner).toBeUndefined();
      expect(resumedTask.executionPromise).toBeUndefined();
    });

    await transition.resume(
      task,
      {
        text: "resume",
        user: "u",
      },
      onResume,
    );

    expect(close).toHaveBeenCalledTimes(1);
    expect(task.runner).toBeUndefined();
    expect(task.executionPromise).toBeUndefined();
    expect(order).toEqual([
      "close",
      "handleSideEffects",
      "onResume",
    ]);
  });

  it("preserves a runner retained for Claude background work across auto-resume", async () => {
    const close = vi.fn(async () => undefined);
    const engine = {
      backendId: "claude",
      workspaceDir: "/tmp/claude-work",
      execute: vi.fn(),
      interrupt: vi.fn(),
      close,
    } as unknown as EnginePort;
    const runner = createInProcessTaskRunnerRuntime(engine);
    const task = makeTerminalTask({
      runner,
      runnerRetainedForClaudeBackground: true,
      executionPromise: Promise.resolve(),
    });
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: makeEventPersistenceTestDouble(undefined, [], {
        capabilityProfile: "execution_ownership",
      }).persistence,
    });
    const onResume = vi.fn((
      resumedTask: Task,
      activation: NonNullable<Task["executionActivation"]>,
    ) => {
      expect(resumedTask.runner).toBe(runner);
      expect(resumedTask.runnerRetainedForClaudeBackground).toBe(true);
      expect(resumedTask.executionPromise).toBeUndefined();
      expect(resumedTask.executionActivation).toBe(activation);
      resumedTask.status = "running";
      resumedTask.executionActivation = undefined;
      activation.resolve();
    });

    await transition.resume(task, { text: "runtime result", user: "system" }, onResume);

    expect(close).not.toHaveBeenCalled();
    expect(onResume).toHaveBeenCalledWith(task, expect.any(Object));
  });

  it("auto-acknowledges a needs_review result before terminal follow-up resumes", async () => {
    const task = makeTerminalTask({
      reviewRequired: true,
      reviewState: "needs_review",
    });
    const persistenceDouble = makeEventPersistenceTestDouble(undefined, [], {
      capabilityProfile: "legacy_transition_only",
    });
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });

    await transition.resume(task, { text: "follow up", user: "human" }, vi.fn());

    expect(task.reviewState).toBe("acknowledged");
    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
      }),
    );
    expect(persistenceDouble.enqueueRunningTransition).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        reviewState: "acknowledged",
        expectedTerminalEventId: 6,
      }),
    );
  });

  it("restores the terminal task when post-transition durable admission fails", async () => {
    const task = makeTerminalTask({
      terminationReason: "completed_ok",
      terminationDetail: null,
      terminationEventRecorded: true,
      reviewState: "needs_review",
      lastAssistantText: "completed answer",
    });
    const persistenceDouble = makeEventPersistenceTestDouble(undefined, [], {
      capabilityProfile: "legacy_transition_only",
    });
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });
    const admissionError = new Error("notification outbox already exists");
    const onResume = vi.fn();

    await expect(transition.resume(
      task,
      { text: "redelivered completion", user: "agent" },
      onResume,
      {
        afterRunningTransition: vi.fn().mockRejectedValue(admissionError),
      },
    )).rejects.toBe(admissionError);

    expect(persistenceDouble.enqueueRunningTransitionAndWaitForApplication)
      .toHaveBeenCalledOnce();
    expect(persistenceDouble.enqueueTerminalTransitionAndWaitForApplication)
      .toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({
          type: "session_ended",
          status: "completed",
          termination_reason: "completed_ok",
        }),
        expect.objectContaining({
          kind: "terminal_transition",
          status: "completed",
          termination_reason: "completed_ok",
          review_state: "needs_review",
          last_assistant_text: "completed answer",
        }),
      );
    expect(task.status).toBe("completed");
    expect(task.terminationEventRecorded).toBe(true);
    expect(task.terminalEventId).not.toBe(6);
    expect(task.executionActivation).toBeUndefined();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("compensates the durable running transition when execution admission rejects", async () => {
    const task = makeTerminalTask({
      terminationReason: "completed_ok",
      terminationDetail: null,
      terminationEventRecorded: true,
      reviewState: "needs_review",
    });
    const persistenceDouble = makeEventPersistenceTestDouble(undefined, [], {
      capabilityProfile: "legacy_transition_only",
    });
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
    });
    const admissionError = new Error("execution generation record rejected");
    let activation!: NonNullable<Task["executionActivation"]>;

    await transition.resume(
      task,
      { text: "retry after restart", user: "agent" },
      (_resumedTask, startedActivation) => {
        activation = startedActivation!;
        activation.reject(admissionError);
      },
    );

    await expect(activation.promise).rejects.toBe(admissionError);
    await vi.waitFor(() => {
      expect(persistenceDouble.enqueueTerminalTransitionAndWaitForApplication)
        .toHaveBeenCalledOnce();
    });
    expect(task.status).toBe("completed");
    expect(task.terminationReason).toBe("completed_ok");
    expect(task.terminationEventRecorded).toBe(true);
    expect(task.executionActivation).toBeUndefined();
  });

  it("stores resume message context for the executor initial-message path", async () => {
    const task = makeTerminalTask();
    const contextItem = {
      key: "soulstream_session",
      label: "Soulstream session",
      content: { agent_session_id: "s1" },
    };
    const buildResumeContextItems = vi.fn().mockResolvedValue([contextItem]);
    const contextBuilder = {
      buildResumeContextItems,
    } as unknown as ExecutionContextBuilder;
    const agent = {
      id: "codex-default",
      name: "Codex Default",
      backend: "codex",
      workspace_dir: "/tmp/codex",
    };
    const agentRegistry = { get: vi.fn().mockReturnValue(agent) } as unknown as AgentRegistry;
    const persistenceDouble = makeEventPersistenceTestDouble(undefined, [], {
      capabilityProfile: "legacy_transition_only",
    });
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: persistenceDouble.persistence,
      contextBuilder,
      agentRegistry,
    });

    await transition.resume(
      task,
      {
        text: "resume",
        user: "u",
        context: [contextItem],
      },
      vi.fn(),
    );

    expect(buildResumeContextItems).not.toHaveBeenCalled();
    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        type: "user_message",
        text: "resume",
        context: [contextItem],
      }),
    );
    expect(persistenceDouble.enqueueRunningTransition).toHaveBeenCalledTimes(1);
    expect(task.contextItems).toEqual([contextItem]);
  });
});
