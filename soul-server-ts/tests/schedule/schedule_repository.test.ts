import { describe, expect, it, vi } from "vitest";

import { SoulstreamScheduleRepository } from "../../src/schedule/schedule_repository.js";
import type { SqlClient } from "../../src/db/session_db.js";

interface MockCall {
  fragments: string[];
  values: unknown[];
}

function createMockSql(resultFor?: (call: MockCall) => unknown[]) {
  const calls: MockCall[] = [];

  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call: MockCall = { fragments: Array.from(strings), values };
    calls.push(call);
    return Promise.resolve(resultFor ? resultFor(call) : []);
  }) as unknown as SqlClient & {
    array: (a: unknown[]) => unknown[];
    end: () => Promise<void>;
  };

  fn.array = (a: unknown[]) => a;
  fn.end = vi.fn().mockResolvedValue(undefined);

  return { sql: fn as unknown as SqlClient, calls };
}

describe("SoulstreamScheduleRepository", () => {
  it("createSchedule inserts one canonical row and maps returned timestamps to ISO strings", async () => {
    const { sql, calls } = createMockSql((call) => [
      scheduleRow({
        schedule_id: call.values[0] as string,
        session_id: call.values[1] as string,
        kind: call.values[2] as "wakeup",
        prompt: call.values[3] as string,
        source_tool: call.values[4] as string,
        next_run_at: call.values[10] as Date,
        created_at: call.values[11] as Date,
        updated_at: call.values[12] as Date,
      }),
    ]);
    const repo = new SoulstreamScheduleRepository(sql);
    const nextRunAt = new Date("2026-01-01T00:10:00Z");
    const createdAt = new Date("2026-01-01T00:00:00Z");

    const schedule = await repo.createSchedule({
      scheduleId: "sched-1",
      sessionId: "sess-1",
      kind: "wakeup",
      prompt: "wake me",
      sourceTool: "ScheduleWakeup",
      toolUseId: "toolu-1",
      recurring: false,
      nextRunAt,
      runOnceAt: nextRunAt,
      createdAt,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].fragments.join("?")).toContain("INSERT INTO soulstream_schedules");
    expect(calls[0].values).toEqual([
      "sched-1",
      "sess-1",
      "wakeup",
      "wake me",
      "ScheduleWakeup",
      "toolu-1",
      null,
      nextRunAt,
      "UTC",
      false,
      nextRunAt,
      createdAt,
      createdAt,
    ]);
    expect(schedule).toMatchObject({
      scheduleId: "sched-1",
      sessionId: "sess-1",
      kind: "wakeup",
      nextRunAt: "2026-01-01T00:10:00.000Z",
    });
  });

  it("claimDueSchedules only claims due schedules whose session is owned by this node", async () => {
    const { sql, calls } = createMockSql(() => [
      scheduleRow({
        schedule_id: "sched-1",
        claim_token: "claim-1",
      }),
    ]);
    const repo = new SoulstreamScheduleRepository(sql);

    const claimed = await repo.claimDueSchedules({
      nodeId: "owner-node",
      now: new Date("2026-01-01T00:00:00Z"),
      claimToken: "claim-1",
      claimedUntil: new Date("2026-01-01T00:01:00Z"),
      limit: 10,
    });

    const query = calls[0].fragments.join("?");
    expect(query).toContain("JOIN sessions session");
    expect(query).toContain("session.node_id =");
    expect(query).toContain("FOR UPDATE OF schedule SKIP LOCKED");
    expect(calls[0].values).toEqual([
      new Date("2026-01-01T00:00:00Z"),
      "owner-node",
      10,
      "claim-1",
      new Date("2026-01-01T00:01:00Z"),
    ]);
    expect(claimed).toEqual([
      {
        schedule: expect.objectContaining({ scheduleId: "sched-1" }),
        claimToken: "claim-1",
      },
    ]);
  });

  it("cancelSchedule cancels only pre-firing rows so successful delete cannot race with speech", async () => {
    const { sql, calls } = createMockSql(() => [
      { outcome: "cancelled", ...scheduleRow({ schedule_id: "sched-1", status: "cancelled" }) },
    ]);
    const result = await new SoulstreamScheduleRepository(sql).cancelSchedule("sess-1", "sched-1");

    const query = calls[0].fragments.join("?");
    expect(query).toContain("FOR UPDATE");
    expect(query).toContain("target.status IN ('active', 'dispatching', 'failed', 'orphaned')");
    expect(query).toContain("WHEN target.status = 'firing' THEN 'already_firing'");
    expect(query).toContain("claim_token = NULL");
    expect(calls[0].values).toEqual(["sess-1", "sched-1"]);
    expect(result).toMatchObject({
      outcome: "cancelled",
      schedule: { scheduleId: "sched-1", status: "cancelled" },
    });
  });

  it("restoreOrphanSchedulesForLiveNodes returns orphaned rows to active when owner heartbeat is fresh", async () => {
    const { sql, calls } = createMockSql(() => [
      scheduleRow({ schedule_id: "orphan-1", status: "active", last_error: null }),
    ]);

    const schedules = await new SoulstreamScheduleRepository(sql).restoreOrphanSchedulesForLiveNodes({
      staleBefore: new Date("2026-01-01T00:05:00Z"),
      limit: 25,
    });

    const query = calls[0].fragments.join("?");
    expect(query).toContain("schedule.status = 'orphaned'");
    expect(query).toContain("heartbeat.last_seen_at >=");
    expect(query).toContain("SET status = 'active'");
    expect(query).toContain("FOR UPDATE OF schedule SKIP LOCKED");
    expect(schedules).toEqual([
      expect.objectContaining({
        scheduleId: "orphan-1",
        status: "active",
        lastError: null,
      }),
    ]);
  });

  it("markOrphanDueSchedules marks due schedules with no session owner as visible orphaned state", async () => {
    const { sql, calls } = createMockSql(() => [
      scheduleRow({ schedule_id: "orphan-1", status: "orphaned", last_error: "no owner" }),
    ]);
    const now = new Date("2026-01-01T00:00:00Z");

    const schedules = await new SoulstreamScheduleRepository(sql).markOrphanDueSchedules({
      now,
      staleBefore: new Date("2025-12-31T23:55:00Z"),
      limit: 25,
      error: "no owner",
    });

    const query = calls[0].fragments.join("?");
    expect(query).toContain("LEFT JOIN sessions session");
    expect(query).toContain("LEFT JOIN soulstream_node_heartbeats heartbeat");
    expect(query).toContain("heartbeat.last_seen_at <");
    expect(query).toContain("FOR UPDATE OF schedule SKIP LOCKED");
    expect(query).toContain("status = 'orphaned'");
    expect(calls[0].values).toEqual([
      now,
      new Date("2025-12-31T23:55:00Z"),
      25,
      "no owner",
    ]);
    expect(schedules).toEqual([
      expect.objectContaining({
        scheduleId: "orphan-1",
        status: "orphaned",
        lastError: "no owner",
      }),
    ]);
  });
});

function scheduleRow(overrides: Record<string, unknown> = {}) {
  return {
    schedule_id: "sched-1",
    session_id: "sess-1",
    kind: "wakeup",
    status: "active",
    prompt: "wake me",
    source_tool: "ScheduleWakeup",
    tool_use_id: "toolu-1",
    cron_expression: null,
    run_once_at: null,
    timezone: "UTC",
    recurring: false,
    next_run_at: new Date("2026-01-01T00:10:00Z"),
    last_fired_at: null,
    fired_count: 0,
    last_error: null,
    claim_token: null,
    claimed_until: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}
