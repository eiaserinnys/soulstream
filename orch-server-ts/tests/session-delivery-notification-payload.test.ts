import { describe, expect, it } from "vitest";

import { validateNotificationPayload } from
  "../src/control_plane/repositories/session_delivery_notification_payload.js";

function payload(extra: Record<string, unknown> = {}) {
  return {
    text: "completion notice",
    user: "agent",
    caller_info: null,
    source: "completion_notifier",
    delivery_id: "delivery-1",
    delivery_intent: "completion_notification",
    completion_id: "completion-1",
    relation_key: "child_session:child-1:42",
    disposition: "queued",
    ...extra,
  };
}

describe("session delivery notification payload", () => {
  it("keeps rate-limit metadata optional for existing notifications", () => {
    const value = payload();

    expect(validateNotificationPayload({
      deliveryId: "delivery-1",
      disposition: "queued",
      payload: value,
    })).toEqual(value);
  });

  it("preserves rate-limit reset metadata when provided", () => {
    const value = payload({
      rate_limit_type: "five_hour",
      resets_at: "2026-09-26T03:12:00.000Z",
    });

    expect(validateNotificationPayload({
      deliveryId: "delivery-1",
      disposition: "queued",
      payload: value,
    })).toEqual(value);
  });
});
