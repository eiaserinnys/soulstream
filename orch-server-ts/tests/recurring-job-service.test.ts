import { describe, expect, it, vi } from "vitest";

import { RecurringJobService } from "../src/recurring-jobs/service.js";
import type {
  RecurringJob,
  RecurringJobActor,
  RecurringJobRepository,
  RecurringJobRun,
} from "../src/recurring-jobs/types.js";

const actor: RecurringJobActor = {
  ownerEmail: "owner@example.com",
  actorId: "agent-session-1",
  callerInfo: { source: "agent", email: "owner@example.com", agent_id: "roselin" },
  source: "agent",
};

describe("RecurringJobService", () => {
  it("cancels queued automatic work on pause but permits a manual run", async () => {
    const repository = memoryRepository();
    let current = new Date("2026-09-21T00:00:00.000Z");
    const createRecurringSession = vi.fn(async () => ({
      state: "running" as const,
      resolvedModelPreset: "codex-default",
    }));
    const service = new RecurringJobService({
      repository,
      now: () => current,
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => false,
        createRecurringSession,
        findDurableSession: async () => null,
      },
    });
    const job = await service.create(actor, createInput());
    current = new Date(job.nextRunAt!);
    const waiting = await service.reserveAndDispatchDueJob(job);
    expect(waiting).toMatchObject({ state: "waiting_for_node", trigger: "scheduled" });

    const currentJob = await service.get(actor, job.jobId);
    const paused = await service.update(actor, job.jobId, {
      expectedVersion: currentJob.version,
      enabled: false,
    });
    expect(paused.enabled).toBe(false);
    expect(repository.runs.get(waiting!.runId)).toMatchObject({ state: "cancelled" });

    const manual = await service.runManual(actor, job.jobId, "manual-1");
    expect(manual.state).toBe("waiting_for_node");
    expect(manual.trigger).toBe("manual");
    expect(createRecurringSession).not.toHaveBeenCalled();
  });

  it("allows a job to be staged disabled without reserving its first occurrence", async () => {
    const repository = memoryRepository();
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
    });

    const job = await service.create(actor, { ...createInput(), enabled: false });

    expect(job).toMatchObject({ enabled: false, nextRunAt: null });
    expect(await service.reserveAndDispatchDueJob(job)).toBeNull();
  });

  it("keeps an uncertain sent request on its fixed session id and never recreates it", async () => {
    const repository = memoryRepository();
    const createRecurringSession = vi.fn(async () => ({
      state: "awaiting_session" as const,
      resolvedModelPreset: "codex-default",
    }));
    const findDurableSession = vi.fn(async () => null);
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        createRecurringSession,
        findDurableSession,
      },
    });
    const job = await service.create(actor, createInput());
    const run = await service.runManual(actor, job.jobId, "manual-uncertain");
    expect(run.state).toBe("awaiting_session");

    const reconciled = await service.reconcileSession(run.sessionId);
    expect(reconciled).toMatchObject({
      runId: run.runId,
      sessionId: run.sessionId,
      state: "awaiting_session",
      reasonCode: "AWAITING_SESSION_CONFIRMATION",
    });
    expect(createRecurringSession).toHaveBeenCalledTimes(1);
    expect(findDurableSession).toHaveBeenCalledWith(run.sessionId);
  });

  it("keeps a pre-ACK dispatch distinct from an acknowledged-but-unobserved session", async () => {
    const repository = memoryRepository();
    const createRecurringSession = vi.fn(async () => ({
      state: "running" as const,
      resolvedModelPreset: null,
    }));
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => false,
        createRecurringSession,
        findDurableSession: async () => null,
      },
    });
    const job = await service.create(actor, createInput());
    const queued = await service.runManual(actor, job.jobId, "manual-dispatch-crash");
    repository.runs.set(queued.runId, {
      ...queued,
      state: "dispatching",
      reasonCode: null,
      reasonMessage: null,
    });

    const reconciled = await service.reconcileSession(queued.sessionId);

    expect(reconciled).toMatchObject({
      runId: queued.runId,
      state: "dispatching",
      reasonCode: "CREATE_SESSION_DISPATCH_UNRESOLVED",
      reasonMessage: expect.stringContaining("not be recreated"),
    });
    expect(createRecurringSession).not.toHaveBeenCalled();
  });

  it("permits a manual run while paused, but never sends a stale automatic waiting run", async () => {
    const repository = memoryRepository();
    let current = new Date("2026-09-21T00:00:00.000Z");
    let connected = false;
    const createRecurringSession = vi.fn(async () => ({
      state: "running" as const,
      resolvedModelPreset: "codex-default",
    }));
    const service = new RecurringJobService({
      repository,
      now: () => current,
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => connected,
        createRecurringSession,
        findDurableSession: async () => null,
      },
    });
    const job = await service.create(actor, createInput());
    current = new Date(job.nextRunAt!);
    const waiting = await service.reserveAndDispatchDueJob(job);
    expect(waiting?.state).toBe("waiting_for_node");

    current = new Date(current.getTime() + 1_801_000);
    connected = true;
    const expired = await service.dispatchRun(repository.jobs.get(job.jobId)!, waiting!);
    expect(expired).toMatchObject({ state: "skipped_late", reasonCode: "LATE_RUN_WINDOW_EXPIRED" });
    expect(createRecurringSession).not.toHaveBeenCalled();

    const currentJob = await service.get(actor, job.jobId);
    await service.update(actor, job.jobId, { expectedVersion: currentJob.version, enabled: false });
    const manual = await service.runManual(actor, job.jobId, "manual-after-pause");
    expect(manual.state).toBe("running");
    expect(createRecurringSession).toHaveBeenCalledTimes(1);
  });

  it("reports a deleted observed session instead of replacing it", async () => {
    const repository = memoryRepository();
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        createRecurringSession: async () => ({ state: "running", resolvedModelPreset: null }),
        findDurableSession: async () => null,
      },
    });
    const job = await service.create(actor, createInput());
    const run = await service.runManual(actor, job.jobId, "manual-deleted");
    const reconciled = await service.reconcileSession(run.sessionId);
    expect(reconciled).toMatchObject({
      state: "error",
      reasonCode: "SESSION_DELETED",
      reasonMessage: expect.stringContaining("no replacement"),
    });
  });

  it("returns the current job as a version conflict instead of overwriting it", async () => {
    const repository = memoryRepository();
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
    });
    const job = await service.create(actor, createInput());
    await expect(service.update(actor, job.jobId, {
      expectedVersion: job.version + 1,
      name: "stale write",
    })).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      currentJob: expect.objectContaining({ jobId: job.jobId, version: job.version }),
    });
  });
});

function createInput() {
  return {
    idempotencyKey: "create-1",
    name: "music recommendation",
    prompt: "recommend music",
    timezone: "Asia/Seoul",
    scheduleExpressions: ["* * * * *"],
    nodeId: "node-a",
    agentId: "roselin",
    modelPreset: null,
    container: { kind: "folder" as const, id: "folder-a" },
    folderId: "folder-a",
  };
}

function sequentialIds(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}

function memoryRepository(): RecurringJobRepository & {
  jobs: Map<string, RecurringJob>;
  runs: Map<string, RecurringJobRun>;
} {
  const jobs = new Map<string, RecurringJob>();
  const runs = new Map<string, RecurringJobRun>();
  return {
    jobs,
    runs,
    async findJobForOwner(jobId, ownerEmail, includeArchived = false) {
      const job = jobs.get(jobId);
      return job?.ownerEmail === ownerEmail && (includeArchived || job.archivedAt === null)
        ? job : null;
    },
    async listJobsForOwner(ownerEmail, includeArchived = false) {
      return [...jobs.values()].filter((job) =>
        job.ownerEmail === ownerEmail && (includeArchived || job.archivedAt === null));
    },
    async createJob(job) { jobs.set(job.jobId, job); return job; },
    async findJobByCreateIdempotency(ownerEmail, key) {
      return [...jobs.values()].find((job) =>
        job.ownerEmail === ownerEmail && job.createdIdempotencyKey === key) ?? null;
    },
    async updateJob(job, expectedVersion) {
      const current = jobs.get(job.jobId)!;
      if (current.version !== expectedVersion) return { code: "VERSION_CONFLICT" as const, job: current };
      const updated = { ...job, version: current.version + 1 };
      jobs.set(updated.jobId, updated);
      return updated;
    },
    async archiveJob(jobId, ownerEmail, expectedVersion, actorId, now) {
      const current = jobs.get(jobId);
      if (!current || current.ownerEmail !== ownerEmail) return null;
      if (current.version !== expectedVersion) return { code: "VERSION_CONFLICT" as const, job: current };
      const archived = {
        ...current, enabled: false, archivedAt: now.toISOString(), version: current.version + 1,
        updatedBy: actorId, updatedAt: now.toISOString(),
      };
      jobs.set(jobId, archived);
      return archived;
    },
    async listRuns(jobId, limit) {
      return [...runs.values()].filter((run) => run.jobId === jobId).slice(0, limit);
    },
    async findRunByManualIdempotency(jobId, key) {
      return [...runs.values()].find((run) =>
        run.jobId === jobId && run.manualIdempotencyKey === key) ?? null;
    },
    async findActiveRun(jobId) {
      return [...runs.values()].find((run) => run.jobId === jobId && [
        "queued", "waiting_for_node", "dispatching", "awaiting_session", "running",
      ].includes(run.state)) ?? null;
    },
    async createManualRun(run) {
      const same = [...runs.values()].find((existing) =>
        existing.jobId === run.jobId && existing.manualIdempotencyKey === run.manualIdempotencyKey);
      if (same) return { run: same, created: false };
      runs.set(run.runId, run);
      return { run, created: true };
    },
    async listDueJobs() { return []; },
    async listActiveRuns() { return [...runs.values()].filter((run) => [
      "queued", "waiting_for_node", "dispatching", "awaiting_session", "running",
    ].includes(run.state)); },
    async getJob(jobId) { return jobs.get(jobId) ?? null; },
    async getRun(runId) { return runs.get(runId) ?? null; },
    async getRunBySessionId(sessionId) {
      return [...runs.values()].find((run) => run.sessionId === sessionId) ?? null;
    },
    async updateRun(run) { runs.set(run.runId, run); return run; },
    async reserveScheduledRun({ job, run }) {
      const current = jobs.get(job.jobId);
      if (!current || current.version !== job.version || !current.enabled || current.archivedAt) return null;
      jobs.set(job.jobId, { ...current, version: current.version + 1 });
      runs.set(run.runId, run);
      return { run, created: true };
    },
    async cancelAutomaticPendingRuns(jobId, reason, now) {
      for (const [id, run] of runs) {
        if (run.jobId === jobId && run.trigger === "scheduled" &&
          (run.state === "queued" || run.state === "waiting_for_node")) {
          runs.set(id, {
            ...run, state: "cancelled", reasonCode: reason.code, reasonMessage: reason.message,
            finishedAt: now.toISOString(), updatedAt: now.toISOString(),
          });
        }
      }
    },
    async createScheduledRun(run) { runs.set(run.runId, run); return { run, created: true }; },
    async advanceJobNextRun() {},
  };
}
