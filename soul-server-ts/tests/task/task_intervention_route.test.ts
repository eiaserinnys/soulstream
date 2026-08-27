import { describe, expect, it, vi } from "vitest";

import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import type { Task } from "../../src/task/task_models.js";
import type { RunningInterventionTransition } from "../../src/task/task_running_intervention_transition.js";
import type {
  DeliveryLedgerAdmission,
  TaskDeliveryLedgerGate,
} from "../../src/task/task_delivery_ledger_gate.js";
import type { SessionNotificationPublisher } from "../../src/task/task_session_notification.js";
import { ExecutionOwnershipConflictError } from
  "../../src/task/execution_ownership.js";

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

function activationBarrier(promise: Promise<void>): NonNullable<Task["executionActivation"]> {
  return {
    promise,
    resolve: () => undefined,
    reject: () => undefined,
  };
}

function makeSubject(
  initialTasks: Task[] = [],
  deliveryLedgerGate?: Pick<
    TaskDeliveryLedgerGate,
    "admit" | "beginDispatch" | "recordResult" | "recordFailure"
      | "recordNotificationPublished" | "recordNotificationFailure"
      | "recordReservationRetry"
  >,
) {
  const tasks = new Map(initialTasks.map((task) => [task.agentSessionId, task]));
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
  intent: "human_live_steer" | "durable_next_turn" | "completion_notification" | "runtime_followup" =
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
        : intent === "human_live_steer"
          ? "user_message"
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
  it("keeps admitted human live steering on the existing live-delivery path", async () => {
    const deliveryId = "77777777-7777-4777-8777-777777777777";
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId, "human_live_steer")),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    } as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const task = makeTask({ status: "running" });
    const { route, runningInterventionTransition } = makeSubject([task], gate);

    await route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "look here",
      user: "alice",
      deliveryId,
      deliveryIntent: "human_live_steer",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:${task.agentSessionId}:${deliveryId}`,
      source: "user_message",
    }, vi.fn());

    expect(runningInterventionTransition.deliver).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ deliveryId, deliveryIntent: "human_live_steer" }),
      { queueIfUndelivered: true },
    );
    expect(runningInterventionTransition.queueOnly).not.toHaveBeenCalled();
  });

  it("routes admitted human steering from the task state at durable dispatch", async () => {
    const deliveryId = "78787878-7878-4787-8787-787878787878";
    const task = makeTask({ status: "running" });
    const admission = admitted(deliveryId, "human_live_steer");
    const gate = {
      admit: vi.fn().mockResolvedValue(admission),
      beginDispatch: vi.fn(async (candidate) => {
        task.status = "completed";
        return candidate;
      }),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
    } as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
    >;
    const {
      route,
      autoResumeTransition,
      runningInterventionTransition,
    } = makeSubject([task], gate);

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "continue after restart",
      user: "alice",
      deliveryId,
      deliveryIntent: "human_live_steer",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:${task.agentSessionId}:${deliveryId}`,
      source: "user_message",
    }, vi.fn())).resolves.toEqual({ autoResumed: true });

    expect(autoResumeTransition.resume).toHaveBeenCalledOnce();
    expect(autoResumeTransition.resume).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ deliveryId, deliveryIntent: "human_live_steer" }),
      expect.any(Function),
    );
    expect(runningInterventionTransition.deliver).not.toHaveBeenCalled();
    expect(runningInterventionTransition.queueOnly).not.toHaveBeenCalled();
  });

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
      resumedTask.executionActivation = activationBarrier(activation);
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
      resumedTask.executionActivation = activationBarrier(Promise.reject(
        new Error("execution activation rejected"),
      ));
    });

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "resume",
      user: "alice",
    }, onResume)).rejects.toThrow("execution activation rejected");
  });

  it("queues a fenced auto-resume and schedules the same durable delivery without exposing an error", async () => {
    const task = makeTask({ status: "completed" });
    const deliveryId = "64646464-6464-4464-8464-646464646464";
    const recordReservationRetry = vi.fn().mockResolvedValue("scheduled");
    const gate = {
      admit: vi.fn().mockResolvedValue(admitted(deliveryId, "durable_next_turn")),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
      recordReservationRetry,
    } satisfies Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
        | "recordReservationRetry"
    >;
    const { route, autoResumeTransition } = makeSubject([task], gate);
    const retryAt = "2026-08-19T00:08:30.000Z";
    const rejected = new ExecutionOwnershipConflictError(
      task.agentSessionId,
      retryAt,
      "reserved",
    );
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
      text: "resume",
      user: "alice",
      deliveryId,
      deliveryIntent: "durable_next_turn",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:${task.agentSessionId}:${deliveryId}`,
    }, (resumedTask) => {
      resumedTask.executionActivation = activationBarrier(Promise.reject(rejected));
    })).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "queue_only_policy",
    });
    expect(recordReservationRetry).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId }),
      retryAt,
    );
  });

  it("keeps an unlabelled human intervention human while assigning durable identity", async () => {
    const task = makeTask({ status: "completed" });
    const admit = vi.fn().mockImplementation(async (params) => ({
      kind: "suppressed",
      deliveryId: params.deliveryId,
      reason: "captured",
    }));
    const gate = {
      admit,
      beginDispatch: vi.fn(),
      recordResult: vi.fn(),
      recordFailure: vi.fn(),
      recordReservationRetry: vi.fn(),
    } as unknown as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
        | "recordReservationRetry"
    >;
    const { route } = makeSubject([task], gate);

    await route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "durable user message",
      user: "alice",
    }, vi.fn());

    expect(admit).toHaveBeenCalledWith(expect.objectContaining({
      deliveryIntent: "human_live_steer",
      source: "user_message",
      deliveryId: expect.any(String),
      completionId: expect.stringMatching(/^message:/),
      relationKey: expect.stringMatching(/^user_message:sess-intervention:/),
      deliveryCreatedAt: expect.any(String),
    }));
  });

  it("preserves live steering for a human intervention on an already running task", async () => {
    const task = makeTask({ status: "running" });
    const admit = vi.fn().mockResolvedValue({ kind: "legacy" });
    const gate = {
      admit,
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn(),
      recordFailure: vi.fn(),
      recordReservationRetry: vi.fn(),
    } as unknown as Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
        | "recordReservationRetry"
    >;
    const { route, runningInterventionTransition } = makeSubject([task], gate);

    await route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "steer now",
      user: "alice",
    }, vi.fn());

    expect(admit).toHaveBeenCalledWith(expect.not.objectContaining({
      deliveryIntent: "durable_next_turn",
    }));
    expect(runningInterventionTransition.deliver).toHaveBeenCalledOnce();
  });

  it("auto-resumes a recovered user delivery without publishing its user event twice", async () => {
    const task = makeTask({ status: "completed" });
    const deliveryId = "65656565-6565-4565-8565-656565656565";
    const recovered = admitted(deliveryId, "durable_next_turn");
    if (recovered.kind !== "admitted") throw new Error("admission fixture mismatch");
    recovered.row.attempt_count = 1;
    const gate = {
      admit: vi.fn().mockResolvedValue(recovered),
      beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
      recordResult: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
      recordReservationRetry: vi.fn(),
    } satisfies Pick<
      TaskDeliveryLedgerGate,
      "admit" | "beginDispatch" | "recordResult" | "recordFailure"
        | "recordReservationRetry"
    >;
    const { route, autoResumeTransition } = makeSubject([task], gate);

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "retry",
      user: "alice",
      deliveryId,
      deliveryIntent: "durable_next_turn",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:${task.agentSessionId}:${deliveryId}`,
      deliveryLeaseOwner: "recovery-worker",
    }, vi.fn())).resolves.toEqual({ autoResumed: true });

    expect(autoResumeTransition.resume).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ deliveryId, deliveryIntent: "durable_next_turn" }),
      expect.any(Function),
      { publishUserMessage: false },
    );
  });

  it.each([
    "human_live_steer",
    "durable_next_turn",
    "completion_notification",
    "runtime_followup",
  ] as const)(
    "selects first idle resume inputs from delivery facts, not %s intent",
    async (intent) => {
      const deliveryId = `73737373-7373-4737-8737-${intent.length.toString().padStart(12, "0")}`;
      const gate = {
        admit: vi.fn().mockResolvedValue(admitted(deliveryId, intent)),
        beginDispatch: vi.fn((candidate) => Promise.resolve(candidate)),
        recordResult: vi.fn().mockResolvedValue(undefined),
        recordFailure: vi.fn().mockResolvedValue(undefined),
      } satisfies Pick<
        TaskDeliveryLedgerGate,
        "admit" | "beginDispatch" | "recordResult" | "recordFailure"
      >;
      const task = makeTask({ status: "completed" });
      const { route, autoResumeTransition } = makeSubject([task], gate);

      await expect(route.addIntervention({
        agentSessionId: task.agentSessionId,
        text: "first idle delivery",
        user: "agent",
        deliveryId,
        deliveryIntent: intent,
        completionId: `completion:${deliveryId}`,
        relationKey: `delivery:${deliveryId}`,
        source: "test",
      }, vi.fn())).resolves.toEqual({ autoResumed: true });

      expect(autoResumeTransition.resume).toHaveBeenCalledOnce();
      expect(vi.mocked(autoResumeTransition.resume).mock.calls[0]).toHaveLength(3);
    },
  );

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
      resumedTask.executionActivation = activationBarrier(activation);
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
      resumedTask.executionActivation = activationBarrier(Promise.reject(
        new Error("activation rejected"),
      ));
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
    task.executionActivation = activationBarrier(new Promise<void>((resolve) => {
      resolveActivation = () => {
        task.status = "running";
        resolve();
      };
    }));
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
    "runtime follow-up uses the same first-class %s intervention entry",
    async (status) => {
    const task = makeTask({ status });
    const { route, runningInterventionTransition, autoResumeTransition } = makeSubject([task]);

    await expect(route.addIntervention({
      agentSessionId: "sess-intervention",
      text: "delayed background follow-up retry",
      user: "system",
      source: "claude_runtime_task_followup",
    }, vi.fn())).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "queue_only_policy",
    });

    expect(runningInterventionTransition.deliver).toHaveBeenCalledOnce();
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

  it("routes hydrated running tasks to the existing runner queue", async () => {
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
    }, vi.fn())).resolves.toEqual({
      delivered: false,
      queued: true,
      queuePosition: 1,
      consumeWhen: "next_turn",
      reason: "queue_only_policy",
    });

    expect(tasks.get("sess-stale-running")).toBe(hydrated);
    expect(hydrated.status).toBe("running");
    expect(runningInterventionTransition.deliver).toHaveBeenCalledWith(
      hydrated,
      expect.objectContaining({
      text: "resume stale running",
      }),
      { queueIfUndelivered: true },
    );
    expect(autoResumeTransition.resume).not.toHaveBeenCalled();
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

  it("generating 중 완료도 running deliver로 즉시 전달한다", async () => {
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
      vi.mocked(runningInterventionTransition.deliver).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(sessionNotificationPublisher.publish).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(gate.recordResult).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sessionNotificationPublisher.publish).mock.invocationCallOrder[0]!,
    );
    expect(runningInterventionTransition.deliver).toHaveBeenCalledTimes(1);
    expect(runningInterventionTransition.queueOnly).not.toHaveBeenCalled();
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
    vi.mocked(runningInterventionTransition.deliver).mockRejectedValueOnce(
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
    const activation = activationBarrier(Promise.resolve());
    vi.mocked(autoResumeTransition.resume).mockImplementation(
      async (resumedTask, _message, callback) => {
        callback(resumedTask, activation);
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
    expect(onResume).toHaveBeenCalledWith(task, activation);
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

  it("durable_next_turn도 running deliver로 즉시 전달하되 notification은 발행하지 않는다", async () => {
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

    expect(runningInterventionTransition.deliver).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ deliveryId, deliveryIntent: "durable_next_turn" }),
      { queueIfUndelivered: true },
    );
    expect(runningInterventionTransition.queueOnly).not.toHaveBeenCalled();
    expect(sessionNotificationPublisher.publish).not.toHaveBeenCalled();
  });
});
