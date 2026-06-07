import { describe, expect, it } from "vitest";

import { evaluateSupervisorHandover } from "../../src/supervisor/handover_policy.js";

describe("Supervisor handover policy", () => {
  it("marks soft threshold as idle_pending until the supervisor is idle", () => {
    const decision = evaluateSupervisorHandover(
      {
        handoverState: "idle",
        cumulativeTokens: 1_000_000,
        updatedAt: new Date("2026-06-07T00:00:00.000Z"),
      },
      { idle: false, atTurnBoundary: false },
      {
        now: new Date("2026-06-07T00:20:00.000Z"),
      },
    );

    expect(decision).toEqual({
      state: "idle_pending",
      changed: true,
      reason: "soft_waiting_for_idle",
    });
  });

  it("starts soft handover only after idle", () => {
    const decision = evaluateSupervisorHandover(
      {
        handoverState: "idle_pending",
        cumulativeTokens: 1_100_000,
        updatedAt: new Date("2026-06-07T00:00:00.000Z"),
      },
      { idle: true, atTurnBoundary: false },
      {
        now: new Date("2026-06-07T00:20:00.000Z"),
      },
    );

    expect(decision.state).toBe("handover_running");
    expect(decision.reason).toBe("soft_idle_ready");
  });

  it("marks hard threshold pending until a turn boundary", () => {
    const decision = evaluateSupervisorHandover(
      {
        handoverState: "idle",
        cumulativeTokens: 1_500_000,
        updatedAt: new Date("2026-06-07T00:00:00.000Z"),
      },
      { idle: false, atTurnBoundary: false },
      {
        now: new Date("2026-06-07T00:20:00.000Z"),
      },
    );

    expect(decision).toEqual({
      state: "hard_pending",
      changed: true,
      reason: "hard_waiting_for_turn_boundary",
    });
  });

  it("starts hard handover at the next turn boundary even when not idle", () => {
    const decision = evaluateSupervisorHandover(
      {
        handoverState: "hard_pending",
        cumulativeTokens: 1_600_000,
        updatedAt: new Date("2026-06-07T00:00:00.000Z"),
      },
      { idle: false, atTurnBoundary: true },
      {
        now: new Date("2026-06-07T00:20:00.000Z"),
      },
    );

    expect(decision.state).toBe("handover_running");
    expect(decision.reason).toBe("hard_turn_boundary_ready");
  });

  it("keeps current state during the minimum interval guard", () => {
    const decision = evaluateSupervisorHandover(
      {
        handoverState: "idle",
        cumulativeTokens: 2_000_000,
        updatedAt: new Date("2026-06-07T00:19:00.000Z"),
      },
      { idle: true, atTurnBoundary: true },
      {
        now: new Date("2026-06-07T00:20:00.000Z"),
      },
    );

    expect(decision).toEqual({
      state: "idle",
      changed: false,
      reason: "min_interval_guard",
    });
  });
});
