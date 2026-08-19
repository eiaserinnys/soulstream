import { describe, expect, it } from "vitest";

import {
  buildRuntimeRouteRegistry,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  pythonRoutePathToFastifyPath,
  routeCoverageOwners,
  tsOnlyRouteKeys,
  validateRouteCoverageCompleteness,
  type CreateAppOptions,
  type RouteRegistry,
  type RouteRegistryEntry,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("route coverage completeness gate", () => {
  const fixtures = loadContractFixtures();
  const registry = buildRuntimeRouteRegistry(fixtures.routeInventory);
  const browserRouteKeys = [
    "GET /api/pages",
    "GET /api/pages/search",
    "POST /api/pages/daily",
    "GET /api/pages/{pageId}",
    "GET /api/pages/{pageId}/backlinks",
    "GET /api/pages/{pageId}/session-defaults",
    "POST /api/pages/block-transfers",
    "POST /api/pages/{pageId}/operations",
    "PATCH /api/pages/{pageId}/starred",
    "GET /api/planner/today",
    "GET /api/planner/starred-tasks",
    "GET /api/planner/daily-history",
    "GET /api/planner/projects/{pageId}",
    "GET /api/planner/projects/{pageId}/tasks",
    "GET /api/planner/projects/{pageId}/documents",
    "GET /api/planner/projects/{pageId}/legacy-sessions",
    "GET /api/planner/tasks/{pageId}/runs",
  ];
  const reviewRouteKey = "POST /api/sessions/{session_id}/review/acknowledge";
  const taskCreateRouteKey = "POST /api/tasks";

  it("covers every Python fixture route with opt-in TS registration and auth metadata", async () => {
    const registeredRouteKeys = await collectRegisteredRouteKeys(registry);
    const result = validateRouteCoverageCompleteness({
      registry,
      registeredRouteKeys,
      owners: routeCoverageOwners,
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
    expect(registeredRouteKeys).toHaveLength(registry.entries.length + tsOnlyRouteKeys.length);
    expect(registry.entries.map((entry) => entry.key)).toEqual(
      expect.arrayContaining([...browserRouteKeys, reviewRouteKey, taskCreateRouteKey]),
    );
    expect(registeredRouteKeys).toEqual(
      expect.arrayContaining([...browserRouteKeys, reviewRouteKey, taskCreateRouteKey]),
    );
  });

  it("reports missing registrations, auth mismatches, duplicate owners, and unknown entries", () => {
    const registeredRouteKeys = registry.entries
      .map((entry) => entry.key)
      .filter((key) => key !== "GET /api/health");
    const result = validateRouteCoverageCompleteness({
      registry,
      registeredRouteKeys,
      additionalExpectedRouteKeys: tsOnlyRouteKeys,
      owners: [
        ...routeCoverageOwners,
        {
          owner: "duplicate-health",
          authRequirements: {
            "GET /api/health": true,
            "GET /api/not-real": false,
          },
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.missingRegisteredRouteKeys).toContain("GET /api/health");
    expect(result.duplicateRouteOwners).toContainEqual({
      key: "GET /api/health",
      owners: ["duplicate-health", "public.status"],
    });
    expect(result.duplicateAuthRequirementOwners).toContainEqual({
      key: "GET /api/health",
      owners: ["duplicate-health", "public.status"],
    });
    expect(result.authRequiredMismatches).toContainEqual({
      key: "GET /api/health",
      owner: "duplicate-health",
      expected: false,
      actual: true,
    });
    expect(result.unknownRouteOwnerKeys).toContainEqual({
      key: "GET /api/not-real",
      owners: ["duplicate-health"],
    });
    expect(result.unknownAuthRequirementKeys).toContainEqual({
      key: "GET /api/not-real",
      owners: ["duplicate-health"],
    });
  });
});

async function collectRegisteredRouteKeys(registry: RouteRegistry): Promise<string[]> {
  const app = createAllOptInRouteApp();
  await app.ready();
  try {
    const fixtureRouteKeys = registry.entries
      .filter((entry) =>
        app.hasRoute({
          method: fastifyRegistrationMethod(entry),
          url: pythonRoutePathToFastifyPath(entry.path),
        }),
      )
      .map((entry) => entry.key);
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
  } finally {
    await app.close();
  }
}

function createAllOptInRouteApp() {
  const inert = {} as Record<string, unknown>;
  return createApp({
    config,
    agentProfileRoutes: inert,
    adminUsersRoutes: inert,
    atomRoutes: inert,
    authRoutes: inert,
    attachmentRoutes: inert,
    boardAssetRoutes: inert,
    boardItemRoutes: inert,
    boardYjsHostProxyRoutes: inert,
    cogitoRoutes: inert,
    executeProxyRoutes: inert,
    ephemeralLlmRoutes: inert,
    folderRoutes: inert,
    markdownDocumentRoutes: inert,
    nodeAgentProfileRoutes: {
      ...inert,
      modelPresetProvider: {
        listForNode: () => [],
      },
    },
    nodeClaudeAuthRoutes: inert,
    nodeSnapshotRoutes: inert,
    nodeWsRoute: { registry: inert },
    pageYjsRoutes: {
      authBearerToken: "test-token",
      resolveBrowserUser: async () => ({ email: "user@example.com" }),
      browserReads: {
        searchBrowserPages: async () => ({ items: [] }),
        getBrowserBacklinks: async () => ({ items: [], nextCursor: null }),
      },
      plannerReads: {
        getToday: async () => null,
        getProject: async () => null,
      },
      createService: () => ({
        handleConnection: () => undefined,
        assertWebsocketAuthConfigured: () => undefined,
        createPage: async () => inert,
        mutatePage: async () => inert,
        close: async () => undefined,
      } as never),
    },
    publicStatusRoutes: inert,
    pushRoutes: inert,
    taskRoutes: inert,
    sessionActionCommandRoutes: inert,
    sessionBackgroundScheduleRoutes: inert,
    sessionCatalogRoutes: inert,
    sessionCommandRoutes: inert,
    sessionHistoryRoutes: inert,
    sessionSnapshotRoutes: inert,
    sseReplayRoutes: inert,
    systemConfigRoutes: inert,
    userBackgroundRoutes: inert,
    userPreferencesRoutes: inert,
    usageSummaryRoutes: inert,
  } as unknown as CreateAppOptions);
}

function fastifyRegistrationMethod(entry: RouteRegistryEntry): string {
  return entry.method === "WEBSOCKET" ? "GET" : entry.method;
}
