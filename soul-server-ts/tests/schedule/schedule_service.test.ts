import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { SoulstreamScheduleService } from "../../src/schedule/schedule_service.js";
import type { ScheduleCreateInput, SoulstreamSchedule } from "../../src/schedule/schedule_models.js";

const logger = pino({ level: "silent" });

describe("SoulstreamScheduleService", () => {
  it("stores ScheduleWakeup as a durable one-shot schedule and emits the schedule wire event", async () => {
    const db = makeDb();
    const { service, broadcaster, persistence } = makeService(db);
    const now = new Date("2026-01-01T00:00:00Z");

    const schedule = await service.createScheduleFromTool({
      agentSessionId: "sess-1",
      toolUseId: "toolu-schedule",
      toolName: "ScheduleWakeup",
      input: { delaySeconds: 90, prompt: "wake me" },
      now,
    });

    const input = db.createSchedule.mock.calls[0][0] as ScheduleCreateInput;
    expect(input).toMatchObject({
      sessionId: "sess-1",
      kind: "wakeup",
      prompt: "wake me",
      sourceTool: "ScheduleWakeup",
      toolUseId: "toolu-schedule",
      recurring: false,
      timezone: "UTC",
    });
    expect(input.nextRunAt.toISOString()).toBe("2026-01-01T00:01:30.000Z");
    expect(input.runOnceAt?.toISOString()).toBe("2026-01-01T00:01:30.000Z");
    expect(schedule.nextRunAt).toBe("2026-01-01T00:01:30.000Z");
    expect(persistence.persistEvent).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "claude_runtime_schedule_updated",
        schedule_id: schedule.scheduleId,
      }),
    );
    expect(broadcaster.emitEventEnvelope).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "claude_runtime_schedule_updated",
        _event_id: 42,
      }),
    );
  });

  it("accepts absolute wakeup timestamps and numeric string delays without using Claude's native scheduler", async () => {
    const db = makeDb();
    const { service } = makeService(db);

    await service.createScheduleFromTool({
      agentSessionId: "sess-1",
      toolUseId: "toolu-schedule",
      toolName: "ScheduleWakeup",
      input: { wake_at: "2026-01-01T00:05:00Z" },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect((db.createSchedule.mock.calls[0][0] as ScheduleCreateInput).nextRunAt.toISOString())
      .toBe("2026-01-01T00:05:00.000Z");

    await service.createScheduleFromTool({
      agentSessionId: "sess-1",
      toolUseId: "toolu-schedule-2",
      toolName: "ScheduleWakeup",
      input: { delay_seconds: "120" },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect((db.createSchedule.mock.calls[1][0] as ScheduleCreateInput).nextRunAt.toISOString())
      .toBe("2026-01-01T00:02:00.000Z");
  });

  it("stores CronCreate in the same durable model and advances recurring schedules from now", async () => {
    const db = makeDb();
    const { service } = makeService(db);
    const now = new Date("2026-01-01T00:10:00Z");

    await service.createScheduleFromTool({
      agentSessionId: "sess-1",
      toolUseId: "toolu-cron",
      toolName: "CronCreate",
      input: { cron_expression: "*/15 * * * *", prompt: "check", timezone: "UTC" },
      now,
    });

    const createInput = db.createSchedule.mock.calls[0][0] as ScheduleCreateInput;
    expect(createInput.kind).toBe("cron");
    expect(createInput.recurring).toBe(true);
    expect(createInput.nextRunAt.toISOString()).toBe("2026-01-01T00:15:00.000Z");

    await service.finishDispatch(
      makeSchedule({
        kind: "cron",
        recurring: true,
        cronExpression: "*/15 * * * *",
        nextRunAt: "2026-01-01T00:00:00.000Z",
      }),
      "claim-1",
      now,
    );

    const finishInput = db.finishScheduleDispatch.mock.calls[0][0];
    expect(finishInput).toMatchObject({
      scheduleId: "sched-1",
      claimToken: "claim-1",
      recurring: true,
    });
    expect(finishInput.nextRunAt?.toISOString()).toBe("2026-01-01T00:15:00.000Z");
  });

  it("uses CronCreate timezone when computing the next durable UTC instant", async () => {
    const db = makeDb();
    const { service } = makeService(db);

    await service.createScheduleFromTool({
      agentSessionId: "sess-1",
      toolUseId: "toolu-cron",
      toolName: "CronCreate",
      input: { expression: "0 9 * * *", timezone: "Asia/Seoul" },
      now: new Date("2026-01-01T23:00:00Z"),
    });

    const createInput = db.createSchedule.mock.calls[0][0] as ScheduleCreateInput;
    expect(createInput.timezone).toBe("Asia/Seoul");
    expect(createInput.nextRunAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("list/delete commands read and mutate the Soulstream store directly", async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.listSchedules.mockResolvedValueOnce([
      makeSchedule({ scheduleId: "sched-a", nextRunAt: "2026-01-01T01:00:00.000Z" }),
      makeSchedule({ scheduleId: "sched-b", nextRunAt: "2026-01-01T00:30:00.000Z" }),
    ]);
    db.cancelSchedule.mockResolvedValueOnce({
      outcome: "cancelled",
      schedule: makeSchedule({ scheduleId: "sched-b", status: "cancelled" }),
    });

    await expect(service.listSchedules("sess-1")).resolves.toMatchObject({
      sessionId: "sess-1",
      nextRunAt: "2026-01-01T00:30:00.000Z",
      schedules: [{ scheduleId: "sched-a" }, { scheduleId: "sched-b" }],
    });
    await expect(service.deleteSchedule("sess-1", "sched-b")).resolves.toMatchObject({
      deleted: true,
      scheduleId: "sched-b",
      status: "cancelled",
    });

    expect(db.cancelSchedule).toHaveBeenCalledWith("sess-1", "sched-b");
  });

  it("CronList tool result message exposes schedule ids and next run details to the model", async () => {
    const db = makeDb();
    const { service } = makeService(db);
    db.listSchedules.mockResolvedValueOnce([
      makeSchedule({
        scheduleId: "sched-visible",
        kind: "cron",
        status: "active",
        prompt: "summarize open loops",
        nextRunAt: "2026-01-01T01:00:00.000Z",
      }),
    ]);

    const result = await service.makeToolHandler()({
      agentSessionId: "sess-1",
      toolUseId: "toolu-list",
      toolName: "CronList",
      input: {},
      now: new Date("2026-01-01T00:00:00Z"),
    });

    expect(result.message).toContain("id=sched-visible");
    expect(result.message).toContain("status=active");
    expect(result.message).toContain("nextRunAt=2026-01-01T01:00:00.000Z");
    expect(result.message).toContain('prompt="summarize open loops"');
  });

  it("deleteSchedule reports firing conflict without emitting a deleted event", async () => {
    const db = makeDb();
    const { service, broadcaster } = makeService(db);
    db.cancelSchedule.mockResolvedValueOnce({
      outcome: "already_firing",
      schedule: makeSchedule({ scheduleId: "sched-firing", status: "firing" }),
    });

    await expect(service.deleteSchedule("sess-1", "sched-firing")).resolves.toMatchObject({
      deleted: false,
      status: "already_firing",
      scheduleId: "sched-firing",
      schedule: { status: "firing" },
    });
    expect(broadcaster.emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("marks due schedules without an owner node as orphaned and broadcasts the state", async () => {
    const db = makeDb();
    const { service, broadcaster } = makeService(db);
    db.markOrphanDueSchedules.mockResolvedValueOnce([
      makeSchedule({ scheduleId: "orphan-1", status: "orphaned" }),
    ]);

    await expect(
      service.markOrphanDueSchedules(
        new Date("2026-01-01T00:00:00Z"),
        new Date("2025-12-31T23:55:00Z"),
        10,
      ),
    ).resolves.toEqual([expect.objectContaining({ scheduleId: "orphan-1" })]);

    expect(db.markOrphanDueSchedules).toHaveBeenCalledWith({
      now: new Date("2026-01-01T00:00:00Z"),
      staleBefore: new Date("2025-12-31T23:55:00Z"),
      limit: 10,
      error: "scheduled session owner node is not connected",
    });
    expect(broadcaster.emitEventEnvelope).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "claude_runtime_schedule_updated",
        status: "orphaned",
      }),
    );
  });

  it("restores orphaned schedules for live owner nodes and broadcasts the state", async () => {
    const db = makeDb();
    const { service, broadcaster } = makeService(db);
    db.restoreOrphanSchedulesForLiveNodes.mockResolvedValueOnce([
      makeSchedule({ scheduleId: "orphan-1", status: "active", lastError: null }),
    ]);

    await expect(
      service.restoreOrphanSchedulesForLiveNodes(
        new Date("2025-12-31T23:55:00Z"),
        10,
      ),
    ).resolves.toEqual([expect.objectContaining({ scheduleId: "orphan-1" })]);

    expect(db.restoreOrphanSchedulesForLiveNodes).toHaveBeenCalledWith({
      staleBefore: new Date("2025-12-31T23:55:00Z"),
      limit: 10,
    });
    expect(broadcaster.emitEventEnvelope).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        type: "claude_runtime_schedule_updated",
        status: "active",
      }),
    );
  });
});

function makeService(db = makeDb()) {
  const broadcaster = { emitEventEnvelope: vi.fn(async () => undefined) };
  const persistence = { persistEvent: vi.fn(async () => 42) };
  const service = new SoulstreamScheduleService(
    db as never,
    broadcaster as never,
    persistence as never,
    logger,
  );
  return { service, broadcaster, persistence };
}

function makeDb() {
  return {
    createSchedule: vi.fn(async (input: ScheduleCreateInput) =>
      makeSchedule({
        scheduleId: input.scheduleId,
        sessionId: input.sessionId,
        kind: input.kind,
        prompt: input.prompt,
        sourceTool: input.sourceTool,
        toolUseId: input.toolUseId ?? null,
        cronExpression: input.cronExpression ?? null,
        runOnceAt: input.runOnceAt?.toISOString() ?? null,
        timezone: input.timezone ?? "UTC",
        recurring: input.recurring,
        nextRunAt: input.nextRunAt.toISOString(),
        createdAt: input.createdAt?.toISOString() ?? "2026-01-01T00:00:00.000Z",
        updatedAt: input.createdAt?.toISOString() ?? "2026-01-01T00:00:00.000Z",
      })),
    listSchedules: vi.fn(async () => []),
    cancelSchedule: vi.fn(async () => ({ outcome: "not_found", schedule: null })),
    touchNodeHeartbeat: vi.fn(async () => undefined),
    claimDueSchedules: vi.fn(async () => []),
    repairExpiredClaims: vi.fn(async () => []),
    markOrphanDueSchedules: vi.fn(async () => []),
    restoreOrphanSchedulesForLiveNodes: vi.fn(async () => []),
    consumeClaimedSchedule: vi.fn(async () => null),
    confirmScheduleStillFiring: vi.fn(async () => null),
    deferScheduleDispatch: vi.fn(async () => makeSchedule({ status: "active" })),
    finishScheduleDispatch: vi.fn(async (input) =>
      makeSchedule({
        status: input.recurring ? "active" : "completed",
        nextRunAt: input.nextRunAt?.toISOString() ?? null,
        lastFiredAt: input.firedAt.toISOString(),
        firedCount: 1,
      }),
    ),
    failScheduleDispatch: vi.fn(async (_scheduleId, _claimToken, error: string) =>
      makeSchedule({ status: "failed", lastError: error }),
    ),
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
    nextRunAt: "2026-01-01T00:01:00.000Z",
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
