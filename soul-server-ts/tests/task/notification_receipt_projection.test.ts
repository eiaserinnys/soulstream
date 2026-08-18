import { describe, expect, it, vi } from "vitest";

import type { SessionDeliveryNotificationOutboxRow } from
  "../../src/db/session_db_types.js";
import { projectNotificationReceipt } from
  "../../src/task/notification_receipt_projection.js";

function publishedRow(receiptId: string): SessionDeliveryNotificationOutboxRow {
  return {
    delivery_id: "delivery-1",
    state: "published",
    projection_state: "published",
    target_receipt_id: receiptId,
  } as SessionDeliveryNotificationOutboxRow;
}

describe("projectNotificationReceipt", () => {
  it("treats a lost CAS with the same receipt as idempotent success", async () => {
    const repository = {
      markPublished: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(publishedRow("event:42")),
    };

    await expect(projectNotificationReceipt(
      repository,
      "delivery-1",
      "worker-1",
      "event:42",
    )).resolves.toBe("idempotent");
  });

  it("reports a lost CAS with a different receipt as a conflict", async () => {
    const repository = {
      markPublished: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(publishedRow("event:old")),
    };

    await expect(projectNotificationReceipt(
      repository,
      "delivery-1",
      "worker-1",
      "event:new",
    )).rejects.toThrow(
      "notification receipt conflict for delivery-1: event:old",
    );
  });
});
