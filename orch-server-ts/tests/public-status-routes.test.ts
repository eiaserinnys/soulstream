import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  publicStatusRouteAuthRequirements,
  type PublicStatusFolderAccess,
  type PublicStatusRouteOptions,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("public/status/folder-count route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps Python public/status/folder-count routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const url of [
      "/api/health",
      "/api/config",
      "/api/status",
      "/api/sessions/folder-counts",
    ]) {
      expect(await app.inject({ method: "GET", url })).toMatchObject({ statusCode: 404 });
    }

    await app.close();
  });

  it("registers route inventory order 1/2/3/5 auth contracts", () => {
    expect(publicStatusRouteAuthRequirements).toEqual({
      "GET /api/health": false,
      "GET /api/config": false,
      "GET /api/status": true,
      "GET /api/sessions/folder-counts": true,
    });

    expect(
      fixtures.routeInventory.routes
        .filter((route) => [1, 2, 3, 5].includes(route.order))
        .map((route) => [route.order, route.methods[0], route.path, route.authRequired]),
    ).toEqual([
      [1, "GET", "/api/health", false],
      [2, "GET", "/api/config", false],
      [3, "GET", "/api/status", true],
      [5, "GET", "/api/sessions/folder-counts", true],
    ]);
  });

  it("preserves Python health/config/status response shapes with injected config", async () => {
    const { app, options } = createHarness();

    const health = await app.inject({ method: "GET", url: "/api/health" });
    const appConfig = await app.inject({ method: "GET", url: "/api/config" });
    const status = await app.inject({ method: "GET", url: "/api/status" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({
      status: "ok",
      version: "0.1.0",
      uptime_seconds: 42,
    });
    expect(appConfig.json()).toEqual({
      mode: "orchestrator",
      nodeId: "orch-test",
      auth: { enabled: true },
      features: {
        configModal: true,
        searchModal: true,
        nodePanel: true,
        nodeGuard: false,
      },
    });
    expect(status.json()).toEqual({
      is_draining: false,
      healthy: true,
      atom_enabled: true,
    });
    expect(options.configProvider.getConfig).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("returns Python-compatible folder counts and preserves null folder keys", async () => {
    const { app, options } = createHarness({
      folderCounts: new Map<string | null, number>([
        ["folder-a", 3],
        ["folder-b", 2],
        [null, 1],
      ]),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/folder-counts",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      counts: {
        "folder-a": 3,
        "folder-b": 2,
        null: 1,
      },
    });
    expect(options.folderCountsProvider.listFolders).not.toHaveBeenCalled();

    await app.close();
  });

  it("filters restricted folder counts through allowed folder descendants", async () => {
    const { app } = createHarness({
      access: { restricted: true, allowedFolderIds: ["folder-a"] },
      folders: [
        { id: "folder-a" },
        { id: "folder-a-child", parentFolderId: "folder-a" },
        { id: "folder-b" },
      ],
      folderCounts: new Map<string | null, number>([
        ["folder-a", 3],
        ["folder-a-child", 4],
        ["folder-b", 2],
        [null, 1],
      ]),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/folder-counts",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      counts: {
        "folder-a": 3,
        "folder-a-child": 4,
      },
    });

    await app.close();
  });
});

function createHarness(
  overrides: {
    access?: PublicStatusFolderAccess;
    folderCounts?: ReadonlyMap<string | null, number> | Record<string, number>;
    folders?: Array<{ id: string; parentFolderId?: string | null }>;
  } = {},
) {
  const options: PublicStatusRouteOptions = {
    startTimeSeconds: 1_000,
    nowSeconds: () => 1_042,
    configProvider: {
      getConfig: vi.fn(async () => ({
        nodeName: "orch-test",
        authEnabled: true,
        atomEnabled: true,
      })),
    },
    folderCountsProvider: {
      getFolderCounts: vi.fn(async () => overrides.folderCounts ?? {}),
      listFolders: vi.fn(async () => overrides.folders ?? []),
      resolveAccess: vi.fn(async () => overrides.access ?? { restricted: false }),
    },
  };
  const app = createApp({
    config,
    publicStatusRoutes: options,
  });
  return { app, options };
}
