import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { TaskExecutorFinalizer } from "../../src/task/task_executor_finalizer.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";

/**
 * 260824 evidence: events 2349/2350/2352 recorded assistant result + complete at 14:36:39Z.
 * Event 2356 then ended the same request at 14:37:39Z with a 30s Runner IPC timeout.
 * The earlier D contract stops at the caller route; it does not cross finalizer -> V2 notification.
 * Current admitted completion delivery queues there, bypassing the released owner's next generation.
 */
describe("D post-complete V2 finalizer regression", () => {
  it("keeps child completion and starts exactly one caller generation without old-runner IPC", async () => {
    const child = makeTask("child", {
      status: "completed",
      callerSessionId: "caller",
      terminalEventId: 2352,
    });
    const caller = makeTask("caller", {
      status: "running",
      runner: {
        engine: {} as never,
        dispatcher: { hasActiveExecution: () => false } as never,
      },
    });
    const terminalTransition = vi.fn().mockResolvedValue({
      newlyFinalized: true,
      terminalTransitionApplied: true,
    });
    const oldRunnerIpc = vi.fn();
    const nextGeneration = vi.fn();
    const notificationPublish = vi.fn().mockResolvedValue({
      published: true,
      targetReceiptId: "event:notification",
    });
    const deliveryId = "d0000000-0000-4000-8000-000000000001";
    const admission = {
      kind: "admitted" as const,
      deliveryId,
      row: {
        delivery_id: deliveryId,
        intent: "completion_notification",
        source: "completion_notifier",
        completion_id: "completion:child:2352",
        relation_key: "child_session:child:2352",
        producer_terminal_revision: "2352",
        parent_delivery_id: null,
        caller_turn_id: null,
        lease_owner: "d-regression",
        attempt_count: 0,
        created_at: new Date("2026-08-24T14:36:39.375Z"),
        payload: { text: "child completed", user: "agent" },
        payload_hash: "hash:d-regression",
      } as never,
    };
    const gate = {
      admit: vi.fn().mockResolvedValue(admission),
      beginDispatch: vi.fn().mockResolvedValue(admission),
      recordResult: vi.fn(),
      recordFailure: vi.fn(),
      recordNotificationPublished: vi.fn(),
      recordNotificationFailure: vi.fn(),
      recordReservationRetry: vi.fn(),
    };
    const route = new TaskInterventionRoute({
      getTask: (sessionId) => sessionId === caller.agentSessionId ? caller : undefined,
      loadEvictedTask: vi.fn().mockResolvedValue(null),
      rememberTask: vi.fn(),
      runningInterventionTransition: {
        deliver: oldRunnerIpc,
        queueOnly: vi.fn(),
      } as never,
      autoResumeTransition: {
        resume: vi.fn(async (task, _message, onResume) => {
          task.status = "initializing";
          onResume(task);
          return { autoResumed: true } as const;
        }),
      } as never,
      deliveryLedgerGate: gate,
      sessionNotificationPublisher: { publish: notificationPublish },
    });
    let deliveryResult: Awaited<ReturnType<typeof route.addIntervention>> | undefined;
    const completionNotifier = {
      notify: vi.fn(async () => {
        deliveryResult = await route.addIntervention({
          agentSessionId: caller.agentSessionId,
          text: "child completed",
          user: "agent",
          deliveryId,
          deliveryIntent: "completion_notification",
          completionId: "completion:child:2352",
          relationKey: "child_session:child:2352",
          producerTerminalRevision: "2352",
          deliveryLeaseOwner: "d-regression",
        }, (task) => {
          nextGeneration();
          task.status = "running";
        });
      }),
    };
    const finalizer = new TaskExecutorFinalizer({
      lifecycleTransition: { persistExecutorFinalState: terminalTransition },
      completionNotifier,
      logger: { warn: vi.fn() } as unknown as Logger,
    });

    await finalizer.finalize(child);

    expect(child.status).toBe("completed");
    expect(child.terminalEventId).toBe(2352);
    expect(terminalTransition).toHaveBeenCalledOnce();
    expect(completionNotifier.notify).toHaveBeenCalledOnce();
    expect(deliveryResult).toEqual({ autoResumed: true });
    expect(oldRunnerIpc).not.toHaveBeenCalled();
    expect(nextGeneration).toHaveBeenCalledOnce();
    expect(notificationPublish).toHaveBeenCalledOnce();
    expect(notificationPublish).toHaveBeenCalledWith(
      caller,
      expect.objectContaining({ deliveryId }),
      "auto_resume",
    );
  });
});

function makeTask(agentSessionId: string, overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId,
    prompt: "D regression",
    status: "running",
    createdAt: new Date("2026-08-24T14:36:00.000Z"),
    lastEventId: 2352,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
}
