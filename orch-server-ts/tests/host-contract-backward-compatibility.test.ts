import { readFileSync, readdirSync } from "node:fs";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPersistenceHostRoutes } from "../src/control_plane/persistence_host_routes.js";
import type { PersistenceHostRepositories } from "../src/control_plane/persistence_host_runtime.js";
import { registerScheduleHostRoute } from "../src/schedule/schedule_host_route.js";
import type { SoulstreamScheduleRepository } from "../src/schedule/schedule_repository.js";

const token = "service-token";
const now = new Date("2026-08-21T03:00:00.000Z");
const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("schedule host contract compatibility", () => {
  it.each([
    {
      label: "current duration contract",
      payload: { stale_after_ms: 750, limit: 5 },
      expectedDelayMs: 750,
    },
    {
      label: "legacy absolute timestamp contract",
      payload: { stale_before: "2026-08-21T02:59:58.000Z", limit: 5 },
      expectedDelayMs: 2_000,
    },
    {
      label: "legacy future timestamp clamped to zero",
      payload: { stale_before: "2026-08-21T03:00:02.000Z", limit: 5 },
      expectedDelayMs: 0,
    },
  ])("accepts the $label for restore", async ({ payload, expectedDelayMs }) => {
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    const restoreOrphanSchedulesForLiveNodes = vi.fn(async () => []);
    const app = scheduleApp({ restoreOrphanSchedulesForLiveNodes });

    const response = await app.inject({
      method: "POST",
      url: "/api/schedules/host/restore_orphan_schedules_for_live_nodes",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(restoreOrphanSchedulesForLiveNodes).toHaveBeenCalledWith({
      staleAfterMs: expectedDelayMs,
      limit: 5,
    });
  });

  it("rejects restore when neither stale contract is present", async () => {
    const restoreOrphanSchedulesForLiveNodes = vi.fn(async () => []);
    const app = scheduleApp({ restoreOrphanSchedulesForLiveNodes });

    const response = await app.inject({
      method: "POST",
      url: "/api/schedules/host/restore_orphan_schedules_for_live_nodes",
      headers: { authorization: `Bearer ${token}` },
      payload: { limit: 5 },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().detail.error.code).toBe("INVALID_SCHEDULE_REQUEST");
    expect(restoreOrphanSchedulesForLiveNodes).not.toHaveBeenCalled();
  });

  it("normalizes the legacy stale timestamp for orphan marking too", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    const markOrphanDueSchedules = vi.fn(async () => []);
    const app = scheduleApp({ markOrphanDueSchedules });

    const response = await app.inject({
      method: "POST",
      url: "/api/schedules/host/mark_orphan_due_schedules",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        now: now.toISOString(),
        stale_before: "2026-08-21T02:59:58.000Z",
        limit: 5,
        error: "node heartbeat stale",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(markOrphanDueSchedules).toHaveBeenCalledWith({
      now,
      staleAfterMs: 2_000,
      limit: 5,
      error: "node heartbeat stale",
    });
  });
});

describe("persistence host retry contract compatibility", () => {
  it.each([
    {
      operation: "defer_pending",
      args: ["delivery-1", "retry", "2026-08-21T03:00:02.000Z"],
      repository: (callable: ReturnType<typeof vi.fn>) => ({ deliveries: { deferPending: callable } }),
    },
    {
      operation: "retry_leased_delivery",
      args: ["delivery-1", "worker-1", "retry", "2026-08-21T03:00:02.000Z"],
      repository: (callable: ReturnType<typeof vi.fn>) => ({ deliveries: { retryLeasedDelivery: callable } }),
    },
    {
      operation: "defer_queued_transcript_check",
      args: ["delivery-1", "worker-1", "retry", "2026-08-21T03:00:02.000Z"],
      repository: (callable: ReturnType<typeof vi.fn>) => ({
        deliveries: { recovery: { deferQueuedTranscriptCheck: callable } },
      }),
    },
  ])("converts the legacy absolute instant for $operation", async ({ operation, args, repository }) => {
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    const callable = vi.fn(async () => null);
    const app = persistenceApp(repository(callable));

    const response = await app.inject({
      method: "POST",
      url: `/api/session-deliveries/host/${operation}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { args },
    });

    expect(response.statusCode).toBe(200);
    expect(callable.mock.calls[0]?.at(-1)).toBe(2_000);
  });

  it("preserves the current numeric retry duration", async () => {
    const retryLeasedDelivery = vi.fn(async () => null);
    const app = persistenceApp({ deliveries: { retryLeasedDelivery } });

    const response = await app.inject({
      method: "POST",
      url: "/api/session-deliveries/host/retry_leased_delivery",
      headers: { authorization: `Bearer ${token}` },
      payload: { args: ["delivery-1", "worker-1", "retry", 250] },
    });

    expect(response.statusCode).toBe(200);
    expect(retryLeasedDelivery).toHaveBeenCalledWith("delivery-1", "worker-1", "retry", 250);
  });
});

describe("PostgreSQL millisecond interval contracts", () => {
  it("casts every interpolated duration in the orch source tree", () => {
    const uncastFiles = typescriptFiles(new URL("../src/", import.meta.url))
      .filter((file) => /\}(?!::double precision)\s*\*\s*INTERVAL '1 millisecond'/
        .test(readFileSync(file, "utf8")))
      .map((file) => file.pathname);

    expect(uncastFiles).toEqual([]);
  });
});

function typescriptFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return typescriptFiles(new URL(`${entry.name}/`, directory));
    return entry.name.endsWith(".ts") ? [new URL(entry.name, directory)] : [];
  });
}

function scheduleApp(repository: Partial<SoulstreamScheduleRepository>) {
  const app = Fastify();
  apps.push(app);
  registerScheduleHostRoute(app, {
    authBearerToken: token,
    repositoryProvider: async () => repository as SoulstreamScheduleRepository,
  });
  return app;
}

function persistenceApp(repository: object) {
  const app = Fastify();
  apps.push(app);
  registerPersistenceHostRoutes(app, {
    authBearerToken: token,
    repositoryProvider: async () => repository as PersistenceHostRepositories,
  });
  return app;
}
