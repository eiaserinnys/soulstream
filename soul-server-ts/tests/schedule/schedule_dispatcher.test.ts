import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { ScheduleDispatcher } from "../../src/schedule/schedule_dispatcher.js";
import type { SoulstreamSchedule } from "../../src/schedule/schedule_models.js";

const logger = pino({ level: "silent" });

describe("ScheduleDispatcher", () => {
  it("claims due schedules on the owner node and injects a scheduled prompt", async () => {
    const schedule = makeSchedule({ kind: "wakeup" });
    const service = makeService({
      claimDueSchedules: [{ schedule, claimToken: "claim-1" }],
      consumeClaimedSchedule: schedule,
      confirmScheduleStillFiring: schedule,
    });
    const taskManager = { addIntervention: vi.fn(async () => ({ autoResumed: true })) };
    const onResume = vi.fn();
    const dispatcher = new ScheduleDispatcher(
      {
        nodeId: "owner-node",
        batchSize: 5,
        startedAt: new Date("2025-12-31T23:00:00Z"),
      },
      service as never,
      taskManager as never,
      onResume,
      logger,
    );

    await dispatcher.runOnce(new Date("2026-01-01T00:00:00Z"));

    expect(service.touchNodeHeartbeat).toHaveBeenCalledWith(
      "owner-node",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(service.repairExpiredClaims).toHaveBeenCalledWith(
      new Date("2026-01-01T00:00:00Z"),
      5,
    );
    expect(service.restoreOrphanSchedulesForLiveNodes).toHaveBeenCalledWith(
      new Date("2025-12-31T23:55:00Z"),
      5,
    );
    expect(service.markOrphanDueSchedules).toHaveBeenCalledWith(
      new Date("2026-01-01T00:00:00Z"),
      new Date("2025-12-31T23:55:00Z"),
      5,
    );
    expect(service.claimDueSchedules).toHaveBeenCalledWith(
      "owner-node",
      new Date("2026-01-01T00:00:00Z"),
      5,
      60_000,
    );
    expect(taskManager.addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-1",
        text: "[Scheduled wakeup]\n\nwake me",
        callerInfo: expect.objectContaining({ source: "system" }),
        queueIfRunning: false,
      }),
      onResume,
    );
    expect(service.finishDispatch).toHaveBeenCalledWith(
      schedule,
      "claim-1",
      new Date("2026-01-01T00:00:00Z"),
    );
  });

  it("rechecks the store after claim so delete/cancel wins the race before speech", async () => {
    const schedule = makeSchedule();
    const service = makeService({
      claimDueSchedules: [{ schedule, claimToken: "claim-1" }],
      consumeClaimedSchedule: null,
    });
    const taskManager = { addIntervention: vi.fn(async () => ({ autoResumed: true })) };
    const dispatcher = new ScheduleDispatcher(
      { nodeId: "owner-node" },
      service as never,
      taskManager as never,
      vi.fn(),
      logger,
    );

    await dispatcher.runOnce(new Date("2026-01-01T00:00:00Z"));

    expect(service.consumeClaimedSchedule).toHaveBeenCalledWith("sched-1", "claim-1");
    expect(taskManager.addIntervention).not.toHaveBeenCalled();
    expect(service.finishDispatch).not.toHaveBeenCalled();
    expect(service.failDispatch).not.toHaveBeenCalled();
  });

  it("rechecks firing state after consume so cancellation before speech wins", async () => {
    const schedule = makeSchedule({ status: "firing" });
    const service = makeService({
      claimDueSchedules: [{ schedule, claimToken: "claim-1" }],
      consumeClaimedSchedule: schedule,
      confirmScheduleStillFiring: null,
    });
    const taskManager = { addIntervention: vi.fn(async () => ({ autoResumed: true })) };
    const dispatcher = new ScheduleDispatcher(
      { nodeId: "owner-node" },
      service as never,
      taskManager as never,
      vi.fn(),
      logger,
    );

    await dispatcher.runOnce(new Date("2026-01-01T00:00:00Z"));

    expect(service.confirmScheduleStillFiring).toHaveBeenCalledWith("sched-1", "claim-1");
    expect(taskManager.addIntervention).not.toHaveBeenCalled();
    expect(service.finishDispatch).not.toHaveBeenCalled();
  });

  it("defers instead of using the in-memory intervention queue for running sessions", async () => {
    const schedule = makeSchedule({ status: "firing" });
    const service = makeService({
      claimDueSchedules: [{ schedule, claimToken: "claim-1" }],
      consumeClaimedSchedule: schedule,
      confirmScheduleStillFiring: schedule,
    });
    const taskManager = { addIntervention: vi.fn(async () => ({ deferred: true })) };
    const dispatcher = new ScheduleDispatcher(
      { nodeId: "owner-node", retryDelayMs: 5_000 },
      service as never,
      taskManager as never,
      vi.fn(),
      logger,
    );

    await dispatcher.runOnce(new Date("2026-01-01T00:00:00Z"));

    expect(service.deferDispatch).toHaveBeenCalledWith(
      schedule,
      "claim-1",
      new Date("2026-01-01T00:00:05Z"),
      "session is running and cannot accept durable scheduled intervention yet",
    );
    expect(service.finishDispatch).not.toHaveBeenCalled();
  });

  it("records a dispatch failure instead of leaving a schedule stuck in firing", async () => {
    const schedule = makeSchedule({ kind: "cron", cronExpression: "*/15 * * * *" });
    const service = makeService({
      claimDueSchedules: [{ schedule, claimToken: "claim-1" }],
      consumeClaimedSchedule: schedule,
      confirmScheduleStillFiring: schedule,
    });
    const taskManager = { addIntervention: vi.fn(async () => { throw new Error("session busy"); }) };
    const dispatcher = new ScheduleDispatcher(
      { nodeId: "owner-node" },
      service as never,
      taskManager as never,
      vi.fn(),
      logger,
    );

    await dispatcher.runOnce(new Date("2026-01-01T00:00:00Z"));

    expect(service.failDispatch).toHaveBeenCalledWith(schedule, "claim-1", "session busy");
    expect(service.finishDispatch).not.toHaveBeenCalled();
  });

  it("skips orphan marking during dispatcher startup grace but still restores live orphans", async () => {
    const service = makeService();
    const dispatcher = new ScheduleDispatcher(
      {
        nodeId: "owner-node",
        startedAt: new Date("2026-01-01T00:00:00Z"),
        orphanStartupGraceMs: 120_000,
      },
      service as never,
      { addIntervention: vi.fn() } as never,
      vi.fn(),
      logger,
    );

    await dispatcher.runOnce(new Date("2026-01-01T00:01:00Z"));

    expect(service.restoreOrphanSchedulesForLiveNodes).toHaveBeenCalledWith(
      new Date("2025-12-31T23:56:00Z"),
      25,
    );
    expect(service.markOrphanDueSchedules).not.toHaveBeenCalled();
  });
});

function makeService(overrides: {
  claimDueSchedules?: Array<{ schedule: SoulstreamSchedule; claimToken: string }>;
  consumeClaimedSchedule?: SoulstreamSchedule | null;
  confirmScheduleStillFiring?: SoulstreamSchedule | null;
} = {}) {
  return {
    touchNodeHeartbeat: vi.fn(async () => undefined),
    repairExpiredClaims: vi.fn(async () => []),
    markOrphanDueSchedules: vi.fn(async () => []),
    restoreOrphanSchedulesForLiveNodes: vi.fn(async () => []),
    claimDueSchedules: vi.fn(async () => overrides.claimDueSchedules ?? []),
    consumeClaimedSchedule: vi.fn(async () => overrides.consumeClaimedSchedule ?? null),
    confirmScheduleStillFiring: vi.fn(async () => overrides.confirmScheduleStillFiring ?? null),
    deferDispatch: vi.fn(async () => makeSchedule({ status: "active" })),
    finishDispatch: vi.fn(async () => makeSchedule({ status: "completed" })),
    failDispatch: vi.fn(async () => makeSchedule({ status: "failed" })),
  };
}

function makeSchedule(overrides: Partial<SoulstreamSchedule> = {}): SoulstreamSchedule {
  return {
    scheduleId: "sched-1",
    sessionId: "sess-1",
    kind: "wakeup",
    status: "active",
    prompt: "wake me",
    sourceTool: "ScheduleWakeup",
    toolUseId: "toolu-schedule",
    cronExpression: null,
    runOnceAt: null,
    timezone: "UTC",
    recurring: false,
    nextRunAt: "2026-01-01T00:00:00.000Z",
    lastFiredAt: null,
    firedCount: 0,
    lastError: null,
    claimToken: null,
    claimedUntil: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
