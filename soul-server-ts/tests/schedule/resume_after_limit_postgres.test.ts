import { spawnSync } from "node:child_process";

import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SqlClient } from "../../src/db/session_db.js";
import { ScheduleDispatcher } from "../../src/schedule/schedule_dispatcher.js";
import type { ScheduleCreateInput } from "../../src/schedule/schedule_models.js";
import { SoulstreamScheduleRepository } from "../../../orch-server-ts/src/schedule/schedule_repository.js";
import { SoulstreamScheduleService } from "../../src/schedule/schedule_service.js";
import {
  createPostgresTestHarness,
  type PostgresTestHarness,
} from "./postgres_test_harness.js";

const logger = pino({ level: "silent" });
const describePostgres = Boolean(process.env.TEST_DATABASE_URL?.trim())
  || spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0
  ? describe : describe.skip;

describePostgres("ResumeAfterLimit stored continuity and dispatch", () => {
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
    await sql`TRUNCATE soulstream_schedules, events, sessions, soulstream_node_heartbeats`;
  });

  it("dispatches the original 3232 reservation once after 3246 and 3259 hit the same limit window", async () => {
    const sessionId = "sess-continuous-limit";
    const now = new Date("2026-09-28T14:50:06.672Z");
    await seedResumeHistory(sql, sessionId);
    await repo.touchNodeHeartbeat("node-a");
    const original = await createSchedule(repo, {
      scheduleId: `resume-after-limit:${sessionId}:3232:0`,
      sessionId,
      sourceTool: "ResumeAfterLimit",
      toolUseId: "ResumeAfterLimit:3232",
      runOnceAt: new Date("2026-09-28T14:50:00Z"),
      nextRunAt: new Date("2026-09-28T14:50:00Z"),
    });
    const service = makeService(repo);
    const onResume = vi.fn();
    const taskManager = {
      getScheduleResumeState: vi.fn(async () => {
        const rows = await sql<Array<{
          status: string; termination_reason: string; termination_event_id: number;
        }>>`SELECT status, termination_reason, termination_event_id FROM sessions WHERE session_id = ${sessionId}`;
        return {
          status: rows[0].status,
          terminationReason: rows[0].termination_reason,
          terminalEventId: rows[0].termination_event_id,
        };
      }),
      addIntervention: vi.fn(async (_params: unknown, callback: typeof onResume) => {
        await callback({} as never);
        return { autoResumed: true };
      }),
    };
    const dispatcher = new ScheduleDispatcher(
      { nodeId: "node-a" }, service as never, taskManager as never, onResume, logger,
    );

    await dispatcher.runOnce(now);

    expect(taskManager.getScheduleResumeState).toHaveBeenCalledWith(sessionId);
    expect(taskManager.addIntervention).toHaveBeenCalledOnce();
    expect(taskManager.addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: sessionId, queueIfRunning: false }),
      onResume,
    );
    expect(onResume).toHaveBeenCalledOnce();
    expect(await scheduleRow(sql, original.scheduleId)).toMatchObject({
      status: "completed", fired_count: 1,
    });
  });

  it("keeps the original terminal revision eligible on the unchanged normal path", async () => {
    const sessionId = "sess-same-revision";
    await seedResumeHistory(sql, sessionId);
    await sql`
      UPDATE sessions SET termination_event_id = 3232 WHERE session_id = ${sessionId}
    `;
    const schedule = await createSchedule(repo, {
      scheduleId: `resume-after-limit:${sessionId}:3232:0`,
      sessionId, sourceTool: "ResumeAfterLimit", toolUseId: "ResumeAfterLimit:3232",
    });

    expect(await repo.hasContinuousLimitWindow(schedule, 3232)).toBe(true);
  });

  it("never dispatches an old reservation after a different window, completed turn, running state, or central revision mismatch", async () => {
    const cases = [
      {
        name: "different window",
        prepare: async (sessionId: string) => {
          await sql`
            UPDATE events SET payload = ${sql.json({
              status: "rejected", resets_at: "2026-09-28T15:50:00Z",
            })}::jsonb WHERE session_id = ${sessionId} AND id = 3258
          `;
        },
      },
      {
        name: "intermediate completed turn",
        prepare: async (sessionId: string) => {
          await sql`
            UPDATE events SET payload = ${sql.json({ termination_reason: "completed" })}::jsonb
            WHERE session_id = ${sessionId} AND id = 3246
          `;
        },
      },
      {
        name: "current running",
        prepare: async (sessionId: string) => {
          await sql`
            UPDATE sessions SET status = 'running', termination_reason = NULL,
              termination_event_id = NULL WHERE session_id = ${sessionId}
          `;
        },
      },
      {
        name: "central revision differs from worker",
        prepare: async () => undefined,
        workerRevision: 3246,
      },
    ];
    for (const blocked of cases) {
      await sql`TRUNCATE soulstream_schedules, events, sessions, soulstream_node_heartbeats`;
      const sessionId = `sess-blocked-${blocked.name.replaceAll(" ", "-")}`;
      await seedResumeHistory(sql, sessionId);
      await blocked.prepare(sessionId);
      await repo.touchNodeHeartbeat("node-a");
      const now = new Date("2026-09-28T14:50:06.672Z");
      const schedule = await createSchedule(repo, {
        scheduleId: `resume-after-limit:${sessionId}:3232:0`,
        sessionId, sourceTool: "ResumeAfterLimit", toolUseId: "ResumeAfterLimit:3232",
        runOnceAt: new Date("2026-09-28T14:50:00Z"), nextRunAt: new Date("2026-09-28T14:50:00Z"),
      });
      const taskManager = {
        getScheduleResumeState: vi.fn(async () => {
          const rows = await sql<Array<{
            status: string; termination_reason: string | null; termination_event_id: number | null;
          }>>`SELECT status, termination_reason, termination_event_id FROM sessions WHERE session_id = ${sessionId}`;
          return {
            status: rows[0].status,
            terminationReason: rows[0].termination_reason,
            terminalEventId: ("workerRevision" in blocked ? blocked.workerRevision : undefined)
              ?? rows[0].termination_event_id,
          };
        }),
        addIntervention: vi.fn(async () => ({ autoResumed: true })),
      };
      const dispatcher = new ScheduleDispatcher(
        { nodeId: "node-a" }, makeService(repo) as never,
        taskManager as never, vi.fn(), logger,
      );

      await dispatcher.runOnce(now);

      expect(taskManager.addIntervention, blocked.name).not.toHaveBeenCalled();
      expect(await scheduleRow(sql, schedule.scheduleId), blocked.name).toMatchObject({
        status: "completed", fired_count: 1,
      });
    }
  });
});

function makeService(repo: SoulstreamScheduleRepository): SoulstreamScheduleService {
  return new SoulstreamScheduleService(
    repo,
    { emitEventEnvelope: vi.fn(async () => undefined) } as never,
    { enqueueEvent: vi.fn(async () => ({ source_seq: 1 })) } as never,
    logger,
  );
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

async function seedResumeHistory(sql: SqlClient, sessionId: string): Promise<void> {
  await sql`
    INSERT INTO sessions (
      session_id, node_id, status, termination_reason, termination_event_id, prompt
    ) VALUES (${sessionId}, 'node-a', 'error', 'limit_hit', 3259, 'prompt')
  `;
  const reset = "2026-09-28T14:50:00Z";
  for (const [id, eventType, payload] of [
    [3231, "credential_alert", { status: "rejected", resets_at: reset }],
    [3232, "session_ended", { termination_reason: "limit_hit" }],
    [3245, "error", { error_code: "claude_rate_limit_stop_failure", fatal: true, resets_at: reset }],
    [3246, "session_ended", { termination_reason: "limit_hit" }],
    [3258, "credential_alert", { status: "rejected", resets_at: reset }],
    [3259, "session_ended", { termination_reason: "limit_hit" }],
  ] as const) {
    await sql`
      INSERT INTO events (session_id, id, event_type, payload)
      VALUES (${sessionId}, ${id}, ${eventType}, ${sql.json(payload)}::jsonb)
    `;
  }
}
