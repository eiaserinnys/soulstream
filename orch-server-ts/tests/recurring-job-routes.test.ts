import { describe, expect, it, vi } from "vitest";

import { createApp, parseOrchServerConfig } from "../src/index.js";
import { RecurringJobService } from "../src/recurring-jobs/service.js";
import type { RecurringJob, RecurringJobActor, RecurringJobRepository } from "../src/recurring-jobs/types.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "service-token",
});

const browserActor: RecurringJobActor = {
  ownerEmail: "owner@example.com",
  actorId: "owner@example.com",
  callerInfo: { source: "browser", email: "owner@example.com" },
  source: "browser",
};
const agentActor: RecurringJobActor = {
  ownerEmail: "owner@example.com",
  actorId: "agent-session-1",
  callerInfo: { source: "agent", email: "owner@example.com" },
  source: "agent",
};

describe("recurring job routes", () => {
  it("uses the same service for authenticated UI and bearer-authorized MCP host creation", async () => {
    const service = fakeService();
    const app = createApp({
      config,
      recurringJobRoutes: { service, resolveActor: async () => browserActor },
      recurringJobHostRoutes: { service, authBearerToken: "service-token" },
    });
    try {
      const ui = await app.inject({ method: "POST", url: "/api/recurring-jobs", payload: createBody("ui-create") });
      const host = await app.inject({
        method: "POST",
        url: "/api/recurring-jobs/host/create",
        headers: { authorization: "Bearer service-token" },
        payload: { ...createBody("agent-create"), actor: agentActor },
      });
      const hostUpdate = await app.inject({
        method: "POST",
        url: "/api/recurring-jobs/host/update",
        headers: { authorization: "Bearer service-token" },
        payload: {
          job_id: "job-1",
          expected_version: 1,
          enabled: false,
          actor: agentActor,
        },
      });
      expect(ui.statusCode).toBe(201);
      expect(host.statusCode).toBe(200);
      expect(hostUpdate.statusCode).toBe(200);
      expect(service.create).toHaveBeenNthCalledWith(1, browserActor, expect.objectContaining({ idempotencyKey: "ui-create", enabled: false }));
      expect(service.create).toHaveBeenNthCalledWith(2, agentActor, expect.objectContaining({ idempotencyKey: "agent-create", enabled: false }));
      expect(service.update).toHaveBeenCalledWith(
        agentActor,
        "job-1",
        expect.objectContaining({ expectedVersion: 1, enabled: false }),
      );
    } finally {
      await app.close();
    }
  });

  it("persists a verified agent caller through the host route and shared target gate", async () => {
    const { service, validateTarget } = persistedService();
    const app = createApp({
      config,
      recurringJobHostRoutes: { service, authBearerToken: "service-token" },
    });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/recurring-jobs/host/create",
        headers: { authorization: "Bearer service-token" },
        payload: { ...createBody("trusted-agent-create"), actor: agentActor },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({
        job: {
          owner_email: agentActor.ownerEmail,
          node_id: "node-a",
          agent_id: "roselin",
          version: 1,
        },
      });

      const jobId = created.json<{ job: { job_id: string } }>().job.job_id;
      const updated = await app.inject({
        method: "POST",
        url: "/api/recurring-jobs/host/update",
        headers: { authorization: "Bearer service-token" },
        payload: { job_id: jobId, expected_version: 1, enabled: false, actor: agentActor },
      });
      const listed = await app.inject({
        method: "POST",
        url: "/api/recurring-jobs/host/list",
        headers: { authorization: "Bearer service-token" },
        payload: { actor: agentActor },
      });

      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ job: { enabled: false, version: 2 } });
      expect(listed.json()).toMatchObject({ jobs: [{ job_id: jobId, enabled: false }] });
      expect(validateTarget).toHaveBeenNthCalledWith(1, {
        actor: agentActor,
        target: expect.objectContaining({ nodeId: "node-a", folderId: "folder-a" }),
        requireAvailableTarget: true,
      });
      expect(validateTarget).toHaveBeenNthCalledWith(2, {
        actor: agentActor,
        target: expect.objectContaining({ nodeId: "node-a", folderId: "folder-a" }),
        requireAvailableTarget: false,
      });
    } finally {
      await app.close();
    }
  });

  it("does not let an unauthenticated browser request select an owner", async () => {
    const service = fakeService();
    const app = createApp({
      config,
      recurringJobRoutes: { service, resolveActor: async () => null },
    });
    try {
      const result = await app.inject({
        method: "GET",
        url: "/api/recurring-jobs?owner_email=spoof@example.com",
      });
      expect(result.statusCode).toBe(401);
      expect(service.list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns a validation response for an invalid schedule instead of an internal error", async () => {
    const service = new RecurringJobService({ repository: failingRepository() });
    const app = createApp({
      config,
      recurringJobRoutes: { service, resolveActor: async () => browserActor },
    });
    try {
      const result = await app.inject({
        method: "POST",
        url: "/api/recurring-jobs/preview",
        payload: { timezone: "Asia/Seoul", schedule_expressions: ["not a cron"] },
      });
      expect(result.statusCode).toBe(422);
      expect(result.json()).toMatchObject({ detail: { error: { code: "VALIDATION" } } });
    } finally {
      await app.close();
    }
  });
});

function fakeService() {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => job()),
    preview: vi.fn(() => ({ timezone: "Asia/Seoul", scheduleExpressions: ["0 9 * * 1-5"], nextRuns: [] })),
    create: vi.fn(async () => job()),
    update: vi.fn(async () => job()),
    archive: vi.fn(async () => job()),
    listRuns: vi.fn(async () => []),
    runManual: vi.fn(async () => ({ runId: "run-1" })),
  } as unknown as RecurringJobService & {
    create: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
}

function persistedService() {
  const jobs = new Map<string, RecurringJob>();
  const repository = failingRepository() as unknown as RecurringJobRepository;
  repository.findJobByCreateIdempotency = async (ownerEmail, idempotencyKey) =>
    [...jobs.values()].find((candidate) =>
      candidate.ownerEmail === ownerEmail && candidate.createdIdempotencyKey === idempotencyKey,
    ) ?? null;
  repository.createJob = async (input) => {
    jobs.set(input.jobId, input);
    return input;
  };
  repository.findJobForOwner = async (jobId, ownerEmail, includeArchived = false) => {
    const candidate = jobs.get(jobId);
    return candidate?.ownerEmail === ownerEmail && (includeArchived || candidate.archivedAt === null)
      ? candidate
      : null;
  };
  repository.listJobsForOwner = async (ownerEmail, includeArchived = false) =>
    [...jobs.values()].filter((candidate) =>
      candidate.ownerEmail === ownerEmail && (includeArchived || candidate.archivedAt === null),
    );
  repository.updateJob = async (candidate, expectedVersion) => {
    const current = jobs.get(candidate.jobId);
    if (!current || current.version !== expectedVersion) {
      return { code: "VERSION_CONFLICT" as const, job: current ?? candidate };
    }
    const updated = { ...candidate, version: expectedVersion + 1 };
    jobs.set(updated.jobId, updated);
    return updated;
  };
  const validateTarget = vi.fn(async () => undefined);
  return {
    service: new RecurringJobService({ repository, validateTarget }),
    validateTarget,
  };
}

function failingRepository() {
  return {
    findJobForOwner: async () => null,
    listJobsForOwner: async () => [],
    createJob: async () => { throw new Error("unused"); },
    findJobByCreateIdempotency: async () => null,
    updateJob: async () => { throw new Error("unused"); },
    archiveJob: async () => null,
    listRuns: async () => [],
    findRunByManualIdempotency: async () => null,
    findActiveRun: async () => null,
    createManualRun: async () => { throw new Error("unused"); },
    listDueJobs: async () => [],
    listActiveRuns: async () => [],
    getJob: async () => null,
    getRun: async () => null,
    getRunBySessionId: async () => null,
    updateRun: async () => { throw new Error("unused"); },
    claimRunForDispatch: async () => null,
    reserveScheduledRun: async () => null,
    cancelAutomaticPendingRuns: async () => undefined,
    createScheduledRun: async () => { throw new Error("unused"); },
    advanceJobNextRun: async () => undefined,
  };
}

function createBody(idempotencyKey: string) {
  return {
    idempotency_key: idempotencyKey,
    name: "music recommendation",
    prompt: "recommend music",
    timezone: "Asia/Seoul",
    schedule_expressions: ["0 9,12 * * 1-5"],
    node_id: "node-a",
    agent_id: "roselin",
    model_preset: null,
    container: { kind: "folder", id: "folder-a" },
    folder_id: "folder-a",
    enabled: false,
  };
}

function job(): RecurringJob {
  return {
    jobId: "job-1", ownerEmail: "owner@example.com", executionCaller: {},
    name: "music recommendation", prompt: "recommend music", timezone: "Asia/Seoul",
    scheduleExpressions: ["0 9,12 * * 1-5"], nodeId: "node-a", agentId: "roselin",
    modelPreset: null, container: { kind: "folder", id: "folder-a" }, folderId: "folder-a",
    enabled: true, archivedAt: null, lateRunWindowSeconds: 1800, nextRunAt: "2026-09-22T00:00:00.000Z",
    version: 1, createdIdempotencyKey: "create", createdBy: "owner", updatedBy: "owner",
    createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z",
  };
}
