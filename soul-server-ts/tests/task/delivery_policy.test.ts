import { describe, expect, it } from "vitest";

import { decideNotificationDelivery } from "../../src/task/delivery_policy.js";

describe("decideNotificationDelivery", () => {
  it("terminal+pending은 interrupt 없이 다음 턴 resume을 선택한다", () => {
    expect(decideNotificationDelivery("pending", "terminal")).toEqual({
      action: "resume_next_turn",
      interrupt: false,
      reason: "terminal_unconsumed",
    });
  });

  it("generating+pending은 interrupt 없이 queue-only를 선택한다", () => {
    expect(decideNotificationDelivery("pending", "generating")).toEqual({
      action: "queue_only",
      interrupt: false,
      reason: "generating_never_interrupt",
    });
  });

  it.each(["claimed", "queued", "delivered", "consumed", "uncertain"] as const)(
    "이미 처리 중이거나 settled인 %s delivery를 suppress한다",
    (state) => {
      const decision = decideNotificationDelivery(state, "terminal");
      expect(decision.action).toBe("suppress");
      expect(decision.interrupt).toBe(false);
    },
  );
});
