import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SqlClient } from "../../src/db/session_db.js";
import { ScheduleDispatcher } from "../../src/schedule/schedule_dispatcher.js";
import type { ScheduleCreateInput } from "../../src/schedule/schedule_models.js";
import { SoulstreamScheduleRepository } from "../../src/schedule/schedule_repository.js";
import { SoulstreamScheduleService } from "../../src/schedule/schedule_service.js";

import {
  createPostgresTestHarness,
  type PostgresTestHarness,
} from "./postgres_test_harness.js";

const logger = pino({ level: "silent" });

describe("Soulstream schedule repository PostgreSQL integration", () => {
  let harness: PostgresTestHarness | undefined;
  let sql: SqlClient;
  let repo: SoulstreamScheduleRepository;

  beforeAll(async () => {
    harness = await createPostgresTestHarness();
    sql = harness.sql;
    repo = new SoulstreamScheduleRepository(sql);
  }, 45_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  }, 15_000);

  beforeEach(async () => {
    await sql`TRUNCATE soulstream_schedules, sessions, soulstream_node_heartbeats`;
  });

  it("repairs expired dispatching and firing claims so crash-after-claim is reclaimable", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await insertSession(sql, "sess-claim", "node-a");
    await repo.touchNodeHeartbeat("node-a", now);
    await createSchedule(repo, {
      scheduleId: "sched-claim",
      sessionId: "sess-claim",
      nextRunAt: new Date("2025-12-31T23:59:00Z"),
    });

    const claimed = await repo.claimDueSchedules({
      nodeId: "node-a",
      now,
      claimToken: "claim-a",
      claimedUntil: new Date("2025-12-31T23:59:30Z"),
      limit: 10,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].schedule.status).toBe("dispatching");

    const repairedDispatching = await repo.repairExpiredClaims({
      now,
      limit: 10,
      error: "expired",
    });
    expect(repairedDispatching).toEqual([
      expect.objectContaining({
        scheduleId: "sched-claim",
        status: "active",
        claimToken: null,
      }),
    ]);

    const reclaimed = await repo.claimDueSchedules({
      nodeId: "node-a",
      now,
      claimToken: "claim-b",
      claimedUntil: new Date("2025-12-31T23:59:45Z"),
      limit: 10,
    });
    const firing = await repo.consumeClaimedSchedule("sched-claim", "claim-b");
    expect(reclaimed).toHaveLength(1);
    expect(firing?.status).toBe("firing");

    const repairedFiring = await repo.repairExpiredClaims({
      now,
      limit: 10,
      error: "expired again",
    });
    expect(repairedFiring).toEqual([
      expect.objectContaining({
        scheduleId: "sched-claim",
        status: "active",
        claimToken: null,
      }),
    ]);
  });

  it("returns already_firing instead of successful delete once injection may be in progress", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    await insertSession(sql, "sess-delete", "node-a");
    await repo.touchNodeHeartbeat("node-a", now);
    await createSchedule(repo, {
      scheduleId: "sched-delete",
      sessionId: "sess-delete",
      nextRunAt: now,
    });

    await repo.claimDueSchedules({
      nodeId: "node-a",
      now,
      claimToken: "claim-delete",
      claimedUntil: new Date("2026-01-01T00:01:00Z"),
      limit: 10,
    });
    const firing = await repo.consumeClaimedSchedule("sched-delete", "claim-delete");
    expect(firing?.status).toBe("firing");

    const cancelled = await repo.cancelSchedule("sess-delete", "sched-delete");
    expect(cancelled).toMatchObject({
      outcome: "already_firing",
      schedule: { scheduleId: "sched-delete", status: "firing" },
    });
    await expect(
      repo.confirmScheduleStillFiring("sched-delete", "claim-delete"),
    ).resolves.toEqual(expect.objectContaining({ status: "firing" }));
    await expect(
      repo.finishScheduleDispatch({
        scheduleId: "sched-delete",
        claimToken: "claim-delete",
        recurring: false,
        nextRunAt: null,
        firedAt: now,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });

  it("keeps deferred running-session schedules durable across dispatcher instances", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const retryAt = new Date("2026-01-01T00:00:05Z");
    const service = makeService(repo);
    await insertSession(sql, "sess-defer", "node-a");
    await repo.touchNodeHeartbeat("node-a", now);
    await createSchedule(repo, {
      scheduleId: "sched-defer",
      sessionId: "sess-defer",
      nextRunAt: now,
    });

    const firstTaskManager = {
      addIntervention: vi.fn(async () => ({ deferred: true })),
    };
    const firstDispatcher = new ScheduleDispatcher(
      { nodeId: "node-a", retryDelayMs: 5_000, claimTimeoutMs: 60_000 },
      service as never,
      firstTaskManager as never,
      vi.fn(),
      logger,
    );
    await firstDispatcher.runOnce(now);

    let row = await scheduleRow(sql, "sched-defer");
    expect(row).toMatchObject({
      status: "active",
      next_run_at: retryAt,
      fired_count: 0,
    });

    const secondTaskManager = {
      addIntervention: vi.fn(async () => ({ autoResumed: true })),
    };
    const secondDispatcher = new ScheduleDispatcher(
      { nodeId: "node-a", retryDelayMs: 5_000, claimTimeoutMs: 60_000 },
      service as never,
      secondTaskManager as never,
      vi.fn(),
      logger,
    );
    await secondDispatcher.runOnce(retryAt);

    row = await scheduleRow(sql, "sched-defer");
    expect(row).toMatchObject({
      status: "completed",
      fired_count: 1,
    });
    expect(secondTaskManager.addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-defer",
        queueIfRunning: false,
      }),
      expect.any(Function),
    );
  });

  it("marks due schedules orphaned only when owner heartbeat is known stale", async () => {
    const now = new Date("2026-01-01T00:10:00Z");
    const staleBefore = new Date("2026-01-01T00:05:00Z");
    await insertSession(sql, "sess-missing-heartbeat", "dead-node");
    await createSchedule(repo, {
      scheduleId: "sched-missing-heartbeat",
      sessionId: "sess-missing-heartbeat",
      nextRunAt: now,
    });
    await insertSession(sql, "sess-stale-heartbeat", "stale-node");
    await repo.touchNodeHeartbeat("stale-node", new Date("2026-01-01T00:00:00Z"));
    await createSchedule(repo, {
      scheduleId: "sched-stale-heartbeat",
      sessionId: "sess-stale-heartbeat",
      nextRunAt: now,
    });
    await insertSession(sql, "sess-live", "live-node");
    await repo.touchNodeHeartbeat("live-node", now);
    await createSchedule(repo, {
      scheduleId: "sched-live",
      sessionId: "sess-live",
      nextRunAt: now,
    });

    const orphaned = await repo.markOrphanDueSchedules({
      now,
      staleBefore,
      limit: 10,
      error: "owner offline",
    });

    expect(orphaned.map((schedule) => schedule.scheduleId).sort()).toEqual([
      "sched-stale-heartbeat",
    ]);
    expect(await scheduleRow(sql, "sched-missing-heartbeat")).toMatchObject({ status: "active" });
    expect(await scheduleRow(sql, "sched-live")).toMatchObject({ status: "active" });
  });

  it("does not false-orphan never-seen owner heartbeats and restores orphaned rows when owner heartbeat returns", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const service = makeService(repo);
    await insertSession(sql, "sess-grace", "node-a");
    await createSchedule(repo, {
      scheduleId: "sched-grace",
      sessionId: "sess-grace",
      nextRunAt: now,
    });

    const observerDispatcher = new ScheduleDispatcher(
      {
        nodeId: "node-b",
        startedAt: now,
        orphanStartupGraceMs: 120_000,
        orphanNodeTtlMs: 300_000,
      },
      service as never,
      { addIntervention: vi.fn() } as never,
      vi.fn(),
      logger,
    );

    await observerDispatcher.runOnce(new Date("2026-01-01T00:01:00Z"));
    expect(await scheduleRow(sql, "sched-grace")).toMatchObject({ status: "active" });

    await observerDispatcher.runOnce(new Date("2026-01-01T00:03:00Z"));
    expect(await scheduleRow(sql, "sched-grace")).toMatchObject({ status: "active" });

    await sql`
      UPDATE soulstream_schedules
      SET status = 'orphaned',
          last_error = 'owner offline'
      WHERE schedule_id = 'sched-grace'
    `;
    expect(await scheduleRow(sql, "sched-grace")).toMatchObject({ status: "orphaned" });

    const ownerTaskManager = {
      addIntervention: vi.fn(async () => ({ autoResumed: true })),
    };
    const ownerDispatcher = new ScheduleDispatcher(
      {
        nodeId: "node-a",
        startedAt: new Date("2026-01-01T00:04:00Z"),
        orphanStartupGraceMs: 120_000,
      },
      service as never,
      ownerTaskManager as never,
      vi.fn(),
      logger,
    );

    await ownerDispatcher.runOnce(new Date("2026-01-01T00:04:00Z"));
    expect(await scheduleRow(sql, "sched-grace")).toMatchObject({
      status: "completed",
      fired_count: 1,
    });
    expect(ownerTaskManager.addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "sess-grace",
      }),
      expect.any(Function),
    );
  });
});

function makeService(repo: SoulstreamScheduleRepository): SoulstreamScheduleService {
  return new SoulstreamScheduleService(
    repo,
    { emitEventEnvelope: vi.fn(async () => undefined) } as never,
    { persistEvent: vi.fn(async () => 1) } as never,
    logger,
  );
}

async function insertSession(sql: SqlClient, sessionId: string, nodeId: string): Promise<void> {
  await sql`
    INSERT INTO sessions (session_id, node_id, status, prompt, created_at, updated_at)
    VALUES (${sessionId}, ${nodeId}, 'completed', 'prompt', NOW(), NOW())
  `;
}

async function createSchedule(
  repo: SoulstreamScheduleRepository,
  overrides: Partial<ScheduleCreateInput>,
) {
  const now = new Date("2026-01-01T00:00:00Z");
  return await repo.createSchedule({
    scheduleId: "sched",
    sessionId: "sess",
    kind: "wakeup",
    prompt: "scheduled prompt",
    sourceTool: "ScheduleWakeup",
    toolUseId: "toolu-schedule",
    recurring: false,
    nextRunAt: now,
    runOnceAt: now,
    timezone: "UTC",
    createdAt: now,
    ...overrides,
  });
}

async function scheduleRow(sql: SqlClient, scheduleId: string) {
  const rows = await sql<Array<{
    schedule_id: string;
    status: string;
    next_run_at: Date | null;
    fired_count: number;
  }>>`
    SELECT schedule_id, status, next_run_at, fired_count
    FROM soulstream_schedules
    WHERE schedule_id = ${scheduleId}
  `;
  return rows[0];
}
