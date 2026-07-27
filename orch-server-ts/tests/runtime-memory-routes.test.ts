import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  parseOrchServerConfig,
  runtimeMemoryRouteAuthRequirements,
  type RuntimeMemoryRouteOptions,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function createHarness(options: {
  currentEmail?: string | null | undefined;
  isAdmin?: boolean;
} = {}) {
  const collect = vi.fn(() => ({
    measuredAt: "2026-07-27T08:00:00.000Z",
    process: {
      rss: 900,
      heapTotal: 700,
      heapUsed: 500,
      external: 100,
      arrayBuffers: 50,
    },
    v8: {
      heapSizeLimit: 2_000,
      totalHeapSize: 700,
      totalAvailableSize: 1_300,
      usedHeapSize: 500,
      mallocedMemory: 25,
      externalMemory: 100,
    },
    components: {
      session_replay_ring: { entries: 7, approxBytes: 12_345 },
    },
  }));
  const routeOptions: RuntimeMemoryRouteOptions = {
    accessProvider: {
      currentEmail: () =>
        Object.hasOwn(options, "currentEmail")
          ? options.currentEmail
          : "admin@example.com",
      isAdminEmail: () => options.isAdmin ?? true,
    },
    stats: { collect },
  };
  const app = createApp({ config, runtimeMemoryRoutes: routeOptions });
  return { app, collect };
}

describe("runtime memory admin route", () => {
  it("returns the full on-demand memory snapshot to an admin", async () => {
    expect(runtimeMemoryRouteAuthRequirements).toEqual({
      "GET /api/admin/runtime-memory": true,
    });
    const { app, collect } = createHarness();

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/runtime-memory",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      process: { rss: 900, heapUsed: 500 },
      v8: { heapSizeLimit: 2_000 },
      components: {
        session_replay_ring: { entries: 7, approxBytes: 12_345 },
      },
    });
    expect(collect).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects unauthenticated and non-admin callers before collection", async () => {
    const unauthenticated = createHarness({ currentEmail: undefined });
    const unauthenticatedResponse = await unauthenticated.app.inject({
      method: "GET",
      url: "/api/admin/runtime-memory",
    });
    expect(unauthenticatedResponse.statusCode).toBe(401);
    expect(unauthenticated.collect).not.toHaveBeenCalled();
    await unauthenticated.app.close();

    const forbidden = createHarness({ isAdmin: false });
    const forbiddenResponse = await forbidden.app.inject({
      method: "GET",
      url: "/api/admin/runtime-memory",
    });
    expect(forbiddenResponse.statusCode).toBe(403);
    expect(forbidden.collect).not.toHaveBeenCalled();
    await forbidden.app.close();
  });
});
