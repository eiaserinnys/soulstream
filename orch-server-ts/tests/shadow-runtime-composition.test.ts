import { describe, expect, it, vi } from "vitest";

import {
  buildRuntimeRouteRegistry,
  createShadowOrchestratorApp,
  loadContractFixtures,
  parseOrchServerConfig,
  pythonRoutePathToFastifyPath,
  routeCoverageOwners,
  shadowRouteCompositionOwners,
  tsOnlyRouteKeys,
  validateRouteCoverageCompleteness,
  type RouteRegistry,
  type RouteRegistryEntry,
  type ShadowOrchestratorProviderBundle,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("shadow runtime composition", () => {
  const fixtures = loadContractFixtures();
  const registry = buildRuntimeRouteRegistry(fixtures.routeInventory);

  it("fails during composition when route providers are missing", () => {
    expect(() =>
      createShadowOrchestratorApp({
        config,
        providers: {
          runtime: {
          },
        } as unknown as ShadowOrchestratorProviderBundle,
      }),
    ).toThrowError(
      /Missing shadow orchestrator route providers: .*admin\.users: adminUsersRoutes\.provider.*auth: authRoutes\.configProvider.*session\.history: runtime\.sessionHistoryProvider/s,
    );
  });

  it("treats null route providers as missing during composition", () => {
    const providers = createInertShadowProviders();
    providers.adminUsersRoutes = { provider: null } as never;

    expect(() =>
      createShadowOrchestratorApp({
        config,
        providers,
      }),
    ).toThrowError(
      /Missing shadow orchestrator route providers: admin\.users: adminUsersRoutes\.provider/,
    );
  });

  it("keeps the shadow owner manifest aligned with the route coverage gate", () => {
    expect(shadowRouteCompositionOwners).toEqual(
      routeCoverageOwners.map((owner) => owner.owner),
    );
  });

  it("registers the full route inventory through the shadow composition", async () => {
    const shadow = createShadowOrchestratorApp({
      config,
      providers: createInertShadowProviders(),
    });
    await shadow.app.ready();

    try {
      const registeredRouteKeys = collectRegisteredFixtureRouteKeys(
        shadow.app,
        registry,
      );
      const result = validateRouteCoverageCompleteness({
        registry,
        registeredRouteKeys,
        owners: routeCoverageOwners,
        // The fixture inventory describes the retired Python server, so a
        // TS-only route is expected only when it is declared here — same as
        // route-coverage-completeness does. Without it `/ws/node/control`,
        // which node.ws has owned since the control lane landed, reads as a
        // route owned by nobody's inventory and fails the whole matrix.
        additionalExpectedRouteKeys: tsOnlyRouteKeys,
      });

      expect(result).toMatchObject({
        valid: true,
        missingRegisteredRouteKeys: [],
        missingRouteOwnerKeys: [],
        missingAuthRequirementKeys: [],
        authRequiredMismatches: [],
        duplicateRouteOwners: [],
        duplicateAuthRequirementOwners: [],
        unknownRouteOwnerKeys: [],
        unknownAuthRequirementKeys: [],
      });
      expect(registeredRouteKeys).toHaveLength(
        registry.entries.length + tsOnlyRouteKeys.length,
      );
    } finally {
      await shadow.app.close();
    }
  });

  it("injects runtime singleton services into dependent route options", async () => {
    const shadow = createShadowOrchestratorApp({
      config,
      providers: createInertShadowProviders(),
    });

    expect(shadow.shadowRouteOptions.nodeClaudeAuthRoutes.registry).toBe(
      shadow.registry,
    );
    expect(shadow.shadowRouteOptions.nodeClaudeAuthRoutes.bridge).toBe(
      shadow.sessionBridge,
    );
    expect(shadow.shadowRouteOptions.boardItemRoutes.hostProxy).toBe(
      shadow.routeOptions.boardYjsHostProxyRoutes,
    );
    expect(shadow.shadowRouteOptions.markdownDocumentRoutes.hostProxy).toBe(
      shadow.routeOptions.boardYjsHostProxyRoutes,
    );

    await shadow.app.close();
  });
});

function collectRegisteredFixtureRouteKeys(
  app: {
    hasRoute: (options: { method: string; url: string }) => boolean;
  },
  registry: RouteRegistry,
): string[] {
  const fixtureRouteKeys = registry.entries
    .filter((entry) =>
      app.hasRoute({
        method: fastifyRegistrationMethod(entry),
        url: pythonRoutePathToFastifyPath(entry.path),
      }),
    )
    .map((entry) => entry.key);
  // TS-only routes are absent from the Python fixture inventory, so walking
  // `registry.entries` alone can never see one. Probe them the same way
  // route-coverage-completeness does, or the shadow composition could quietly
  // stop registering `/ws/node/control` and this test would still pass.
  const registeredTsOnlyRouteKeys = tsOnlyRouteKeys.filter((key) => {
    const separatorIndex = key.indexOf(" ");
    if (separatorIndex <= 0) throw new Error(`invalid TS-only route key: ${key}`);
    const method = key.slice(0, separatorIndex);
    const path = key.slice(separatorIndex + 1);
    return app.hasRoute({
      method: method === "WEBSOCKET" ? "GET" : method,
      url: pythonRoutePathToFastifyPath(path),
    });
  });
  return [...fixtureRouteKeys, ...registeredTsOnlyRouteKeys];
}

function fastifyRegistrationMethod(entry: RouteRegistryEntry): string {
  return entry.method === "WEBSOCKET" ? "GET" : entry.method;
}

function createInertShadowProviders(): ShadowOrchestratorProviderBundle {
  return {
    runtime: {
      loadSessionSnapshot: async () => ({ sessions: [] }),
      sessionHistoryProvider: createInertProvider(),
      sseReplayOnlyForTests: true,
      pageYjsRoutes: createInertPageYjsRoutes(),
    },
    adminUsersRoutes: createInertProvider(),
    atomRoutes: createInertProvider(),
    authRoutes: createInertProvider(),
    attachmentRoutes: createInertProvider(),
    boardAssetRoutes: createInertProvider(),
    boardItemRoutes: createInertProvider(),
    cogitoRoutes: createInertProvider(),
    executeProxyRoutes: createInertProvider(),
    ephemeralLlmRoutes: createInertProvider(),
    folderRoutes: createInertProvider(),
    markdownDocumentRoutes: createInertProvider(),
    agentProfileRoutes: createInertProvider(),
    nodeAgentProfileRoutes: createInertProvider(),
    nodeClaudeAuthRoutes: createInertProvider(),
    publicStatusRoutes: createInertProvider(),
    pushRoutes: createInertProvider(),
    taskRoutes: createInertProvider(),
    sessionCatalogRoutes: createInertProvider(),
    systemConfigRoutes: createInertProvider(),
    userBackgroundRoutes: createInertProvider(),
    userPreferencesRoutes: createInertProvider(),
    usageSummaryRoutes: createInertProvider(),
  };
}

function createInertPageYjsRoutes() {
  return {
    authBearerToken: "test-token",
    resolveBrowserUser: vi.fn(async () => null),
    browserReads: {
      searchBrowserPages: vi.fn(async () => ({ items: [] })),
      getBrowserBacklinks: vi.fn(async () => ({ items: [], nextCursor: null })),
      resolvePageSessionDefaults: vi.fn(async () => null),
    },
    plannerReads: {
      getStarredTasks: vi.fn(async () => ({ items: [], next_cursor: null })),
      getDailyHistory: vi.fn(async () => ({ dates: [] })),
      getToday: vi.fn(async () => null),
      getProject: vi.fn(async () => null),
      getProjectTasks: vi.fn(async () => null),
      getProjectDocuments: vi.fn(async () => null),
      getProjectLegacySessions: vi.fn(async () => ({ items: [], next_cursor: null })),
      getTaskRuns: vi.fn(async () => null),
    },
    createService: () => ({
      handleConnection: vi.fn(),
      assertWebsocketAuthConfigured: vi.fn(),
      createPage: vi.fn(),
      mutatePage: vi.fn(),
      close: vi.fn(async () => undefined),
    } as never),
  };
}

function createInertProvider<T extends object>(): T {
  return new Proxy(
    {},
    {
      get: () => vi.fn(async () => undefined),
    },
  ) as T;
}
