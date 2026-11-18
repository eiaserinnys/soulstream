import { describe, expect, it, vi } from "vitest";

import { InMemoryNodeRegistry } from "../src/node/registry.js";
import { ModelPresetAvailabilityError } from "../src/model/model_preset_availability.js";
import { SessionCommandRouter } from "../src/session/session_command_router.js";
import { createRecurringSession } from "../src/session/recurring_session_creation.js";
import { recurringSessionCreateInput } from "../src/production.js";
import { RecurringJobService } from "../src/recurring-jobs/service.js";
import { createRecurringJobTargetValidator } from "../src/recurring-jobs/target_validator.js";
import type {
  RecurringJob,
  RecurringJobActor,
  RecurringJobRepository,
  RecurringJobRun,
  RecurringNodePresence,
} from "../src/recurring-jobs/types.js";

const actor: RecurringJobActor = {
  ownerEmail: "owner@example.com",
  actorId: "agent-session-1",
  callerInfo: { source: "agent", email: "owner@example.com", agent_id: "roselin" },
  source: "agent",
};

describe("RecurringJobService", () => {
  it("dispatches with an available fallback and reports all candidates unavailable", async () => {
    const repository = memoryRepository();
    const registry = new InMemoryNodeRegistry();
    registry.registerNode({ type: "node_register", node_id: "node-a", agents: [{ id: "roselin", backend: "codex" }],
      model_presets: ["first", "second"].map(id => ({ id, label: id, backend: "codex", available: true })), supported_backends: ["codex"] });
    let allLimited = false;
    const chooseUsablePreset = vi.fn(() => allLimited ? "first" : "second");
    const requireAvailable = vi.fn((_node: string, preset: string, options?: { allowLimitRejected?: boolean }) => {
      if (options?.allowLimitRejected !== true && (preset === "first" || allLimited)) {
        throw new ModelPresetAvailabilityError("MODEL_PRESET_UNAVAILABLE", "limit rejected");
      }
      return undefined as never;
    });
    const router = new SessionCommandRouter({ registry });
    vi.spyOn(router, "waitForCreatedSession").mockResolvedValue(true);
    const sendPendingCommand = vi.fn(async (routed: any) => {
      const response = { type: "session_created", requestId: routed.command.requestId, agentSessionId: routed.command.message.agentSessionId };
      registry.receiveNodeMessage("node-a", response);
      return response;
    });
    const launch = vi.fn(async ({ job, run }: { job: RecurringJob; run: RecurringJobRun }) => createRecurringSession({
      router, bridge: { sendPendingCommand } as never, modelPresetAvailability: { chooseUsablePreset, requireAvailable },
    }, recurringSessionCreateInput(job, run)));
    const service = new RecurringJobService({ repository, now: () => new Date("2026-09-21T00:00:00.000Z"),
      validateTarget: createRecurringJobTargetValidator({ registry, modelPresetAvailability: { chooseUsablePreset, requireAvailable },
        listFolders: async () => [{ id: "folder-a" }],
        findUserByEmail: async () => ({ email: actor.ownerEmail, isAdmin: false, allowedFolderIds: ["folder-a"] }) }),
      launcher: { isNodeConnected: () => true, createRecurringSession: launch, findDurableSession: async () => null } });
    await expect(service.create(actor, { ...createInput(), modelPreset: "first", modelPresetFallbacks: ["unknown"] }))
      .rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("not advertised") });
    const job = await service.create(actor, { ...createInput(), modelPreset: "first", modelPresetFallbacks: ["second"] });
    const run = await service.runManual(actor, job.jobId, "available");
    expect(run).toMatchObject({ state: "running", jobSnapshot: { modelPresetFallbacks: ["second"], resolvedModelPreset: "second" } });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ job: expect.objectContaining({ modelPresetFallbacks: ["second"] }) }));
    expect(sendPendingCommand.mock.calls[0]![0].command.message).toMatchObject({
      model_preset: "second", initial_model_preset: "first", model_preset_fallbacks: ["second"],
    });
    repository.runs.set(run.runId, { ...run, state: "completed" });
    allLimited = true;
    const rejected = await service.runManual(actor, job.jobId, "limited");
    expect(rejected).toMatchObject({ state: "error", reasonCode: "TARGET_INVALID_AT_DISPATCH" });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("executes an older snapshot without the fallback key", async () => {
    const repository = memoryRepository();
    let connected = false;
    const launch = vi.fn(async () => ({ state: "running" as const, resolvedModelPreset: null }));
    const service = new RecurringJobService({ repository, now: () => new Date("2026-09-21T00:00:00.000Z"), newId: sequentialIds(),
      launcher: { isNodeConnected: () => connected, createRecurringSession: launch, findDurableSession: async () => null } });
    const job = await service.create(actor, { ...createInput(), modelPresetFallbacks: ["fallback"] });
    const waiting = await service.runManual(actor, job.jobId, "old-snapshot");
    const { modelPresetFallbacks: _oldKey, ...oldSnapshot } = waiting.jobSnapshot;
    const oldRun = { ...waiting, jobSnapshot: oldSnapshot };
    repository.runs.set(oldRun.runId, oldRun);
    connected = true;
    const result = await service.dispatchRun(job, oldRun);
    expect(result.state).toBe("running");
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ job: expect.objectContaining({ modelPresetFallbacks: [] }) }));
  });
  it.each(["recurring", "once", "event"] as const)("saves and updates fallback order for %s jobs", async (kind) => {
    const validateTarget = vi.fn(async () => undefined);
    const service = new RecurringJobService({ repository: memoryRepository(), validateTarget,
      now: () => new Date("2026-09-21T00:00:00.000Z"), newId: sequentialIds() });
    const base = kind === "once" ? onceInput() : kind === "event"
      ? { ...createInput(), scheduleExpressions: undefined, eventTrigger: { type: "node_connected" as const } }
      : createInput();
    const created = await service.create(actor, { ...base, modelPreset: "first", modelPresetFallbacks: [" second ", "first", "second"] });
    expect(created.modelPresetFallbacks).toEqual(["second"]);
    expect((await service.get(actor, created.jobId)).modelPresetFallbacks).toEqual(["second"]);
    const kept = await service.update(actor, created.jobId, { expectedVersion: created.version, name: "updated" });
    expect(kept.modelPresetFallbacks).toEqual(["second"]);
    const changed = await service.update(actor, kept.jobId, { expectedVersion: kept.version, modelPresetFallbacks: ["third"] });
    expect(changed.modelPresetFallbacks).toEqual(["third"]);
    expect(validateTarget).toHaveBeenLastCalledWith(expect.objectContaining({ requireAvailableTarget: true }));
    const cleared = await service.update(actor, changed.jobId, { expectedVersion: changed.version, modelPresetFallbacks: [] });
    expect(cleared.modelPresetFallbacks).toEqual([]);
  });
  it("provides all-owner reads while preserving the existing archive filter", async () => {
    const repository = memoryRepository();
    const service = new RecurringJobService({
      repository,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
    });
    const ownerB = { ...actor, ownerEmail: "owner-b@example.com", actorId: "owner-b-session" };
    const first = await service.create(actor, { ...createInput(), idempotencyKey: "owner-a" });
    const second = await service.create(ownerB, { ...createInput(), idempotencyKey: "owner-b" });
    await service.archive(ownerB, second.jobId, second.version);

    expect((await service.listAllOwners()).map((candidate) => candidate.jobId)).toEqual([first.jobId]);
    expect((await service.listAllOwners(true)).map((candidate) => candidate.jobId)).toEqual([
      first.jobId,
      second.jobId,
    ]);
    expect(await service.ownerEmailOf(second.jobId)).toBe("owner-b@example.com");
    expect(await service.ownerEmailOf("missing-job")).toBeNull();
  });

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
        modelPresetAvailability: { requireAvailable: vi.fn(), chooseUsablePreset: vi.fn() },
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

  it("revalidates a folder target immediately before dispatch", async () => {
    const repository = memoryRepository();
    const registry = new InMemoryNodeRegistry();
    registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      agents: [{ id: "roselin", backend: "codex" }],
      supported_backends: ["codex"],
    });
    let folderArchived = false;
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
        modelPresetAvailability: { requireAvailable: vi.fn(), chooseUsablePreset: vi.fn() },
        listFolders: async () => [{ id: "folder-a", archived: folderArchived }],
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
    folderArchived = true;

    const run = await service.runManual(actor, job.jobId, "manual-archived-folder");

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

  it("stores external provenance, enforces the same owner ACL and dispatches without a live caller session", async () => {
    const callerInfo = { source: "dot", external_agent_id: "registered-dot", agent_id: "registered-dot", email: actor.ownerEmail };
    const external = { ...actor, actorId: "registered-dot", source: "external-llm" as const, callerInfo };
    const repository = memoryRepository();
    const launch = vi.fn(async () => ({ state: "running" as const, resolvedModelPreset: null }));
    const service = new RecurringJobService({ repository, now: () => new Date("2026-09-21T00:00:00.000Z"), newId: sequentialIds(),
      launcher: { isNodeConnected: () => true, createRecurringSession: launch, findDurableSession: async () => null } });
    const job = await service.create(external, createInput());
    expect(job.executionCaller).toEqual(callerInfo);
    expect((await service.list(external)).map(j => j.jobId)).toEqual([job.jobId]);
    const stranger = { ...external, ownerEmail: "stranger@example.com" };
    expect(await service.list(stranger)).toEqual([]);
    await expect(service.get(stranger, job.jobId)).rejects.toMatchObject({ statusCode: 404 });
    await service.runManual(external, job.jobId, "external-run");
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ job: expect.objectContaining({ executionCaller: callerInfo }) }));
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
      purpose: "settings",
    });
    expect(validateTarget).toHaveBeenNthCalledWith(2, {
      actor,
      target: expect.objectContaining({ nodeId: "node-a", folderId: "folder-b" }),
      requireAvailableTarget: false,
      purpose: "settings",
    });
  });

  it("fires a node-connected event job only after its settle time and deletes a single-run job", async () => {
    const repository = memoryRepository();
    let now = new Date("2026-09-21T00:00:00.000Z");
    const createRecurringSession = vi.fn(async () => ({
      state: "running" as const,
      resolvedModelPreset: null,
    }));
    const service = new RecurringJobService({
      repository,
      now: () => now,
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        nodeConnectedAtMs: () => Date.parse("2026-09-21T00:00:00.000Z"),
        createRecurringSession,
        findDurableSession: async () => null,
      },
    });
    const job = await service.create(actor, eventInput());
    expect(job).toMatchObject({
      scheduleKind: "event",
      nextRunAt: null,
      eventLastFiredAt: null,
      eventTrigger: {
        type: "node_connected",
        nodeId: "node-b",
        settleSeconds: 180,
        cooldownSeconds: 3600,
        repeat: false,
      },
    });

    now = new Date("2026-09-21T00:02:59.000Z");
    expect(await service.processEventTriggers()).toEqual([]);
    expect(createRecurringSession).not.toHaveBeenCalled();

    now = new Date("2026-09-21T00:03:00.000Z");
    const fired = await service.processEventTriggers();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ trigger: "event", state: "running", scheduledFor: now.toISOString() });
    expect(createRecurringSession).toHaveBeenCalledTimes(1);
    expect(repository.jobs.has(job.jobId)).toBe(false);
    expect(repository.runs.size).toBe(0);
    expect(await service.processEventTriggers()).toEqual([]);
  });

  it("fires once per connected episode for a repeating event job", async () => {
    const repository = memoryRepository();
    const connectedAt = Date.parse("2026-09-20T23:00:00.000Z");
    const now = new Date("2026-09-21T00:00:00.000Z");
    const createRecurringSession = vi.fn(async () => ({
      state: "running" as const,
      resolvedModelPreset: null,
    }));
    const service = new RecurringJobService({
      repository,
      now: () => now,
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        nodeConnectedAtMs: () => connectedAt,
        createRecurringSession,
        findDurableSession: async () => ({ status: "completed" as const }),
      },
    });
    const job = await service.create(actor, eventInput({
      eventTrigger: { type: "node_connected", nodeId: "node-b", repeat: true },
    }));

    const first = await service.processEventTriggers();
    expect(first).toHaveLength(1);
    await service.reconcileSession(first[0]!.sessionId);
    expect(repository.jobs.get(job.jobId)?.eventLastFiredAt).toBe(now.toISOString());
    expect(repository.presence.get("node-b")).toMatchObject({
      episodeStartedAt: new Date(connectedAt).toISOString(),
      lastSeenAt: now.toISOString(),
    });

    expect(await service.processEventTriggers()).toEqual([]);
    expect(createRecurringSession).toHaveBeenCalledTimes(1);
  });

  it("keeps one presence episode across short reconnects and refires only after the gap and cooldown", async () => {
    const repository = memoryRepository();
    let now = new Date("2026-09-21T00:00:00.000Z");
    let connectedAt = new Date("2026-09-20T23:59:00.000Z");
    const createRecurringSession = vi.fn(async () => ({
      state: "running" as const,
      resolvedModelPreset: null,
    }));
    const service = new RecurringJobService({
      repository,
      now: () => now,
      newId: sequentialIds(),
      launcher: {
        isNodeConnected: () => true,
        nodeConnectedAtMs: () => connectedAt.getTime(),
        createRecurringSession,
        findDurableSession: async () => ({ status: "completed" as const }),
      },
    });
    await service.create(actor, eventInput({
      eventTrigger: {
        type: "node_connected",
        nodeId: "node-b",
        settleSeconds: 0,
        cooldownSeconds: 3600,
        repeat: true,
      },
    }));
    const first = await service.processEventTriggers();
    expect(first).toHaveLength(1);
    await service.reconcileSession(first[0]!.sessionId);
    const firedAtMs = now.getTime();
    const firstEpisode = repository.presence.get("node-b")?.episodeStartedAt;

    // An orchestrator restart 60 seconds later reports a fresh connection instant
    // while the node never went away: the same episode must not fire again.
    connectedAt = new Date(firedAtMs + 60_000);
    now = new Date(firedAtMs + 60_000);
    expect(await service.processEventTriggers()).toEqual([]);
    expect(repository.presence.get("node-b")?.episodeStartedAt).toBe(firstEpisode);

    // A 700-second gap starts a new episode, but the cooldown has not elapsed.
    connectedAt = new Date(firedAtMs + 760_000);
    now = new Date(firedAtMs + 760_000);
    expect(await service.processEventTriggers()).toEqual([]);
    expect(repository.presence.get("node-b")?.episodeStartedAt)
      .toBe(new Date(firedAtMs + 760_000).toISOString());

    // The new episode is eligible once the cooldown has fully elapsed.
    now = new Date(firedAtMs + 3_600_000);
    const second = await service.processEventTriggers();
    expect(second).toHaveLength(1);
    expect(createRecurringSession).toHaveBeenCalledTimes(2);
  });

  it("accepts exactly one trigger source and rejects kind-changing updates", async () => {
    const service = new RecurringJobService({
      repository: memoryRepository(),
      now: () => new Date("2026-09-21T00:00:00.000Z"),
      newId: sequentialIds(),
    });

    const { scheduleExpressions: _scheduleExpressions, ...withoutSchedule } = createInput();
    await expect(service.create(actor, {
      ...withoutSchedule,
      eventTrigger: { type: "node_connected" },
      idempotencyKey: "bare-event",
    })).resolves.toMatchObject({
      scheduleKind: "event",
      eventTrigger: {
        nodeId: "node-a",
        settleSeconds: 180,
        cooldownSeconds: 3600,
        repeat: false,
      },
    });
    await expect(service.create(actor, {
      ...createInput(),
      eventTrigger: { type: "node_connected" },
      idempotencyKey: "two-sources",
    })).rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });
    await expect(service.create(actor, {
      ...onceInput(),
      eventTrigger: { type: "node_connected" },
      idempotencyKey: "once-and-event",
    })).rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });
    await expect(service.create(actor, {
      ...withoutSchedule,
      idempotencyKey: "no-source",
    })).rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });
    await expect(service.create(actor, {
      ...withoutSchedule,
      eventTrigger: { type: "card_switched" },
      idempotencyKey: "unknown-event",
    })).rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });

    const recurring = await service.create(actor, { ...createInput(), idempotencyKey: "recurring-kind" });
    const event = await service.create(actor, { ...eventInput(), idempotencyKey: "event-kind" });
    const once = await service.create(actor, { ...onceInput(), idempotencyKey: "once-kind" });
    await expect(service.update(actor, event.jobId, {
      expectedVersion: event.version,
      scheduleExpressions: ["0 9 * * *"],
    })).rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });
    await expect(service.update(actor, event.jobId, {
      expectedVersion: event.version,
      runAt: "2026-09-22T09:00:00Z",
    })).rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });
    await expect(service.update(actor, recurring.jobId, {
      expectedVersion: recurring.version,
      eventTrigger: { type: "node_connected" },
    })).rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });
    await expect(service.update(actor, once.jobId, {
      expectedVersion: once.version,
      eventTrigger: { type: "node_connected" },
    })).rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });
    await expect(service.update(actor, event.jobId, {
      expectedVersion: event.version,
      eventTrigger: { type: "node_connected", settleSeconds: 3601 },
    })).rejects.toMatchObject({ code: "VALIDATION", statusCode: 422 });

    const updated = await service.update(actor, event.jobId, {
      expectedVersion: event.version,
      eventTrigger: { type: "node_connected", settleSeconds: 0, cooldownSeconds: 0, repeat: true },
    });
    expect(updated.eventTrigger).toMatchObject({
      nodeId: "node-a",
      settleSeconds: 0,
      cooldownSeconds: 0,
      repeat: true,
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

function eventInput(patch: Record<string, unknown> = {}) {
  const { scheduleExpressions: _scheduleExpressions, ...base } = createInput();
  return {
    ...base,
    eventTrigger: {
      type: "node_connected",
      nodeId: "node-b",
      settleSeconds: 180,
      cooldownSeconds: 3600,
      repeat: false,
    },
    ...patch,
  };
}

function sequentialIds(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}

function memoryRepository(): RecurringJobRepository & {
  jobs: Map<string, RecurringJob>;
  runs: Map<string, RecurringJobRun>;
  presence: Map<string, RecurringNodePresence>;
} {
  const jobs = new Map<string, RecurringJob>();
  const runs = new Map<string, RecurringJobRun>();
  const presence = new Map<string, RecurringNodePresence>();
  return {
    jobs,
    runs,
    presence,
    async findJobForOwner(jobId, ownerEmail, includeArchived = false) {
      const job = jobs.get(jobId);
      return job?.ownerEmail === ownerEmail && (includeArchived || job.archivedAt === null)
        ? job : null;
    },
    async listJobsForOwner(ownerEmail, includeArchived = false) {
      return [...jobs.values()].filter((job) =>
        job.ownerEmail === ownerEmail && (includeArchived || job.archivedAt === null));
    },
    async listAllJobs(includeArchived = false) {
      return [...jobs.values()].filter((job) => includeArchived || job.archivedAt === null);
    },
    async findJobOwnerEmail(jobId) {
      return jobs.get(jobId)?.ownerEmail ?? null;
    },
    async createJob(job) { jobs.set(job.jobId, job); return job; },
    async findJobByCreateIdempotency(ownerEmail, key) {
      return [...jobs.values()].find((job) =>
        job.ownerEmail === ownerEmail && job.createdIdempotencyKey === key) ?? null;
    },
    async deleteOnceJob(jobId) {
      const job = jobs.get(jobId);
      const singleRun = job?.scheduleKind === "once" ||
        (job?.scheduleKind === "event" && job.eventTrigger != null && !job.eventTrigger.repeat);
      if (!job || !singleRun) return false;
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
    async listEventJobs(limit) {
      return [...jobs.values()].filter((job) =>
        job.scheduleKind === "event" && job.enabled && job.archivedAt === null).slice(0, limit);
    },
    async getNodePresence(nodeId) { return presence.get(nodeId) ?? null; },
    async upsertNodePresence(next) { presence.set(next.nodeId, next); return next; },
    async reserveEventRun({ job, run, now }) {
      const current = jobs.get(job.jobId);
      if (!current || current.version !== job.version || !current.enabled || current.archivedAt) return null;
      jobs.set(job.jobId, { ...current, eventLastFiredAt: now.toISOString(), version: current.version + 1 });
      runs.set(run.runId, run);
      return { run, created: true };
    },
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
