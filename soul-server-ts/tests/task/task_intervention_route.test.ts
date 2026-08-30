import { describe, expect, it, vi } from "vitest";

import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import type {
  DeliveryLedgerAdmission,
  TaskDeliveryLedgerGate,
} from "../../src/task/task_delivery_ledger_gate.js";
import type { Task } from "../../src/task/task_models.js";
import type { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";

function makeTask(active: boolean): Task {
  return {
    agentSessionId: "sess-intervention",
    prompt: "original prompt",
    status: "running",
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
    lastEventId: 7,
    lastReadEventId: 3,
    ...(active
      ? {
          runner: {
            dispatcher: { hasActiveExecution: () => true },
          } as never,
        }
      : {}),
  };
}

function admitted(deliveryId: string): DeliveryLedgerAdmission {
  return {
    kind: "admitted",
    deliveryId,
    row: {
      delivery_id: deliveryId,
      target_session_id: "sess-intervention",
      intent: "human_live_steer",
      source: "user_message",
      completion_id: `message:${deliveryId}`,
      relation_key: `user_message:sess-intervention:${deliveryId}`,
      producer_terminal_revision: null,
      parent_delivery_id: null,
      caller_turn_id: null,
      lease_owner: `delivery:${deliveryId}`,
      attempt_count: 0,
      created_at: new Date("2026-08-30T00:00:00.000Z"),
      payload: {
        text: "canonical D",
        user: "alice",
        attachment_paths: null,
        context: null,
        caller_info: null,
        followup_task_ids: null,
      },
      payload_hash: `hash:${deliveryId}`,
    } as never,
  };
}

function makeSubject(task: Task, admission: DeliveryLedgerAdmission) {
  const gate = {
    admit: vi.fn().mockResolvedValue(admission),
    beginDispatch: vi.fn().mockResolvedValue(admission),
    recordResult: vi.fn().mockResolvedValue(undefined),
  } as unknown as Pick<
    TaskDeliveryLedgerGate,
    "admit" | "beginDispatch" | "recordResult"
  >;
  const running = {
    deliver: vi.fn().mockResolvedValue({ delivered: true }),
  } as unknown as Pick<RunningInterventionTransition, "deliver">;
  const autoResume = {
    resume: vi.fn().mockResolvedValue({ autoResumed: true }),
  } as unknown as Pick<AutoResumeTransition, "resume">;
  const route = new TaskInterventionRoute({
    getTask: () => task,
    loadEvictedTask: vi.fn(async () => null),
    rememberTask: vi.fn(),
    runningInterventionTransition: running,
    autoResumeTransition: autoResume,
    deliveryLedgerGate: gate,
  });
  return { route, gate, running, autoResume };
}

describe("TaskInterventionRoute exact delivery ownership", () => {
  it("routes the canonical accepted D to the active generation", async () => {
    const deliveryId = "77777777-7777-4777-8777-777777777777";
    const admission = admitted(deliveryId);
    const task = makeTask(true);
    const { route, gate, running, autoResume } = makeSubject(task, admission);
    const onResume = vi.fn();

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "untrusted request copy",
      user: "request-user",
      deliveryId,
      deliveryIntent: "human_live_steer",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:${task.agentSessionId}:${deliveryId}`,
      source: "user_message",
    }, onResume)).resolves.toEqual({ delivered: true });

    expect(running.deliver).toHaveBeenCalledWith(task, expect.objectContaining({
      text: "canonical D",
      user: "alice",
      deliveryId,
      deliveryLeaseOwner: `delivery:${deliveryId}`,
    }));
    expect(gate.recordResult).toHaveBeenCalledWith(admission, { delivered: true });
    expect(autoResume.resume).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("uses the same canonical D when no active generation exists", async () => {
    const deliveryId = "88888888-8888-4888-8888-888888888888";
    const admission = admitted(deliveryId);
    const task = makeTask(false);
    task.status = "completed";
    const { route, gate, running, autoResume } = makeSubject(task, admission);

    await expect(route.addIntervention({
      agentSessionId: task.agentSessionId,
      text: "request copy",
      user: "request-user",
      deliveryId,
      deliveryIntent: "human_live_steer",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:${task.agentSessionId}:${deliveryId}`,
      source: "user_message",
    }, vi.fn())).resolves.toEqual({ autoResumed: true });

    expect(autoResume.resume).toHaveBeenCalledWith(
      task,
      expect.objectContaining({
        text: "canonical D",
        deliveryId,
        deliveryLeaseOwner: `delivery:${deliveryId}`,
      }),
      expect.any(Function),
    );
    expect(gate.recordResult).toHaveBeenCalledWith(admission, { autoResumed: true });
    expect(running.deliver).not.toHaveBeenCalled();
  });

  it("does not enter either execution path for a suppressed D", async () => {
    const deliveryId = "99999999-9999-4999-8999-999999999999";
    const admission: DeliveryLedgerAdmission = {
      kind: "suppressed",
      deliveryId,
      reason: "already_consumed",
    };
    const { route, gate, running, autoResume } = makeSubject(makeTask(true), admission);

    await expect(route.addIntervention({
      agentSessionId: "sess-intervention",
      text: "duplicate",
      user: "alice",
      deliveryId,
      deliveryIntent: "human_live_steer",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:sess-intervention:${deliveryId}`,
      source: "user_message",
    }, vi.fn())).resolves.toEqual({
      suppressed: true,
      deliveryId,
      reason: "already_consumed",
    });

    expect(gate.beginDispatch).not.toHaveBeenCalled();
    expect(running.deliver).not.toHaveBeenCalled();
    expect(autoResume.resume).not.toHaveBeenCalled();
  });
});
