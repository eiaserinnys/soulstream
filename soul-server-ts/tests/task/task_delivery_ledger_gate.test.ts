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
      claimForCurrentSupervisor: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
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
      claimForCurrentSupervisor: vi.fn(),
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation,
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

  it("suppresses an admitted completion when consumed wins the dispatch CAS", async () => {
    const deliveryId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn(),
      claimForTarget: vi.fn(),
      claimForCurrentSupervisor: vi.fn(),
      beginDispatch: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(row(deliveryId, "consumed")),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
    });

    await expect(gate.beginDispatch({
      kind: "admitted",
      deliveryId,
      row: row(deliveryId, "claimed"),
    })).resolves.toEqual({
      kind: "suppressed",
      deliveryId,
      reason: "delivery_consumed_before_dispatch",
    });
  });

  it("admits a supervisor delivery only when the atomic claim resolves the requested target", async () => {
    const deliveryId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const pending = row(deliveryId, "pending");
    const claimForCurrentSupervisor = vi.fn().mockResolvedValue({
      ...pending,
      state: "claimed",
      target_session_id: "supervisor-current",
    });
    const gate = new TaskDeliveryLedgerGate(true, {
      register: vi.fn().mockResolvedValue({
        row: pending,
        inserted: true,
        conflict: false,
      }),
      claimForTarget: vi.fn(),
      claimForCurrentSupervisor,
      beginDispatch: vi.fn(),
      get: vi.fn(),
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
      markConsumedByRelation: vi.fn(),
    });

    await expect(gate.admit({
      agentSessionId: "supervisor-current",
      text: "done",
      user: "agent",
      deliveryId,
      deliveryIntent: "completion_notification",
      completionId: "completion-1",
      relationKey: "child:1",
      supervisorRole: "ariella",
    })).resolves.toMatchObject({ kind: "admitted" });
    expect(claimForCurrentSupervisor).toHaveBeenCalledWith(
      deliveryId,
      "ariella",
      expect.stringMatching(/^route:/),
    );
  });
});
