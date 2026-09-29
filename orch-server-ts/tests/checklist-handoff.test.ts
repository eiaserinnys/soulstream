import { describe, expect, it, vi } from "vitest";
import { notifyChecklistHandoff } from "../src/folders/checklist_handoff.js";
import type { SessionDeliveryRepository } from "../src/control_plane/repositories/session_delivery_repository.js";

describe("checklist human handoff", () => {
  const event = { folderId: "folder", folderName: "설계", itemId: "item", itemTitle: "검토",
    status: "completed" as const, operationId: "operation", eventId: 42 };

  it("registers durable delivery before dispatch and isolates an unavailable recipient", async () => {
    const order: string[] = [];
    const register = vi.fn(async (_input: unknown) => { order.push("persist"); return { conflict: false }; });
    const send = vi.fn(async (payload) => {
      order.push("send");
      if (payload.agentSessionId === "offline") throw new Error("offline");
      return { type: "ack", status: "ok" };
    });
    const warn = vi.fn();
    await notifyChecklistHandoff(event, ["offline", "active"], {
      deliveries: { register } as unknown as Pick<SessionDeliveryRepository, "register">, send, warn,
    });
    expect(order).toEqual(["persist", "send", "persist", "send"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "intervene", agentSessionId: "active", delivery_intent: "durable_next_turn",
      source: "checklist_handoff", producer_terminal_revision: "42",
      text: expect.stringContaining("folder_id: folder"),
    }));
    expect(register.mock.calls[0]?.[0]).toMatchObject({ targetSessionId: "offline", intent: "durable_next_turn" });
  });
});
