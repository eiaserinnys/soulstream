import { describe, expect, it, vi } from "vitest";

import {
  createLiveOrchestratorProviderBundle,
  createOrchestratorRuntimeServices,
  liveFactoryImplementedProviderPaths,
  liveProviderDependencyCategories,
  liveProviderWiringInventory,
  parseOrchServerConfig,
  validateLiveProviderFactoryInventoryAlignment,
  LiveProviderFactoryError,
  type LiveProviderDependencies,
  type LiveProviderWiringInventoryEntry,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("live provider factory boundary", () => {
  it("requires explicit dependency categories for live wiring", () => {
    const dependencies = createLiveDependencies();

    expect(liveProviderDependencyCategories).toEqual([
      "authSessionIdentity",
      "dbCatalogRepository",
      "nodeHttpClient",
      "fileBlobR2Storage",
      "jwtToken",
      "claudeOAuth",
      "pushRepository",
      "configProvider",
    ]);
    expect(Object.keys(dependencies).sort()).toEqual(
      [...liveProviderDependencyCategories].sort(),
    );
  });

  it("keeps the factory provided paths aligned with implemented inventory entries", () => {
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: liveFactoryImplementedProviderPaths,
    });

    expect(result.missingImplementedProviderPaths).toEqual([]);
    expect(result.extraFactoryProviderPaths).toEqual([]);
    expect(result.blockedFactoryProviderPaths).toEqual([]);
    expect(result.implementedInventoryProviderPaths).toEqual(
      liveFactoryImplementedProviderPaths,
    );
    expect(result.unresolvedProviderPaths.length).toBeGreaterThan(0);
  });

  it("fails when inventory marks a path implemented but the factory omits it", () => {
    const [firstPath, ...remainingFactoryPaths] = liveFactoryImplementedProviderPaths;
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: remainingFactoryPaths,
    });

    expect(result.missingImplementedProviderPaths).toEqual([firstPath]);
  });

  it("fails when the factory provides a path absent from inventory", () => {
    const extraPath = { owner: "unknown.owner", path: "unknown.provider" };
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: [...liveFactoryImplementedProviderPaths, extraPath],
    });

    expect(result.extraFactoryProviderPaths).toEqual([extraPath]);
  });

  it("fails when the factory tries to provide a blocked path", () => {
    const blockedPath = { owner: "auth", path: "authRoutes.jwt" };
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: [...liveFactoryImplementedProviderPaths, blockedPath],
    });

    expect(result.blockedFactoryProviderPaths).toEqual([
      expect.objectContaining({
        owner: "auth",
        path: "authRoutes.jwt",
        status: "blocked",
      }),
    ]);
  });

  it("throws a typed error before returning a bundle while stub or blocked paths remain", () => {
    const dependencies = createLiveDependencies();
    const runtimeServices = createRuntimeServices(dependencies);

    expect(() =>
      createLiveOrchestratorProviderBundle({
        dependencies,
        runtimeServices,
      }),
    ).toThrowError(LiveProviderFactoryError);

    try {
      createLiveOrchestratorProviderBundle({
        dependencies,
        runtimeServices,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LiveProviderFactoryError);
      expect((error as LiveProviderFactoryError).failures[0]).toMatchObject({
        owner: "admin.users",
        path: "adminUsersRoutes.provider",
        status: "stub",
        source: expect.any(String),
        notes: expect.any(String),
      });
      expect((error as Error).message).toContain("admin.users");
    }
  });

  it("returns implemented runtime and config route providers when the inventory is fully implemented", async () => {
    const dependencies = createLiveDependencies();
    const runtimeServices = createRuntimeServices(dependencies);
    const implementedOnly = liveProviderWiringInventory.filter(
      (entry): entry is Extract<LiveProviderWiringInventoryEntry, { status: "implemented" }> =>
        entry.status === "implemented",
    );

    const bundle = createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
      inventory: implementedOnly,
    });

    expect(bundle.implementedProviderPaths).toEqual(liveFactoryImplementedProviderPaths);
    await expect(
      bundle.configProviders.publicStatusRoutes.configProvider.getConfig(),
    ).resolves.toEqual({
      nodeName: "orch-live",
      authEnabled: true,
      atomEnabled: true,
    });
    await expect(
      bundle.configProviders.atomRoutes.configProvider.getConfig(),
    ).resolves.toEqual({
      atomEnabled: true,
      atomServerUrl: "https://atom.example.test",
      atomApiKey: "atom-secret",
      atomRootNodeId: "root-node",
    });
    expect(bundle.runtime).toEqual({
      nodeSnapshotRoutes: runtimeServices.routeOptions.nodeSnapshotRoutes,
      nodeWsRoute: runtimeServices.routeOptions.nodeWsRoute,
      sessionActionCommandRoutes:
        runtimeServices.routeOptions.sessionActionCommandRoutes,
      sessionBackgroundScheduleRoutes:
        runtimeServices.routeOptions.sessionBackgroundScheduleRoutes,
      sessionCommandRoutes: runtimeServices.routeOptions.sessionCommandRoutes,
      sessionSnapshotRoutes: runtimeServices.routeOptions.sessionSnapshotRoutes,
    });
  });
});

function createRuntimeServices(dependencies: LiveProviderDependencies) {
  return createOrchestratorRuntimeServices({
    config,
    boardYjsHostHttpClient:
      dependencies.nodeHttpClient.boardYjsHostHttpClient,
    loadTaskSnapshot: dependencies.dbCatalogRepository.loadTaskSnapshot,
    sessionHistoryProvider:
      dependencies.dbCatalogRepository.sessionHistoryProvider,
    enableSessionActionCommandRoutes: true,
    enableSessionBackgroundScheduleRoutes: true,
    sseReplayOnlyForTests: true,
  });
}

function createLiveDependencies(): LiveProviderDependencies {
  const sessionHistoryProvider = {
    readViewport: vi.fn(async () => ({})),
    readMessages: vi.fn(async () => [[], null] as [unknown[], string | null]),
    readTimeline: vi.fn(async () => [[], null] as [unknown[], string | null]),
    readTimelineTrace: vi.fn(async () => null),
    readLastEventId: vi.fn(async () => 0),
    streamEventsRaw: vi.fn(() => emptyRawEvents()),
  };

  return {
    authSessionIdentity: {
      resolveCallerIdentity: vi.fn(async () => ({})),
      resolveSessionIdentity: vi.fn(async () => ({})),
    },
    dbCatalogRepository: {
      loadSessionSnapshot: vi.fn(async () => ({ sessions: [] })),
      loadTaskSnapshot: vi.fn(async () => ({ tasks: [] })),
      sessionHistoryProvider,
    },
    nodeHttpClient: {
      boardYjsHostHttpClient: vi.fn(async () => ({ statusCode: 200 })),
      requestNode: vi.fn(async () => ({ statusCode: 200 })),
    },
    fileBlobR2Storage: {
      readObject: vi.fn(async () => new Uint8Array()),
      writeObject: vi.fn(async () => undefined),
      deleteObject: vi.fn(async () => undefined),
    },
    jwtToken: {
      sign: vi.fn(async () => "token"),
      verify: vi.fn(async () => ({})),
    },
    claudeOAuth: {
      buildAuthorizeUrl: vi.fn(async () => "https://auth.example.test"),
      exchangeCode: vi.fn(async () => ({})),
      fetchProfile: vi.fn(async () => ({})),
    },
    pushRepository: {
      register: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
    configProvider: {
      getConfig: vi.fn(async () => ({
        node_name: "orch-live",
        google_client_id: "google-client",
        atom_enabled: true,
        atom_server_url: "https://atom.example.test",
        atom_api_key: "atom-secret",
        atom_root_node_id: "root-node",
      })),
      requireConfig: vi.fn(async (key: string) => {
        const config: Record<string, unknown> = {
          node_name: "orch-live",
          google_client_id: "google-client",
          atom_enabled: true,
          atom_server_url: "https://atom.example.test",
          atom_api_key: "atom-secret",
          atom_root_node_id: "root-node",
        };
        return config[key];
      }),
    },
  };
}

async function* emptyRawEvents() {
}
