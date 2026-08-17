import { describe, expect, it, vi } from "vitest";

import type { SessionDeliveryRow } from "../../src/db/session_db_types.js";
import { TaskDeliveryLedgerGate } from "../../src/task/task_delivery_ledger_gate.js";

function row(deliveryId: string, state: SessionDeliveryRow["state"]): SessionDeliveryRow {
  return {
    delivery_id: deliveryId,
    state,
  } as SessionDeliveryRow;
}

describe("TaskDeliveryLedgerGate", () => {
  it("binds attachment, context, and caller_info into the payload identity", async () => {
    const register = vi.fn(async (params: { deliveryId: string }) => ({
      row: row(params.deliveryId, "pending"),
      inserted: true,
      conflict: false,
    }));
    const claimForTarget = vi.fn(
      async (deliveryId: string) => row(deliveryId, "claimed"),
    );
    const gate = new TaskDeliveryLedgerGate(true, {
      register,
      claimForTarget,
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });
    const base = {
      agentSessionId: "caller-1",
      text: "done",
      user: "agent",
      deliveryId: "99999999-9999-4999-8999-999999999999",
      deliveryIntent: "completion_notification" as const,
      completionId: "completion-1",
      relationKey: "child_session:child-1:42",
      source: "completion_notifier",
      context: [{ key: "task", content: "render" }],
      callerInfo: { source: "agent", agent_id: "child-1" },
    };

    await gate.admit({ ...base, attachmentPaths: ["/tmp/result.png"] });
    await gate.admit({
      ...base,
      deliveryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attachmentPaths: ["/tmp/other.png"],
    });

    const first = register.mock.calls[0]![0];
    const second = register.mock.calls[1]![0];
    expect(first.payload).toMatchObject({
      attachment_paths: ["/tmp/result.png"],
      context: [{ key: "task", content: "render" }],
      caller_info: { source: "agent", agent_id: "child-1" },
    });
    expect(first.payloadHash).not.toBe(second.payloadHash);
  });

  it("routes an exact runtime replay through repository admission coalescing", async () => {
    const deliveryId = "91919191-9191-4919-8919-919191919191";
    const register = vi.fn().mockResolvedValue({
      row: {
        ...row(deliveryId, "consumed"),
        relation_key: "runtime-relation-1",
        completion_id: "runtime-completion-1",
        intent: "runtime_followup",
      },
      inserted: false,
      conflict: false,
    });
    const get = vi.fn();
    const gate = new TaskDeliveryLedgerGate(true, {
      register,
      claimForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get,
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });

    await expect(gate.admit({
      agentSessionId: "caller-1",
      text: "runtime replay",
      user: "system",
      deliveryId,
      deliveryIntent: "runtime_followup",
      completionId: "runtime-completion-1",
      relationKey: "runtime-relation-1",
      source: "claude_runtime_task_followup",
      followupKey: "caller-1:task-1",
      followupAttempt: 3,
    })).resolves.toEqual({
      kind: "suppressed",
      deliveryId,
      reason: "delivery_consumed",
    });

    expect(register).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("records an inline completion against its semantic relation and caller turn", async () => {
    const deliveryId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const pending = row(deliveryId, "pending");
    const consumed = row(deliveryId, "consumed");
    const register = vi.fn().mockResolvedValue({
      row: pending,
      inserted: true,
      conflict: false,
    });
    const markConsumedByRelation = vi.fn().mockResolvedValue(consumed);
    const gate = new TaskDeliveryLedgerGate(true, {
      register,
      claimForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation,
      recordRelationConsumed: vi.fn(),
    });

    await expect(gate.recordInlineConsumed({
      agentSessionId: "caller-1",
      text: "runtime finished",
      user: "system",
      deliveryId,
      deliveryIntent: "runtime_followup",
      completionId: "completion-runtime-1",
      relationKey: "claude_runtime:caller-1:session-1:task-1@77",
      source: "claude_runtime_task_followup",
    }, {
      agentSessionId: "caller-1",
      prompt: "run",
      status: "running",
      createdAt: new Date(),
      lastEventId: 91,
      lastReadEventId: 0,
      interventionQueue: [],
    })).resolves.toBe(true);

    expect(markConsumedByRelation).toHaveBeenCalledWith(
      "claude_runtime:caller-1:session-1:task-1@77",
      "completion-runtime-1",
      "event:91",
    );
  });

  it("records a child completion relation even before a notifier delivery row exists", async () => {
    const recordRelationConsumed = vi.fn().mockResolvedValue({
      relation: {},
      relationInserted: true,
      deliveryConsumed: false,
    });
    const markConsumed = vi.fn();
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed,
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed,
    });

    await gate.recordConsumed({
      text: "child result already consumed inline",
      user: "agent",
      deliveryIntent: "completion_notification",
      completionId: "completion-child-42",
      relationKey: "child_session:child-1:42",
    }, {
      agentSessionId: "caller-1",
      prompt: "delegate",
      status: "running",
      createdAt: new Date(),
      lastEventId: 93,
      lastReadEventId: 0,
      interventionQueue: [],
    });

    expect(recordRelationConsumed).toHaveBeenCalledWith({
      relationKey: "child_session:child-1:42",
      completionId: "completion-child-42",
      callerSessionId: "caller-1",
      consumedTurnId: "event:93",
    });
    expect(markConsumed).not.toHaveBeenCalled();
  });

  it("fails closed when exact runtime consumption CAS misses unless the row is already consumed", async () => {
    const deliveryId = "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc";
    const get = vi.fn()
      .mockResolvedValueOnce(row(deliveryId, "pending"))
      .mockResolvedValueOnce(row(deliveryId, "consumed"));
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get,
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn().mockResolvedValue(null),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });
    const message = {
      text: "runtime followup",
      user: "system",
      source: "claude_runtime_task_followup",
      deliveryId,
      deliveryIntent: "runtime_followup" as const,
    };
    const task = {
      agentSessionId: "caller-1",
      prompt: "run",
      status: "running" as const,
      createdAt: new Date(),
      lastEventId: 94,
      lastReadEventId: 0,
      interventionQueue: [],
    };

    await expect(gate.recordConsumed(message, task)).rejects.toThrow(
      `Exact delivery consumption did not reach consumed state: ${deliveryId}`,
    );
    await expect(gate.recordConsumed(message, task)).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("propagates a completion-notification consumption repository error", async () => {
    const deliveryId = "bdbdbdbd-bdbd-4bdb-8bdb-bdbdbdbdbdbd";
    const repositoryError = new Error("delivery consume write failed");
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn().mockRejectedValue(repositoryError),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });

    await expect(gate.recordConsumed({
      text: "completion notification",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification",
      completionId: "completion-notification-1",
      relationKey: "completion-notification-relation-1",
      source: "completion_notifier",
    }, {
      agentSessionId: "caller-1",
      prompt: "run",
      status: "running",
      createdAt: new Date(),
      lastEventId: 95,
      lastReadEventId: 0,
      interventionQueue: [],
    })).rejects.toBe(repositoryError);
  });

  it.each([
    "pending",
    "claimed",
    "dispatching",
    "queued",
    "delivered",
    "consumed",
    "superseded",
    "uncertain",
  ] as const)("reports the actual %s state when dispatch CAS loses", async (state) => {
    const deliveryId = `dispatch-cas-${state}`;
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimForTarget: vi.fn(),
      beginDispatch: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(row(deliveryId, state)),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });

    await expect(gate.beginDispatch({
      kind: "admitted",
      deliveryId,
      row: row(deliveryId, "claimed"),
    })).resolves.toEqual({
      kind: "suppressed",
      deliveryId,
      reason: `delivery_${state}_before_dispatch`,
    });
  });

  it("reports a missing row when dispatch CAS loses without durable evidence", async () => {
    const deliveryId = "dispatch-cas-missing";
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimForTarget: vi.fn(),
      beginDispatch: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
    });

    await expect(gate.beginDispatch({
      kind: "admitted",
      deliveryId,
      row: row(deliveryId, "claimed"),
    })).resolves.toEqual({
      kind: "suppressed",
      deliveryId,
      reason: "delivery_missing_before_dispatch",
    });
  });

  it("reserves a terminal-only retry as pending at its due time", async () => {
    const deliveryId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const retryLeasedDelivery = vi.fn().mockResolvedValue(row(deliveryId, "pending"));
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
      retryLeasedDelivery,
      markPendingSuperseded: vi.fn(),
    });
    const dueAt = "2026-08-18T04:00:05.000Z";

    await gate.recordResult({
      kind: "admitted",
      deliveryId,
      row: {
        ...row(deliveryId, "claimed"),
        lease_owner: "route-1",
      },
    }, {
      deferred: true,
      reason: "terminal_only_policy",
    }, dueAt);

    expect(retryLeasedDelivery).toHaveBeenCalledWith(
      deliveryId,
      "route-1",
      "scheduled_runtime_followup_retry",
      new Date(dueAt),
    );
  });

  it("fences an uncertain result to the active dispatch lease", async () => {
    const deliveryId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const markUncertain = vi.fn().mockResolvedValue(row(deliveryId, "uncertain"));
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain,
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
      retryLeasedDelivery: vi.fn(),
      markPendingSuperseded: vi.fn(),
    });

    await gate.recordResult({
      kind: "admitted",
      deliveryId,
      row: {
        ...row(deliveryId, "dispatching"),
        lease_owner: "route-uncertain",
      },
    }, {
      delivered: null,
      reason: "verdict_unknown",
      consumeWhen: null,
    });

    expect(markUncertain).toHaveBeenCalledWith(
      deliveryId,
      "route-uncertain",
      "delivery_result_not_accepted",
    );
  });

  it("supersedes only the pending durable retry selected by id", async () => {
    const deliveryId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const markPendingSuperseded = vi.fn().mockResolvedValue(
      row(deliveryId, "superseded"),
    );
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimForTarget: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
      retryLeasedDelivery: vi.fn(),
      markPendingSuperseded,
    });

    await expect(gate.recordPendingSuperseded({
      text: "retry",
      user: "system",
      deliveryId,
      deliveryIntent: "runtime_followup",
    }, "user_message")).resolves.toBe(true);

    expect(markPendingSuperseded).toHaveBeenCalledWith(deliveryId, "user_message");
  });

});
