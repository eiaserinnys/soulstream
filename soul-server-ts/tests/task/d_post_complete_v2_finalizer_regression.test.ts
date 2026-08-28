import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { TaskDeliveryConsumption } from "../../src/task/task_delivery_consumption.js";
import { TaskDeliveryTurnReceipt } from "../../src/task/task_delivery_turn_receipt.js";
import { TaskExecutorFinalizer } from "../../src/task/task_executor_finalizer.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import { TaskTurnInputBuilder } from "../../src/task/task_turn_input_builder.js";

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

  it("carries a terminal completion delivery into one explicit next turn", async () => {
    const deliveryId = "e3cd7f73-bd82-5a3e-8a92-389676dfa4dd";
    const task = makeTask("caller", { status: "completed", lastEventId: 5215 });
    const logger = makeLogger();
    let deliveryState: "dispatching" | "queued" | "consumed" = "dispatching";
    const admission = {
      kind: "admitted" as const,
      deliveryId,
      row: {
        delivery_id: deliveryId,
        intent: "completion_notification",
        source: "completion_notifier",
        completion_id: "completion:row5215",
        relation_key: "child_session:row5215",
        producer_terminal_revision: "5215",
        parent_delivery_id: null,
        caller_turn_id: null,
        lease_owner: "d-live-red",
        attempt_count: 0,
        created_at: new Date("2026-08-28T00:00:00.000Z"),
        payload: { text: "row5215 child completed", user: "agent" },
        payload_hash: "hash:row5215",
      } as never,
    };
    const recordResult = vi.fn(async () => {
      deliveryState = "queued";
    });
    const notificationPublish = vi.fn().mockResolvedValue({
      published: true,
      targetReceiptId: "event:5215",
    });
    const transition = new RunningInterventionTransition({
      broadcaster: {} as never,
      logger,
    });
    const route = new TaskInterventionRoute({
      getTask: () => task,
      loadEvictedTask: vi.fn().mockResolvedValue(null),
      rememberTask: vi.fn(),
      runningInterventionTransition: transition,
      autoResumeTransition: { resume: vi.fn() } as never,
      deliveryLedgerGate: {
        admit: vi.fn().mockResolvedValue(admission),
        beginDispatch: vi.fn().mockResolvedValue(admission),
        recordResult,
        recordFailure: vi.fn(),
        recordNotificationPublished: vi.fn(),
        recordNotificationFailure: vi.fn(),
        recordReservationRetry: vi.fn(),
      },
      sessionNotificationPublisher: { publish: notificationPublish },
    });

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "row5215 child completed",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification",
      completionId: "completion:row5215",
      relationKey: "child_session:row5215",
      producerTerminalRevision: "5215",
      deliveryLeaseOwner: "d-live-red",
    }, vi.fn())).resolves.toMatchObject({ queued: true, consumeWhen: "next_turn" });

    expect(deliveryState).toBe("queued");
    expect(recordResult).toHaveBeenCalledOnce();
    expect(notificationPublish).toHaveBeenCalledOnce();
    expect(task.interventionQueue).toEqual([
      expect.objectContaining({ deliveryId, deliveryIntent: "completion_notification" }),
    ]);

    task.status = "running";
    const initialMessagePublisher = { publishInitialMessages: vi.fn() };
    const input = await new TaskTurnInputBuilder({
      initialMessagePublisher,
      logger,
    }).prepareInitialTurnInput(task, makeAgent());
    const recordTurnStarted = vi.fn();
    const recordConsumed = vi.fn(async () => {
      deliveryState = "consumed";
    });
    const consumption = new TaskDeliveryConsumption({
      recordTurnStarted,
      recordConsumed,
      discardIfConsumed: vi.fn(),
    }, logger);
    const receipt = new TaskDeliveryTurnReceipt(consumption, input.interventions ?? []);
    await receipt.observe(task, { type: "assistant_message", content: "accepted" });
    await receipt.consume(task);

    expect(input.prompt).toContain("row5215 child completed");
    expect(input.interventions).toHaveLength(1);
    expect(recordTurnStarted).toHaveBeenCalledOnce();
    expect(recordConsumed).toHaveBeenCalledOnce();
    expect(deliveryState).toBe("consumed");
    expect(task.interventionQueue).toHaveLength(0);
    expect(initialMessagePublisher.publishInitialMessages).not.toHaveBeenCalled();
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

function makeAgent(): AgentProfile {
  return {
    id: "d-live-red",
    name: "D live RED",
    backend: "codex",
    workspace_dir: "/tmp/d-live-red",
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}
