import { describe, expect, it, vi } from "vitest";

import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import { ExecutionOwnershipConflictError } from
  "../../src/task/execution_ownership.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "parent-1",
    prompt: "prompt",
    status: "completed",
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 3,
    interventionQueue: [],
    ...overrides,
  };
}

function admission(intent = "completion_notification" as const) {
  return {
    kind: "admitted" as const,
    deliveryId: "delivery-1",
    row: {
      delivery_id: "delivery-1",
      target_session_id: "parent-1",
      intent,
      source: "completion_notifier",
      relation_key: "child_session:child-1:42",
      completion_id: "completion-1",
      lease_owner: "worker-1",
      attempt_count: 0,
      created_at: new Date("2026-08-30T00:00:00.000Z"),
      payload_hash: "hash-1",
      payload: { text: "done", user: "agent", source: "completion_notifier" },
    } as never,
  };
}

function subject(current: Task, resume = vi.fn().mockResolvedValue({ autoResumed: true })) {
  const admitted = admission();
  const gate = {
    admit: vi.fn().mockResolvedValue(admitted),
    beginDispatch: vi.fn().mockResolvedValue(admitted),
    recordResult: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    recordNotificationPublished: vi.fn().mockResolvedValue(undefined),
    recordNotificationFailure: vi.fn().mockResolvedValue(undefined),
  };
  const running = {
    deliver: vi.fn().mockResolvedValue({
      delivered: true,
      queued: false,
      consumeWhen: "current_turn",
    }),
    queueOnly: vi.fn(),
  };
  const notification = {
    publish: vi.fn().mockResolvedValue({
      published: true,
      targetReceiptId: "event:notification",
    }),
  };
  const route = new TaskInterventionRoute({
    getTask: () => current,
    loadEvictedTask: async () => null,
    rememberTask: () => undefined,
    runningInterventionTransition: running as never,
    autoResumeTransition: { resume } as never,
    deliveryLedgerGate: gate as never,
    sessionNotificationPublisher: notification as never,
  });
  return { route, gate, running, resume, notification };
}

const params = {
  agentSessionId: "parent-1",
  text: "done",
  user: "agent",
  source: "completion_notifier",
  deliveryId: "delivery-1",
  deliveryIntent: "completion_notification" as const,
  completionId: "completion-1",
  relationKey: "child_session:child-1:42",
  deliveryLeaseOwner: "worker-1",
};

describe("TaskInterventionRoute", () => {
  it("intervenes when the canonical execution slot exists regardless of status", async () => {
    const current = task({
      status: "completed",
      executionPromise: new Promise<void>(() => undefined),
    });
    const { route, running, resume } = subject(current);

    await route.addIntervention(params, vi.fn());

    expect(running.deliver).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
  });

  it("auto-resumes when no canonical execution exists regardless of status", async () => {
    const current = task({ status: "running", executionPromise: undefined });
    const { route, running, resume } = subject(current);

    await expect(route.addIntervention(params, vi.fn()))
      .resolves.toEqual({ autoResumed: true });

    expect(resume).toHaveBeenCalledOnce();
    expect(running.deliver).not.toHaveBeenCalled();
  });

  it("publishes completed-parent notification after auto-resume admission", async () => {
    const current = task({ status: "completed" });
    const { route, gate, notification } = subject(current);

    await route.addIntervention(params, vi.fn());

    expect(gate.recordResult).toHaveBeenCalledOnce();
    expect(notification.publish).toHaveBeenCalledWith(
      current,
      expect.objectContaining({ deliveryId: "delivery-1" }),
      "auto_resume",
    );
    expect(gate.recordNotificationPublished).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: "delivery-1" }),
      "event:notification",
    );
  });

  it("does not mask ownership conflict as queued success", async () => {
    const conflict = new ExecutionOwnershipConflictError(
      "parent-1",
      "2026-08-30T00:01:00.000Z",
      "reserved",
    );
    const resume = vi.fn().mockRejectedValue(conflict);
    const { route, gate } = subject(task(), resume);

    await expect(route.addIntervention(params, vi.fn())).rejects.toBe(conflict);

    expect(gate.recordFailure).toHaveBeenCalledOnce();
  });
});
