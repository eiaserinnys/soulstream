import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { ActiveTaskRecovery } from "../../src/task/task_active_recovery.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import type { Task } from "../../src/task/task_models.js";
import type { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";
import type {
  DeliveryLedgerAdmission,
  TaskDeliveryLedgerGate,
} from "../../src/task/task_delivery_ledger_gate.js";
import type { SessionNotificationPublisher } from "../../src/task/task_session_notification.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-intervention",
    prompt: "original prompt",
    status: "running",
    createdAt: new Date("2026-05-23T01:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 3,
    interventionQueue: [],
    ...overrides,
  };
}

function makeLogger(): Logger {
  return { warn: vi.fn() } as unknown as Logger;
}

function makeSubject(
  initialTasks: Task[] = [],
  deliveryLedgerGate?: Pick<
    TaskDeliveryLedgerGate,
    "admit" | "beginDispatch" | "recordResult" | "recordFailure"
      | "recordNotificationPublished" | "recordNotificationFailure"
  >,
) {
  const tasks = new Map(initialTasks.map((task) => [task.agentSessionId, task]));
  const logger = makeLogger();
  const loadEvictedTask = vi.fn(async (_sessionId: string): Promise<Task | null> => null);
  const queuedResult = {
    delivered: false,
    queued: true,
    queuePosition: 1,
    consumeWhen: "next_turn",
    reason: "queue_only_policy",
  } as const;
  const runningInterventionTransition = {
    deliver: vi.fn().mockResolvedValue(queuedResult),
    queueOnly: vi.fn().mockResolvedValue(queuedResult),
  } as unknown as Pick<RunningInterventionTransition, "deliver" | "queueOnly">;
  const autoResumeTransition = {
    resume: vi.fn().mockResolvedValue({ autoResumed: true }),
  } as unknown as Pick<AutoResumeTransition, "resume">;
  const sessionNotificationPublisher = {
    publish: vi.fn().mockResolvedValue({
      published: true,
      targetReceiptId: "event:notification",
    }),
  } as unknown as Pick<SessionNotificationPublisher, "publish">;
  const route = new TaskInterventionRoute({
    getTask: (sessionId) => tasks.get(sessionId),
    loadEvictedTask,
    rememberTask: (task) => {
      tasks.set(task.agentSessionId, task);
    },
    activeTaskRecovery: new ActiveTaskRecovery(logger),
    runningInterventionTransition,
    autoResumeTransition,
    deliveryLedgerGate,
    sessionNotificationPublisher,
  });

  return {
    route,
    tasks,
    loadEvictedTask,
    runningInterventionTransition,
    autoResumeTransition,
    sessionNotificationPublisher,
  };
}

function admitted(
  deliveryId: string,
  intent: "durable_next_turn" | "completion_notification" | "runtime_followup" =
    "completion_notification",
): DeliveryLedgerAdmission {
  return {
    kind: "admitted",
    deliveryId,
    row: {
      delivery_id: deliveryId,
      intent,
      source: intent === "runtime_followup"
        ? "claude_runtime_task_followup"
        : "completion_notifier",
      completion_id: `completion:${deliveryId}`,
      relation_key: `relation:${deliveryId}`,
      producer_terminal_revision: null,
      parent_delivery_id: null,
      caller_turn_id: null,
      lease_owner: "test-route",
      created_at: new Date("2026-07-26T00:00:00.000Z"),
      payload: {
        text: "stored delivery text",
        user: "system",
        attachment_paths: null,
        context: null,
        caller_info: null,
        followup_task_ids: null,
      },
      payload_hash: `hash:${deliveryId}`,
    } as never,
  };
}

describe("TaskInterventionRoute.addIntervention", () => {
  it("routes memory-hit running tasks to the running transition and preserves public result shape", async () => {
    const task = makeTask();
    const { route, loadEvictedTask, runningInterventionTransition, autoResumeTransition } =
      makeSubject([task]);
    const onResume = vi.fn();
    const context = [
      { key: "review", label: "Review", content: "fresh context" },
    ];

    await expect(route.addIntervention({
      agentSessionId: "sess-intervention",
      text: "focus on the failing test",
      user: "alice",
      callerInfo: { source: "slack", display_name: "Alice" },
      attachmentPaths: ["/tmp/a.png"],
      context,
    }, onResume)).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "queue_only_policy",
    });

    expect(loadEvictedTask).not.toHaveBeenCalled();
    expect(runningInterventionTransition.deliver).toHaveBeenCalledWith(task, {
      text: "focus on the failing test",
      user: "alice",
      callerInfo: { source: "slack", display_name: "Alice" },
      attachmentPaths: ["/tmp/a.png"],
      context,
    }, {
      queueIfUndelivered: true,
    });
    expect(autoResumeTransition.resume).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("routes memory-hit terminal tasks to auto-resume and forwards onResume only there", async () => {
    const task = makeTask({
      status: "completed",
      completedAt: new Date("2026-05-23T01:05:00.000Z"),
    });
    const { route, runningInterventionTransition, autoResumeTransition } = makeSubject([task]);
    const onResume = vi.fn();

    await expect(route.addIntervention({
      agentSessionId: "sess-intervention",
      text: "resume",
      user: "alice",
      source: "claude_runtime_task_followup",
      followupAttempt: 2,
      followupKey: "sess-intervention:agent-task",
      followupTaskIds: ["agent-task"],
      onlyIfTerminal: true,
    }, onResume)).resolves.toEqual({ autoResumed: true });

    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(autoResumeTransition.resume).toHaveBeenCalledWith(task, {
      text: "resume",
      user: "alice",
      callerInfo: undefined,
      attachmentPaths: undefined,
      context: undefined,
      source: "claude_runtime_task_followup",
      followupAttempt: 2,
      followupKey: "sess-intervention:agent-task",
      followupTaskIds: ["agent-task"],
    }, onResume);
  });

  it("does not return auto-resume success before execution ownership activation", async () => {
    const task = makeTask({ status: "completed" });
    const { route, autoResumeTransition } = makeSubject([task]);
    let resolveActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      resolveActivation = resolve;
    });
    vi.mocked(autoResumeTransition.resume).mockImplementation(async (
      resumedTask,
      _message,
      onResume,
    ) => {
      resumedTask.status = "initializing";
      onResume(resumedTask);
      return { autoResumed: true };
    });
    const onResume = vi.fn((resumedTask: Task) => {
      resumedTask.executionActivationPromise = activation;
    });

    let settled = false;
    const request = route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "resume",
      user: "alice",
    }, onResume).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveActivation();
    await expect(request).resolves.toEqual({ autoResumed: true });
  });

  it("rejects the auto-resume request when ownership activation fails", async () => {
    const task = makeTask({ status: "completed" });
    const { route, autoResumeTransition } = makeSubject([task]);
    vi.mocked(autoResumeTransition.resume).mockImplementation(async (
      resumedTask,
      _message,
      onResume,
    ) => {
      resumedTask.status = "initializing";
      onResume(resumedTask);
      return { autoResumed: true };
    });
    const onResume = vi.fn((resumedTask: Task) => {
      resumedTask.executionActivationPromise = Promise.reject(
        new Error("execution activation rejected"),
      );
    });

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "resume",
      user: "alice",
    }, onResume)).rejects.toThrow("execution activation rejected");
  });

  it("projects terminal notification delivery only after ownership activation", async () => {
    const deliveryId = "61616161-6161-4161-8161-616161616161";
    let resolveActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      resolveActivation = () => {
        task.status = "running";
        resolve();
      };
    });
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId)),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
      recordNotificationPublished: vi.fn().mockResolvedValue(undefined),
      recordNotificationFailure: vi.fn().mockResolvedValue(undefined),
    } satisfies Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
        | "recordNotificationPublished" | "recordNotificationFailure"
    >;
    const task = makeTask({ status: "completed" });
    const { route, autoResumeTransition, sessionNotificationPublisher } =
      makeSubject([task], gate);
    vi.mocked(autoResumeTransition.resume).mockImplementation(async (
      resumedTask,
      _message,
      onResume,
    ) => {
      resumedTask.status = "initializing";
      onResume(resumedTask);
      return { autoResumed: true };
    });
    const request = route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "child completed",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification",
      completionId: "completion-activation",
      relationKey: "child_session:activation:1",
      source: "completion_notifier",
    }, (resumedTask) => {
      resumedTask.executionActivationPromise = activation;
    });

    await vi.waitFor(() => expect(sessionNotificationPublisher.publish).toHaveBeenCalled());
    expect(gate.recordResult).toHaveBeenCalledOnce();
    expect(gate.recordNotificationPublished).not.toHaveBeenCalled();

    resolveActivation();
    await expect(request).resolves.toEqual({ autoResumed: true });
    expect(gate.recordNotificationPublished).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId }),
      "event:notification",
    );
    expect(gate.recordNotificationFailure).not.toHaveBeenCalled();
  });

  it("returns a staged terminal notification to retryable when activation fails", async () => {
    const deliveryId = "62626262-6262-4262-8262-626262626262";
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId)),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
      recordNotificationPublished: vi.fn().mockResolvedValue(undefined),
      recordNotificationFailure: vi.fn().mockResolvedValue(undefined),
    } satisfies Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
        | "recordNotificationPublished" | "recordNotificationFailure"
    >;
    const task = makeTask({ status: "completed" });
    const { route, autoResumeTransition } = makeSubject([task], gate);
    vi.mocked(autoResumeTransition.resume).mockImplementation(async (
      resumedTask,
      _message,
      onResume,
    ) => {
      resumedTask.status = "initializing";
      onResume(resumedTask);
      return { autoResumed: true };
    });

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "child completed",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification",
      completionId: "completion-activation-failed",
      relationKey: "child_session:activation:2",
      source: "completion_notifier",
    }, (resumedTask) => {
      resumedTask.executionActivationPromise = Promise.reject(
        new Error("activation rejected"),
      );
    })).rejects.toThrow("activation rejected");

    expect(gate.recordNotificationPublished).not.toHaveBeenCalled();
    expect(gate.recordNotificationFailure).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId }),
      "auto-resume activation failed: activation rejected",
    );
  });

  it("waits for an initializing execution before admitting a concurrent delivery", async () => {
    const deliveryId = "63636363-6363-4363-8363-636363636363";
    let resolveActivation!: () => void;
    const task = makeTask({ status: "initializing" });
    task.executionActivationPromise = new Promise<void>((resolve) => {
      resolveActivation = () => {
        task.status = "running";
        resolve();
      };
    });
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId, "durable_next_turn")),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    } satisfies Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const { route, runningInterventionTransition } = makeSubject([task], gate);
    const request = route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "second delivery",
      user: "agent",
      deliveryId,
      deliveryIntent: "durable_next_turn",
      completionId: "completion-concurrent",
      relationKey: "delivery:concurrent:1",
    }, vi.fn());

    await Promise.resolve();
    expect(gate.beginDispatch).not.toHaveBeenCalled();
    expect(runningInterventionTransition.queueOnly).not.toHaveBeenCalled();

    resolveActivation();
    await expect(request).resolves.toMatchObject({ queued: true });
    expect(gate.beginDispatch).toHaveBeenCalledOnce();
  });

  it.each(["running"] as const)(
    "terminal-only delivery never enters the %s intervention path",
    async (status) => {
    const task = makeTask({ status });
    const { route, runningInterventionTransition, autoResumeTransition } = makeSubject([task]);

    await expect(route.addIntervention({
      agentSessionId: "sess-intervention",
      text: "delayed background follow-up retry",
      user: "system",
      source: "claude_runtime_task_followup",
      onlyIfTerminal: true,
    }, vi.fn())).resolves.toEqual({
      delivered: false,
      deferred: true,
      retryWhen: "terminal_state",
      reason: "terminal_only_policy",
    });

    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(autoResumeTransition.resume).not.toHaveBeenCalled();
    },
  );

  it("loads and remembers evicted terminal tasks before auto-resume route selection", async () => {
    const hydrated = makeTask({
      agentSessionId: "sess-evicted",
      status: "completed",
      hydratedFromDb: true,
      codexThreadId: "thr-1",
      profileId: "codex-default",
    });
    const { route, tasks, loadEvictedTask, autoResumeTransition } = makeSubject();
    loadEvictedTask.mockResolvedValueOnce(hydrated);
    const onResume = vi.fn();

    await expect(route.addIntervention({
      agentSessionId: "sess-evicted",
      text: "resume from DB",
      user: "alice",
    }, onResume)).resolves.toEqual({ autoResumed: true });

    expect(loadEvictedTask).toHaveBeenCalledWith("sess-evicted");
    expect(tasks.get("sess-evicted")).toBe(hydrated);
    expect(autoResumeTransition.resume).toHaveBeenCalledWith(hydrated, expect.objectContaining({
      text: "resume from DB",
    }), onResume);
  });

  it("treats detached hydrated running tasks as auto-resume instead of running queue", async () => {
    const hydrated = makeTask({
      agentSessionId: "sess-stale-running",
      status: "running",
      hydratedFromDb: true,
      codexThreadId: "thr-stale",
    });
    const { route, tasks, loadEvictedTask, runningInterventionTransition, autoResumeTransition } =
      makeSubject();
    loadEvictedTask.mockResolvedValueOnce(hydrated);

    await expect(route.addIntervention({
      agentSessionId: "sess-stale-running",
      text: "resume stale running",
      user: "alice",
    }, vi.fn())).resolves.toEqual({ autoResumed: true });

    expect(tasks.get("sess-stale-running")).toBe(hydrated);
    expect(hydrated.status).toBe("interrupted");
    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(autoResumeTransition.resume).toHaveBeenCalledWith(hydrated, expect.objectContaining({
      text: "resume stale running",
    }), expect.any(Function));
  });

  it("normalizes unresolved task lookup to the existing Task not found error shape", async () => {
    const { route, loadEvictedTask, runningInterventionTransition, autoResumeTransition } =
      makeSubject();
    loadEvictedTask.mockResolvedValueOnce(null);

    await expect(route.addIntervention({
      agentSessionId: "missing",
      text: "x",
      user: "alice",
    }, vi.fn())).rejects.toThrow("Task not found: missing");

    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(autoResumeTransition.resume).not.toHaveBeenCalled();
  });

  it("terminal+미전달 완료를 정확히 한 번 auto-resume하고 재시도는 suppress한다", async () => {
    const deliveryId = "44444444-4444-4444-8444-444444444444";
    const gate = {
      admit: vi.fn()
        .mockResolvedValueOnce(admitted(deliveryId))
        .mockResolvedValueOnce({
          kind: "suppressed",
          deliveryId,
          reason: "delivery_consumed",
        }),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
      beginDispatch: vi.fn((admission) => Promise.resolve(admission)),
    } as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const task = makeTask({ status: "completed" });
    const {
      route,
      autoResumeTransition,
      runningInterventionTransition,
      sessionNotificationPublisher,
    } = makeSubject([task], gate);
    vi.mocked(autoResumeTransition.resume).mockImplementation(
      async (resumedTask, _message, callback) => {
        callback(resumedTask);
        return { autoResumed: true };
      },
    );
    const onResume = vi.fn();
    const params = {
      agentSessionId: task.agentSessionId,
      text: "child completed",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification" as const,
      completionId: "completion-1",
      relationKey: "child_session:child-1:42",
      source: "completion_notifier",
    };

    await expect(route.addIntervention(params, onResume)).resolves.toEqual({
      autoResumed: true,
    });
    await expect(route.addIntervention(params, vi.fn())).resolves.toEqual({
      suppressed: true,
      deliveryId,
      reason: "delivery_consumed",
    });

    expect(autoResumeTransition.resume).toHaveBeenCalledTimes(1);
    expect(autoResumeTransition.resume).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ deliveryId }),
      expect.any(Function),
      { publishUserMessage: false },
    );
    expect(sessionNotificationPublisher.publish).toHaveBeenCalledTimes(1);
    expect(vi.mocked(autoResumeTransition.resume).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sessionNotificationPublisher.publish).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(gate.recordResult).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sessionNotificationPublisher.publish).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(gate.recordResult).mock.invocationCallOrder[0]).toBeLessThan(
      onResume.mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(sessionNotificationPublisher.publish).mock.invocationCallOrder[0],
    ).toBeLessThan(onResume.mock.invocationCallOrder[0]!);
    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(runningInterventionTransition.queueOnly).not.toHaveBeenCalled();
  });

  it("generating 중 완료는 interrupt 없이 notification+queueOnly로만 전달한다", async () => {
    const deliveryId = "55555555-5555-4555-8555-555555555555";
    const admission = admitted(deliveryId, "runtime_followup");
    const gate = {
      admit: vi.fn().mockResolvedValue(admission),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
    } as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const task = makeTask({ status: "running" });
    const {
      route,
      autoResumeTransition,
      runningInterventionTransition,
      sessionNotificationPublisher,
    } = makeSubject([task], gate);

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "background result",
      user: "system",
      deliveryId,
      deliveryIntent: "runtime_followup",
      completionId: "completion-2",
      relationKey: "runtime_task:task-1:99",
      source: "runtime_followup",
    }, vi.fn())).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "queue_only_policy",
    });

    expect(sessionNotificationPublisher.publish).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ deliveryId }),
      "queued",
    );
    expect(
      vi.mocked(runningInterventionTransition.queueOnly).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(sessionNotificationPublisher.publish).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(gate.recordResult).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sessionNotificationPublisher.publish).mock.invocationCallOrder[0]!,
    );
    expect(runningInterventionTransition.queueOnly).toHaveBeenCalledTimes(1);
    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(autoResumeTransition.resume).not.toHaveBeenCalled();
  });

  it("dispatch 직전 consumed로 바뀐 완료는 resume·queue·중복표시를 모두 suppress한다", async () => {
    const deliveryId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId)),
      beginDispatch: vi.fn().mockResolvedValue({
        kind: "suppressed",
        deliveryId,
        reason: "delivery_consumed_before_dispatch",
      }),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    } as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const task = makeTask({ status: "completed" });
    const {
      route,
      autoResumeTransition,
      runningInterventionTransition,
      sessionNotificationPublisher,
    } = makeSubject([task], gate);

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "already consumed child result",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification",
      completionId: "completion-inline-1",
      relationKey: "child_session:child-inline:109",
      source: "completion_notifier",
    }, vi.fn())).resolves.toEqual({
      suppressed: true,
      deliveryId,
      reason: "delivery_consumed_before_dispatch",
    });

    expect(autoResumeTransition.resume).not.toHaveBeenCalled();
    expect(runningInterventionTransition.queueOnly).not.toHaveBeenCalled();
    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(sessionNotificationPublisher.publish).not.toHaveBeenCalled();
    expect(gate.recordResult).not.toHaveBeenCalled();
  });

  it("does not publish completion UI when queueing the delivery fails", async () => {
    const deliveryId = "77777777-7777-4777-8777-777777777777";
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId, "runtime_followup")),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    } as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const task = makeTask({ status: "running" });
    const {
      route,
      runningInterventionTransition,
      sessionNotificationPublisher,
    } = makeSubject([task], gate);
    vi.mocked(runningInterventionTransition.queueOnly).mockRejectedValueOnce(
      new Error("queue unavailable"),
    );

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "background result",
      user: "system",
      deliveryId,
      deliveryIntent: "runtime_followup",
      completionId: "completion-3",
      relationKey: "runtime_task:task-3:100",
      source: "runtime_followup",
    }, vi.fn())).rejects.toThrow("queue unavailable");

    expect(sessionNotificationPublisher.publish).not.toHaveBeenCalled();
    expect(gate.recordFailure).toHaveBeenCalledTimes(1);
  });

  it("does not publish completion UI when terminal auto-resume fails", async () => {
    const deliveryId = "88888888-8888-4888-8888-888888888888";
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId)),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    } as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const task = makeTask({ status: "completed" });
    const {
      route,
      autoResumeTransition,
      sessionNotificationPublisher,
    } = makeSubject([task], gate);
    vi.mocked(autoResumeTransition.resume).mockRejectedValueOnce(
      new Error("resume unavailable"),
    );

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "child completed",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification",
      completionId: "completion-4",
      relationKey: "child_session:child-4:101",
      source: "completion_notifier",
    }, vi.fn())).rejects.toThrow("resume unavailable");

    expect(sessionNotificationPublisher.publish).not.toHaveBeenCalled();
    expect(gate.recordFailure).toHaveBeenCalledTimes(1);
  });

  it("starts an already-resumed terminal task exactly once when ledger staging fails", async () => {
    const deliveryId = "89898989-8989-4898-8989-898989898989";
    const stageError = new Error("notification staging lease expired");
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId)),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockRejectedValue(stageError),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    } as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const task = makeTask({ status: "completed" });
    const { route, autoResumeTransition, sessionNotificationPublisher } =
      makeSubject([task], gate);
    vi.mocked(autoResumeTransition.resume).mockImplementation(
      async (resumedTask, _message, callback) => {
        callback(resumedTask);
        return { autoResumed: true };
      },
    );
    const onResume = vi.fn();

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "runtime result",
      user: "system",
      deliveryId,
      deliveryIntent: "runtime_followup",
      completionId: "completion-stage-failure",
      relationKey: "runtime_task:stage-failure",
      source: "claude_runtime_task_followup",
    }, onResume)).rejects.toBe(stageError);

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith(task);
    expect(gate.recordFailure).toHaveBeenCalledTimes(1);
    expect(sessionNotificationPublisher.publish).not.toHaveBeenCalled();
  });

  it("starts an already-resumed terminal task exactly once when publishing throws", async () => {
    const deliveryId = "90909090-9090-4909-8909-909090909090";
    const publishError = new Error("notification publish unavailable");
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId)),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    } as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const task = makeTask({ status: "completed" });
    const { route, autoResumeTransition, sessionNotificationPublisher } =
      makeSubject([task], gate);
    vi.mocked(autoResumeTransition.resume).mockImplementation(
      async (resumedTask, _message, callback) => {
        callback(resumedTask);
        return { autoResumed: true };
      },
    );
    vi.mocked(sessionNotificationPublisher.publish).mockRejectedValueOnce(publishError);
    const onResume = vi.fn();

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "child completed",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification",
      completionId: "completion-publish-failure",
      relationKey: "child_session:publish-failure:1",
      source: "completion_notifier",
    }, onResume)).rejects.toBe(publishError);

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(gate.recordFailure).not.toHaveBeenCalled();
  });

  it("does not retry the executor callback when the callback itself throws", async () => {
    const deliveryId = "91919191-9191-4919-8919-919191919191";
    const callbackError = new Error("executor already owns a runner");
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId)),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    } as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const task = makeTask({ status: "completed" });
    const { route, autoResumeTransition } = makeSubject([task], gate);
    vi.mocked(autoResumeTransition.resume).mockImplementation(
      async (resumedTask, _message, callback) => {
        callback(resumedTask);
        return { autoResumed: true };
      },
    );
    const onResume = vi.fn(() => {
      throw callbackError;
    });

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "runtime result",
      user: "system",
      deliveryId,
      deliveryIntent: "runtime_followup",
      completionId: "completion-callback-failure",
      relationKey: "runtime_task:callback-failure",
      source: "claude_runtime_task_followup",
    }, onResume)).rejects.toBe(callbackError);

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("durable_next_turn은 notification으로 오인하지 않고 queue-only user delivery를 유지한다", async () => {
    const deliveryId = "66666666-6666-4666-8666-666666666666";
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId, "durable_next_turn")),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    } as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const task = makeTask({ status: "running" });
    const {
      route,
      runningInterventionTransition,
      sessionNotificationPublisher,
    } = makeSubject([task], gate);

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "run this on the next turn",
      user: "scheduler",
      deliveryId,
      deliveryIntent: "durable_next_turn",
      completionId: "schedule-1",
      relationKey: "schedule:schedule-1:run-1",
      source: "schedule_dispatcher",
    }, vi.fn())).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "queue_only_policy",
    });

    expect(runningInterventionTransition.queueOnly).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ deliveryId, deliveryIntent: "durable_next_turn" }),
    );
    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(sessionNotificationPublisher.publish).not.toHaveBeenCalled();
  });
});
