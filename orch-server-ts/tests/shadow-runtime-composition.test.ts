import { describe, expect, it, vi } from "vitest";

import {
  buildRouteRegistry,
  createShadowOrchestratorApp,
  loadContractFixtures,
  parseOrchServerConfig,
  pythonRoutePathToFastifyPath,
  routeCoverageOwners,
  shadowRouteCompositionOwners,
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
  const registry = buildRouteRegistry(fixtures.routeInventory);

  it("fails during composition when route providers are missing", () => {
    expect(() =>
      createShadowOrchestratorApp({
        config,
        providers: {
          runtime: {
            loadTaskSnapshot: async () => ({ tasks: [] }),
          },
        } as unknown as ShadowOrchestratorProviderBundle,
      }),
    ).toThrowError(
      /Missing shadow orchestrator route providers: .*admin\.users: adminUsersRoutes\.provider.*auth: authRoutes\.configProvider.*board\.yjs-host: runtime\.boardYjsHostHttpClient.*session\.history: runtime\.sessionHistoryProvider/s,
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
      expect(registeredRouteKeys).toHaveLength(registry.entries.length);
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
  return registry.entries
    .filter((entry) =>
      app.hasRoute({
        method: fastifyRegistrationMethod(entry),
        url: pythonRoutePathToFastifyPath(entry.path),
      }),
    )
    .map((entry) => entry.key);
}

function fastifyRegistrationMethod(entry: RouteRegistryEntry): string {
  return entry.method === "WEBSOCKET" ? "GET" : entry.method;
}

function createInertShadowProviders(): ShadowOrchestratorProviderBundle {
  return {
    runtime: {
      boardYjsHostHttpClient: vi.fn(),
      loadTaskSnapshot: async () => ({ tasks: [] }),
      sessionHistoryProvider: createInertProvider(),
      sseReplayOnlyForTests: true,
    },
    adminUsersRoutes: createInertProvider(),
    atomRoutes: createInertProvider(),
    authRoutes: createInertProvider(),
    attachmentRoutes: createInertProvider(),
    boardAssetRoutes: createInertProvider(),
    boardItemRoutes: createInertProvider(),
    cogitoRoutes: createInertProvider(),
    executeProxyRoutes: createInertProvider(),
    folderRoutes: createInertProvider(),
    markdownDocumentRoutes: createInertProvider(),
    nodeAgentProfileRoutes: createInertProvider(),
    nodeClaudeAuthRoutes: createInertProvider(),
    publicStatusRoutes: createInertProvider(),
    pushRoutes: createInertProvider(),
    runbookRoutes: createInertProvider(),
    sessionCatalogRoutes: createInertProvider(),
    systemConfigRoutes: createInertProvider(),
    taskMutationRoutes: createInertProvider(),
    taskReadRoutes: createInertProvider(),
    userBackgroundRoutes: createInertProvider(),
    userPreferencesRoutes: createInertProvider(),
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
