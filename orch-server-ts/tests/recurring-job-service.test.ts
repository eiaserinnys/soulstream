import { describe, expect, it, vi } from "vitest";

import { InMemoryNodeRegistry } from "../src/node/registry.js";
import { RecurringJobService } from "../src/recurring-jobs/service.js";
import { createRecurringJobTargetValidator } from "../src/recurring-jobs/target_validator.js";
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

  it("creates a future once job without compiling a cron schedule", async () => {
    const repository = memoryRepository();
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
    });

    const job = await service.create(actor, onceInput());

    expect(job).toMatchObject({
      scheduleKind: "once",
      scheduleExpressions: [],
      runAt: "2026-09-22T09:00:00+09:00",
      nextRunAt: "2026-09-22T09:00:00+09:00",
    });
  });

  it.each([
    ["neither schedule field", { runAt: undefined }],
    ["both schedule fields", { scheduleExpressions: ["0 9 * * *"] }],
    ["offset-free run_at", { runAt: "2026-09-22T09:00:00" }],
    ["invalid run_at", { runAt: "2026-02-30T09:00:00Z" }],
    ["past run_at", { runAt: "2026-09-20T09:00:00Z" }],
    ["invalid once timezone", { timezone: "Mars/Olympus" }],
  ])("rejects once creation with %s", async (_label, patch) => {
    const service = new RecurringJobService({
      repository: memoryRepository(),
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
    });

    await expect(service.create(actor, onceInput(patch)))
      .rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });
  });

  it("rejects changing schedule kind and resuming a once job after its run_at", async () => {
    const repository = memoryRepository();
    let now = new Date("2026-09-21T00:00:00.000Z");
    const service = new RecurringJobService({ repository, now: () => now, newId: sequentialIds() });
    const once = await service.create(actor, onceInput({ runAt: "2026-09-21T00:01:00Z" }));

    await expect(service.update(actor, once.jobId, {
      expectedVersion: once.version,
      scheduleExpressions: ["0 9 * * *"],
    })).rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });
    const paused = await service.update(actor, once.jobId, {
      expectedVersion: once.version,
      enabled: false,
    });
    now = new Date("2026-09-21T00:02:00.000Z");
    await expect(service.update(actor, once.jobId, {
      expectedVersion: paused.version,
      enabled: true,
    })).rejects.toMatchObject({
      code: "VALIDATION",
      statusCode: 422,
      message: "run_at must be in the future",
    });

    const recurring = await service.create(actor, { ...createInput(), idempotencyKey: "create-recurring" });
    await expect(service.update(actor, recurring.jobId, {
      expectedVersion: recurring.version,
      runAt: "2026-09-23T00:00:00Z",
    })).rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });
  });

  it("deletes a once job and its run when dispatch confirms the created session", async () => {
    const repository = memoryRepository();
    let now = new Date("2026-09-21T00:00:00.000Z");
    const service = new RecurringJobService({
      repository,
      now: () => now,
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        createRecurringSession: async () => ({ state: "running", resolvedModelPreset: null }),
        findDurableSession: async () => null,
      },
    });
    const job = await service.create(actor, onceInput({ runAt: "2026-09-21T00:01:00Z" }));
    now = new Date(job.runAt!);

    const run = await service.reserveAndDispatchDueJob(job);

    expect(run).toMatchObject({ state: "running", trigger: "scheduled" });
    expect(repository.jobs.has(job.jobId)).toBe(false);
    expect(repository.runs.size).toBe(0);
  });

  it("propagates a once-job deletion failure after session confirmation", async () => {
    const repository = memoryRepository();
    repository.deleteOnceJob = async () => { throw new Error("hard delete failed"); };
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
    const once = await service.create(actor, onceInput());

    await expect(service.runManual(actor, once.jobId, "manual-delete-error"))
      .rejects.toThrow("hard delete failed");
    expect(repository.jobs.has(once.jobId)).toBe(true);
    expect([...repository.runs.values()][0]?.state).toBe("running");
  });

  it("keeps awaiting once jobs until reconciliation observes a durable session", async () => {
    const repository = memoryRepository();
    let now = new Date("2026-09-21T00:00:00.000Z");
    let durableStatus: "completed" | null = null;
    const service = new RecurringJobService({
      repository,
      now: () => now,
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        createRecurringSession: async () => ({ state: "awaiting_session", resolvedModelPreset: null }),
        findDurableSession: async () => durableStatus ? { status: durableStatus } : null,
      },
    });
    const job = await service.create(actor, onceInput({ runAt: "2026-09-21T00:01:00Z" }));
    now = new Date(job.runAt!);
    const pending = await service.reserveAndDispatchDueJob(job);

    expect(pending).toMatchObject({ state: "awaiting_session" });
    expect(repository.jobs.get(job.jobId)?.nextRunAt).toBeNull();
    expect(repository.runs.size).toBe(1);

    durableStatus = "completed";
    const reconciled = await service.reconcileSession(pending!.sessionId);

    expect(reconciled).toMatchObject({ state: "completed" });
    expect(repository.jobs.has(job.jobId)).toBe(false);
    expect(repository.runs.size).toBe(0);
  });

  it("retains failed and late once jobs with a null next run and an explained run", async () => {
    const failedRepository = memoryRepository();
    let failedNow = new Date("2026-09-21T00:00:00.000Z");
    const failedService = new RecurringJobService({
      repository: failedRepository,
      now: () => failedNow,
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        createRecurringSession: async () => { throw new Error("before send"); },
        findDurableSession: async () => null,
      },
    });
    const failedJob = await failedService.create(actor, onceInput({ runAt: "2026-09-21T00:01:00Z" }));
    failedNow = new Date(failedJob.runAt!);
    const failedRun = await failedService.reserveAndDispatchDueJob(failedJob);

    expect(failedRun).toMatchObject({ state: "error", reasonCode: "CREATE_SESSION_BEFORE_SEND_FAILED" });
    expect(failedRepository.jobs.get(failedJob.jobId)?.nextRunAt).toBeNull();
    expect(failedRepository.runs.get(failedRun!.runId)?.reasonMessage).toContain("before send");
    const renamed = await failedService.update(actor, failedJob.jobId, {
      expectedVersion: failedRepository.jobs.get(failedJob.jobId)!.version,
      name: "failed once job",
    });
    expect(renamed.name).toBe("failed once job");
    expect(renamed.nextRunAt).toBeNull();

    const lateRepository = memoryRepository();
    let lateNow = new Date("2026-09-21T00:00:00.000Z");
    const lateService = new RecurringJobService({
      repository: lateRepository,
      now: () => lateNow,
      newId: sequentialIds(),
    });
    const lateJob = await lateService.create(actor, onceInput({
      runAt: "2026-09-21T00:01:00Z",
      lateRunWindowSeconds: 60,
    }));
    lateNow = new Date("2026-09-21T00:03:00.000Z");
    const lateRun = await lateService.reserveAndDispatchDueJob(lateJob);

    expect(lateRun).toMatchObject({ state: "skipped_late", reasonCode: "LATE_RUN_WINDOW_EXPIRED" });
    expect(lateRepository.jobs.get(lateJob.jobId)?.nextRunAt).toBeNull();
    expect(lateRepository.runs.size).toBe(1);
  });

  it("deletes a once job after a confirmed manual run", async () => {
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
    const job = await service.create(actor, onceInput());

    const run = await service.runManual(actor, job.jobId, "manual-once");

    expect(run).toMatchObject({ trigger: "manual", state: "running" });
    expect(repository.jobs.has(job.jobId)).toBe(false);
    expect(repository.runs.size).toBe(0);
  });

  it("recovers only the latest eligible occurrence and compresses older missed work", async () => {
    const repository = memoryRepository();
    let current = new Date("2026-09-20T15:00:00.000Z");
    const createRecurringSession = vi.fn(async () => ({
      state: "running" as const,
      resolvedModelPreset: "codex-default",
    }));
    const service = new RecurringJobService({
      repository,
      now: () => current,
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        createRecurringSession,
        findDurableSession: async () => null,
      },
    });
    const created = await service.create(actor, {
      ...createInput(),
      scheduleExpressions: ["0 9,12 * * 1-5"],
    });
    const due = {
      ...created,
      nextRunAt: "2026-09-21T00:00:00.000Z",
    };
    repository.jobs.set(due.jobId, due);
    current = new Date("2026-09-21T03:10:00.000Z");

    const recovered = await service.reserveAndDispatchDueJob(due);

    expect(recovered).toMatchObject({
      trigger: "scheduled",
      scheduledFor: "2026-09-21T03:00:00.000Z",
      state: "running",
    });
    expect(createRecurringSession).toHaveBeenCalledTimes(1);
    expect([...repository.runs.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        trigger: "scheduled",
        scheduledFor: "2026-09-21T00:00:00.000Z",
        state: "skipped_late",
        reasonCode: "LATE_RUN_WINDOW_EXPIRED",
        reasonMessage: expect.stringContaining("compressed"),
      }),
    ]));
    expect(repository.jobs.get(due.jobId)).toMatchObject({
      nextRunAt: "2026-09-22T00:00:00.000Z",
    });
  });

  it("persists a revised late-run window and rejects an invalid replacement", async () => {
    const repository = memoryRepository();
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
    });
    const job = await service.create(actor, createInput());

    const updated = await service.update(actor, job.jobId, {
      expectedVersion: job.version,
      lateRunWindowSeconds: 900,
    });

    expect(updated.lateRunWindowSeconds).toBe(900);
    expect(repository.jobs.get(job.jobId)?.lateRunWindowSeconds).toBe(900);
    await expect(service.update(actor, job.jobId, {
      expectedVersion: updated.version,
      lateRunWindowSeconds: 0,
    })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("pauses and cancels waiting automatic work through the production target gate after its node disconnects", async () => {
    const repository = memoryRepository();
    const registry = new InMemoryNodeRegistry();
    const registered = registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      agents: [{ id: "roselin", backend: "codex" }],
      supported_backends: ["codex"],
    });
    let current = new Date("2026-09-21T00:00:00.000Z");
    const service = new RecurringJobService({
      repository,
      now: () => current,
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => false,
        createRecurringSession: async () => ({ state: "running", resolvedModelPreset: null }),
        findDurableSession: async () => null,
      },
      validateTarget: createRecurringJobTargetValidator({
        registry,
        modelPresetAvailability: { requireAvailable: vi.fn() },
        listFolders: async () => [{ id: "folder-a", archived: false }],
        findUserByEmail: async () => ({
          email: actor.ownerEmail,
          isAdmin: false,
          allowedFolderIds: ["folder-a"],
        }),
      }),
    });
    const job = await service.create(actor, createInput());
    current = new Date(job.nextRunAt!);
    const waiting = await service.reserveAndDispatchDueJob(job);
    expect(waiting).toMatchObject({ state: "waiting_for_node" });

    registry.disconnectNode("node-a", { connectionId: registered.node.connectionId, reason: "test disconnect" });
    const currentJob = await service.get(actor, job.jobId);
    const paused = await service.update(actor, job.jobId, {
      expectedVersion: currentJob.version,
      enabled: false,
    });

    expect(paused.enabled).toBe(false);
    expect(repository.runs.get(waiting!.runId)).toMatchObject({ state: "cancelled", reasonCode: "JOB_PAUSED" });
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

  it("keeps an uncertain transport send failure awaiting instead of mislabeling it as before-send", async () => {
    const repository = memoryRepository();
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        createRecurringSession: async () => {
          throw Object.assign(new Error("socket closed after send began"), {
            code: "TRANSPORT_SEND_FAILED",
          });
        },
        findDurableSession: async () => null,
      },
    });
    const job = await service.create(actor, createInput());

    const run = await service.runManual(actor, job.jobId, "manual-uncertain-transport");

    expect(run).toMatchObject({
      state: "awaiting_session",
      reasonCode: "AWAITING_SESSION_CONFIRMATION",
    });
  });

  it("records a confirmed node rejection as terminal", async () => {
    const repository = memoryRepository();
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        createRecurringSession: async () => {
          throw Object.assign(new Error("node rejected create_session"), {
            code: "NODE_REJECTED",
            dispatchPhase: "after_send",
          });
        },
        findDurableSession: async () => null,
      },
    });
    const job = await service.create(actor, createInput());

    const run = await service.runManual(actor, job.jobId, "manual-node-rejected");

    expect(run).toMatchObject({ state: "error", reasonCode: "CREATE_SESSION_REJECTED" });
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

  it("cancels an offline manual run when the job is archived and never sends it after reconnect", async () => {
    const repository = memoryRepository();
    let connected = false;
    const createRecurringSession = vi.fn(async () => ({
      state: "running" as const,
      resolvedModelPreset: null,
    }));
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => connected,
        createRecurringSession,
        findDurableSession: async () => null,
      },
    });
    const job = await service.create(actor, createInput());
    const queued = await service.runManual(actor, job.jobId, "manual-archive-before-send");
    expect(queued.state).toBe("waiting_for_node");

    const archived = await service.archive(actor, job.jobId, job.version);
    expect(repository.runs.get(queued.runId)).toMatchObject({
      state: "cancelled",
      reasonCode: "JOB_ARCHIVED",
    });
    connected = true;

    const afterReconnect = await service.dispatchRun(archived, queued);
    expect(afterReconnect.state).toBe("cancelled");
    expect(createRecurringSession).not.toHaveBeenCalled();
  });

  it("revalidates a task target immediately before dispatch", async () => {
    const repository = memoryRepository();
    const registry = new InMemoryNodeRegistry();
    registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      agents: [{ id: "roselin", backend: "codex" }],
      supported_backends: ["codex"],
    });
    let taskArchived = false;
    const createRecurringSession = vi.fn(async () => ({
      state: "running" as const,
      resolvedModelPreset: null,
    }));
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        createRecurringSession,
        findDurableSession: async () => null,
      },
      validateTarget: createRecurringJobTargetValidator({
        registry,
        modelPresetAvailability: { requireAvailable: vi.fn() },
        listFolders: async () => [{ id: "folder-a", archived: false }],
        findUserByEmail: async () => ({
          email: actor.ownerEmail,
          isAdmin: false,
          allowedFolderIds: ["folder-a"],
        }),
      }),
    });
    const job = await service.create(actor, {
      ...createInput(),
    });
    taskArchived = true;

    const run = await service.runManual(actor, job.jobId, "manual-archived-task");

    expect(run).toMatchObject({
      state: "error",
      reasonCode: "TARGET_INVALID_AT_DISPATCH",
    });
    expect(createRecurringSession).not.toHaveBeenCalled();
  });

  it("does not send an automatic run when pause wins after the node check but before the dispatch claim", async () => {
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
        isNodeConnected: () => true,
        createRecurringSession,
        findDurableSession: async () => null,
      },
    });
    const job = await service.create(actor, createInput());
    const run = {
      ...await service.runManual(actor, job.jobId, "make-a-run"),
      trigger: "scheduled" as const,
      state: "queued" as const,
      scheduledFor: "2026-09-21T00:00:00.000Z",
    };
    repository.runs.set(run.runId, run);
    repository.jobs.set(job.jobId, { ...job, enabled: false, nextRunAt: null, version: 2 });
    createRecurringSession.mockClear();

    const result = await service.dispatchRun(job, run);

    expect(result).toMatchObject({ state: "cancelled", reasonCode: "JOB_PAUSED" });
    expect(createRecurringSession).not.toHaveBeenCalled();
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

  it("passes the verified actor and resolved target through the shared target gate", async () => {
    const validateTarget = vi.fn(async () => undefined);
    const service = new RecurringJobService({
      repository: memoryRepository(),
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
      validateTarget,
    });

    const job = await service.create(actor, createInput());
    await service.update(actor, job.jobId, { expectedVersion: job.version, folderId: "folder-b" });

    expect(validateTarget).toHaveBeenNthCalledWith(1, {
      actor,
      target: expect.objectContaining({ nodeId: "node-a", folderId: "folder-a" }),
      requireAvailableTarget: true,
    });
    expect(validateTarget).toHaveBeenNthCalledWith(2, {
      actor,
      target: expect.objectContaining({ nodeId: "node-a", folderId: "folder-b" }),
      requireAvailableTarget: false,
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

function onceInput(patch: Record<string, unknown> = {}) {
  const { scheduleExpressions: _scheduleExpressions, ...base } = createInput();
  return { ...base, runAt: "2026-09-22T09:00:00+09:00", ...patch };
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
    async deleteOnceJob(jobId) {
      if (jobs.get(jobId)?.scheduleKind !== "once") return false;
      for (const [runId, run] of runs) if (run.jobId === jobId) runs.delete(runId);
      jobs.delete(jobId);
      return true;
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
      for (const [id, run] of runs) {
        if (run.jobId === jobId && (run.state === "queued" || run.state === "waiting_for_node")) {
          runs.set(id, {
            ...run,
            state: "cancelled",
            reasonCode: "JOB_ARCHIVED",
            reasonMessage: "The recurring job was archived before this run was sent.",
            finishedAt: now.toISOString(),
            updatedAt: now.toISOString(),
          });
        }
      }
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
    async updateRun(run, expectedState) {
      const current = runs.get(run.runId);
      if (!current || (expectedState !== undefined && current.state !== expectedState)) return null;
      runs.set(run.runId, run);
      return run;
    },
    async claimRunForDispatch(runId, now) {
      const run = runs.get(runId);
      const job = run ? jobs.get(run.jobId) : undefined;
      if (!run || !job || (run.state !== "queued" && run.state !== "waiting_for_node")) return null;
      if (job.archivedAt !== null || (run.trigger === "scheduled" && !job.enabled)) return null;
      const claimed = {
        ...run,
        state: "dispatching" as const,
        reasonCode: null,
        reasonMessage: null,
        finishedAt: null,
        updatedAt: now.toISOString(),
      };
      runs.set(runId, claimed);
      return claimed;
    },
    async reserveScheduledRun({ job, compressedRun, run, nextRunAt }) {
      const current = jobs.get(job.jobId);
      if (!current || current.version !== job.version || !current.enabled || current.archivedAt) return null;
      jobs.set(job.jobId, { ...current, nextRunAt: nextRunAt?.toISOString() ?? null, version: current.version + 1 });
      if (compressedRun) runs.set(compressedRun.runId, compressedRun);
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
