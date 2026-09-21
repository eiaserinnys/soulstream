import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SqlRecurringJobRepository } from "../src/recurring-jobs/repository.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import type { RecurringJob, RecurringJobRun } from "../src/recurring-jobs/types.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

describe("SqlRecurringJobRepository PostgreSQL integration", () => {
  let harness: PagePostgresHarness;
  let repository: SqlRecurringJobRepository;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    const migration = await readFile(
      new URL("../../packages/db-schema/sql/migrations/094_recurring_jobs.sql", import.meta.url),
      "utf8",
    );
    await harness.sql.unsafe(migration);
    repository = new SqlRecurringJobRepository(
      createLiveDbSqlResolver({ sql: harness.liveSql }),
    );
  }, 60_000);

  beforeEach(async () => {
    await harness.sql`
      TRUNCATE recurring_job_runs, recurring_jobs RESTART IDENTITY CASCADE
    `;
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("enforces the migration's active-run partial unique index and run-state CAS", async () => {
    await repository.createJob(job());
    const first = await repository.createManualRun(run({ runId: "run-first", sessionId: "session-first" }));
    const second = await repository.createManualRun(run({
      runId: "run-second",
      sessionId: "session-second",
      manualIdempotencyKey: "manual-second",
    }));

    expect(first).toMatchObject({ created: true, run: { runId: "run-first" } });
    expect(second).toMatchObject({
      created: true,
      run: {
        runId: "run-second",
        state: "skipped_overlap",
        manualIdempotencyKey: "manual-second",
        reasonCode: "OVERLAP_ACTIVE_RUN",
      },
    });
    const retry = await repository.createManualRun(run({
      runId: "run-second-retry",
      sessionId: "session-second-retry",
      manualIdempotencyKey: "manual-second",
    }));
    expect(retry).toMatchObject({ created: false, run: { runId: "run-second", state: "skipped_overlap" } });
    const [index] = await harness.sql<Array<{ indexdef: string }>>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'recurring_job_runs_one_active_per_job'
    `;
    expect(index?.indexdef).toContain("WHERE (state = ANY");

    const cancelled = await repository.updateRun({
      ...first.run,
      state: "cancelled",
      reasonCode: "TEST_CANCELLED",
      reasonMessage: "cancelled by test",
      finishedAt: "2026-09-21T00:01:00.000Z",
      updatedAt: "2026-09-21T00:01:00.000Z",
    }, "queued");
    const stale = await repository.updateRun({
      ...first.run,
      state: "running",
      startedAt: "2026-09-21T00:02:00.000Z",
      updatedAt: "2026-09-21T00:02:00.000Z",
    }, "queued");
    expect(cancelled).toMatchObject({ state: "cancelled" });
    expect(stale).toBeNull();
    const nextManual = await repository.createManualRun(run({
      runId: "run-after-terminal",
      sessionId: "session-after-terminal",
      manualIdempotencyKey: "manual-after-terminal",
    }));
    expect(nextManual).toMatchObject({ created: true, run: { runId: "run-after-terminal" } });
  });

  it("uses row-version CAS to reserve only one scheduled occurrence", async () => {
    const scheduledJob = job();
    await repository.createJob(scheduledJob);
    const now = new Date("2026-09-21T00:00:00.000Z");
    const first = await repository.reserveScheduledRun({
      job: scheduledJob,
      run: run({
        runId: "scheduled-first",
        sessionId: "scheduled-session",
        trigger: "scheduled",
        scheduledFor: "2026-09-21T00:00:00.000Z",
        manualIdempotencyKey: null,
      }),
      nextRunAt: new Date("2026-09-22T00:00:00.000Z"),
      now,
    });
    const stale = await repository.reserveScheduledRun({
      job: scheduledJob,
      run: run({
        runId: "scheduled-stale",
        sessionId: "scheduled-stale-session",
        trigger: "scheduled",
        scheduledFor: "2026-09-21T00:00:00.000Z",
        manualIdempotencyKey: null,
      }),
      nextRunAt: new Date("2026-09-22T00:00:00.000Z"),
      now,
    });

    expect(first).toMatchObject({ created: true, run: { runId: "scheduled-first" } });
    expect(stale).toBeNull();
    expect(await repository.listRuns(scheduledJob.jobId, 10)).toHaveLength(1);
  });

  it("does not claim a queued automatic run after pause, while a dispatch claim survives later archive", async () => {
    const pausedJob = job();
    await repository.createJob(pausedJob);
    const queued = (await repository.createScheduledRun(run({
      runId: "queued-before-pause",
      sessionId: "queued-session",
      trigger: "scheduled",
      scheduledFor: "2026-09-21T00:00:00.000Z",
      manualIdempotencyKey: null,
    }))).run;
    const paused = await repository.updateJob({
      ...pausedJob,
      enabled: false,
      nextRunAt: null,
      updatedAt: "2026-09-21T00:01:00.000Z",
    }, pausedJob.version);
    expect("code" in paused).toBe(false);
    expect(await repository.claimRunForDispatch(queued.runId, new Date("2026-09-21T00:01:00.000Z"))).toBeNull();
    await repository.cancelAutomaticPendingRuns(queued.jobId, {
      code: "JOB_PAUSED",
      message: "paused before send",
    }, new Date("2026-09-21T00:01:00.000Z"));
    expect(await repository.getRun(queued.runId)).toMatchObject({ state: "cancelled" });

    const activeJob = job({ jobId: "job-active", createdIdempotencyKey: "create-active" });
    await repository.createJob(activeJob);
    const active = (await repository.createScheduledRun(run({
      jobId: activeJob.jobId,
      runId: "run-active",
      sessionId: "session-active",
      trigger: "scheduled",
      scheduledFor: "2026-09-21T00:00:00.000Z",
      manualIdempotencyKey: null,
    }))).run;
    expect(await repository.claimRunForDispatch(active.runId, new Date("2026-09-21T00:01:00.000Z"))).toMatchObject({ state: "dispatching" });
    await repository.archiveJob(
      activeJob.jobId,
      activeJob.ownerEmail,
      activeJob.version,
      "owner@example.com",
      new Date("2026-09-21T00:02:00.000Z"),
    );
    expect(await repository.getRun(active.runId)).toMatchObject({ state: "dispatching" });
  });
});

function job(overrides: Partial<RecurringJob> = {}): RecurringJob {
  return {
    jobId: "job-1",
    ownerEmail: "owner@example.com",
    executionCaller: { source: "agent", email: "owner@example.com" },
    name: "music recommendation",
    prompt: "recommend music",
    scheduleExpressions: ["0 9 * * 1-5"],
    timezone: "Asia/Seoul",
    nodeId: "node-a",
    agentId: "roselin",
    modelPreset: null,
    container: { kind: "folder", id: "folder-a" },
    folderId: "folder-a",
    enabled: true,
    archivedAt: null,
    lateRunWindowSeconds: 1800,
    nextRunAt: "2026-09-21T00:00:00.000Z",
    version: 1,
    createdIdempotencyKey: "create-1",
    createdBy: "owner@example.com",
    updatedBy: "owner@example.com",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<RecurringJobRun> = {}): RecurringJobRun {
  return {
    runId: "run-1",
    jobId: "job-1",
    trigger: "manual",
    scheduledFor: null,
    manualIdempotencyKey: "manual-1",
    sessionId: "session-1",
    jobSnapshot: {
      name: "music recommendation",
      prompt: "recommend music",
      timezone: "Asia/Seoul",
      scheduleExpressions: ["0 9 * * 1-5"],
      nodeId: "node-a",
      agentId: "roselin",
      modelPreset: null,
      container: { kind: "folder", id: "folder-a" },
      folderId: "folder-a",
      executionCaller: { source: "agent" },
      lateRunWindowSeconds: 1800,
    },
    state: "queued",
    reasonCode: null,
    reasonMessage: null,
    createdAt: "2026-09-21T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}
