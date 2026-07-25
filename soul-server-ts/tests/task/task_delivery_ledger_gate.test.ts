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
    const claim = vi.fn(async (deliveryId: string) => row(deliveryId, "claimed"));
    const gate = new TaskDeliveryLedgerGate(true, {
      register,
      claim,
      markQueued: vi.fn(),
      markDelivered: vi.fn(),
      markUncertain: vi.fn(),
      markConsumed: vi.fn(),
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
});
