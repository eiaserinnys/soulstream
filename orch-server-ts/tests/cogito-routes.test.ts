import { describe, expect, it, vi } from "vitest";

import {
  CogitoBriefTimeoutError,
  CogitoBriefUnavailableError,
  createApp,
  cogitoRouteAuthRequirements,
  filterCogitoSearchResultsByAccess,
  loadContractFixtures,
  parseOrchServerConfig,
  type CogitoBriefCollector,
  type CogitoNode,
  type CogitoNodeProvider,
  type CogitoSearchAccessProvider,
  type CogitoSearchHttpClient,
  type CogitoSearchResult,
  type CogitoSearchSessionRecord,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const nodeA: CogitoNode = {
  id: "node-a",
  host: "127.0.0.1",
  port: 4105,
  capabilities: { reflect_brief: true },
};
const nodeB: CogitoNode = {
  id: "node-b",
  host: "127.0.0.2",
  port: 4106,
  capabilities: { reflect_brief: true },
};

function createHarness(options: {
  nodes?: CogitoNode[];
  httpClient?: CogitoSearchHttpClient;
  accessProvider?: CogitoSearchAccessProvider;
  briefCollector?: CogitoBriefCollector;
} = {}) {
  const provider: CogitoNodeProvider = {
    listConnectedNodes: () => options.nodes ?? [nodeA, nodeB],
  };
  const httpClient = options.httpClient ?? {
    get: vi.fn(async () => ({ statusCode: 200, body: { results: [] } })),
  };
  const briefCollector = options.briefCollector ?? {
    reflectBrief: vi.fn(async () => ({ brief: { ok: true } })),
  };
  const app = createApp({
    config,
    cogitoRoutes: {
      provider,
      httpClient,
      accessProvider: options.accessProvider,
      briefCollector,
      nowIso: () => "2026-07-09T04:00:00.000Z",
    },
  });
  return { app, httpClient, briefCollector };
}

describe("cogito route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps Cogito routes disabled on the default app", async () => {
    const app = createApp({ config });

    expect(await app.inject({ method: "GET", url: "/cogito/search?q=hello" }))
      .toMatchObject({ statusCode: 404 });
    expect(await app.inject({ method: "GET", url: "/cogito/briefs" }))
      .toMatchObject({ statusCode: 404 });

    await app.close();
  });

  it("registers only Python Cogito auth contract rows for route inventory order 94-95", () => {
    expect(cogitoRouteAuthRequirements).toEqual({
      "GET /cogito/search": true,
      "GET /cogito/briefs": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) => route.order >= 94 && route.order <= 96)
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [94, "GET", "/cogito/search", true],
      [95, "GET", "/cogito/briefs", true],
      [96, "GET", "/api/atom/nodes", true],
    ]);
    expect(Object.keys(cogitoRouteAuthRequirements)).not.toContain("GET /api/atom/nodes");
  });

  it("validates search query contract", async () => {
    const { app, httpClient } = createHarness();

    expect(await app.inject({ method: "GET", url: "/cogito/search" }))
      .toMatchObject({ statusCode: 422 });
    expect(await app.inject({ method: "GET", url: "/cogito/search?q=x&top_k=0" }))
      .toMatchObject({ statusCode: 422 });
    expect(await app.inject({ method: "GET", url: "/cogito/search?q=x&top_k=101" }))
      .toMatchObject({ statusCode: 422 });
    expect(httpClient.get).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns an empty search result without fan-out when no nodes are connected", async () => {
    const { app, httpClient } = createHarness({ nodes: [] });

    const response = await app.inject({ method: "GET", url: "/cogito/search?q=hello" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ results: [] });
    expect(httpClient.get).not.toHaveBeenCalled();

    await app.close();
  });

  it("fans out search, forwards auth and cookie, skips failed nodes, sorts and truncates", async () => {
    const httpClient: CogitoSearchHttpClient = {
      get: vi.fn(async (request) => {
        if (request.url.includes("4105")) {
          return {
            statusCode: 200,
            body: {
              results: [
                { session_id: "low", score: 0.1, preview: "low" },
                { session_id: "high", score: 0.9, preview: "high", node_name: "custom" },
                "ignored",
              ],
            },
          };
        }
        if (request.url.includes("4106")) {
          return { statusCode: 503, body: { detail: "down" } };
        }
        throw new Error(`unexpected request: ${request.url}`);
      }),
    };
    const { app } = createHarness({ httpClient });

    const response = await app.inject({
      method: "GET",
      url: "/cogito/search?q=hello&top_k=1&event_types=message,tool&search_session_id=true",
      headers: {
        authorization: "Bearer secret",
        cookie: "session=abc",
        "x-ignored": "nope",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [
        {
          session_id: "high",
          score: 0.9,
          preview: "high",
          node_id: "node-a",
          node_name: "custom",
        },
      ],
    });
    expect(httpClient.get).toHaveBeenCalledTimes(2);
    expect(httpClient.get).toHaveBeenNthCalledWith(1, {
      url: "http://127.0.0.1:4105/cogito/search",
      params: {
        q: "hello",
        top_k: 1,
        search_session_id: true,
        event_types: "message,tool",
      },
      headers: {
        authorization: "Bearer secret",
        cookie: "session=abc",
      },
    });

    await app.close();
  });

  it("applies the restricted search access filter only for restricted access", async () => {
    const httpClient: CogitoSearchHttpClient = {
      get: vi.fn(async () => ({
        statusCode: 200,
        body: {
          results: [
            { session_id: "allowed", score: 0.1 },
            { session_id: "denied", score: 1.0 },
            { score: 2.0 },
          ],
        },
      })),
    };
    const unrestrictedFilter = vi.fn();
    const unrestricted = createHarness({
      nodes: [nodeA],
      httpClient,
      accessProvider: {
        resolveAccess: () => ({ restricted: false }),
        filterResults: unrestrictedFilter,
      },
    });
    const unrestrictedResponse = await unrestricted.app.inject({
      method: "GET",
      url: "/cogito/search?q=hello&top_k=3",
    });

    expect(unrestrictedResponse.statusCode).toBe(200);
    expect(unrestrictedResponse.json().results.map((item: CogitoSearchResult) => item.session_id))
      .toEqual([undefined, "denied", "allowed"]);
    expect(unrestrictedFilter).not.toHaveBeenCalled();
    await unrestricted.app.close();

    const restrictedFilter = vi.fn(async (input: { results: CogitoSearchResult[] }) =>
      input.results.filter((item) => item.session_id === "allowed"),
    );
    const restricted = createHarness({
      nodes: [nodeA],
      httpClient,
      accessProvider: {
        resolveAccess: () => ({ restricted: true }),
        filterResults: restrictedFilter,
      },
    });
    const restrictedResponse = await restricted.app.inject({
      method: "GET",
      url: "/cogito/search?q=hello&top_k=3",
    });

    expect(restrictedResponse.statusCode).toBe(200);
    expect(restrictedResponse.json().results).toEqual([
      {
        session_id: "allowed",
        score: 0.1,
        node_id: "node-a",
        node_name: "node-a",
      },
    ]);
    expect(restrictedFilter).toHaveBeenCalledOnce();
    await restricted.app.close();
  });

  it("filters restricted search results by session id and allowed folder", async () => {
    const sessions = new Map<string, CogitoSearchSessionRecord>([
      ["allowed-snake", { folder_id: "folder-a" }],
      ["allowed-camel", { folderId: "folder-b" }],
      ["denied", { folder_id: "folder-c" }],
    ]);

    await expect(filterCogitoSearchResultsByAccess([
      { session_id: "allowed-snake", score: 1 },
      { sessionId: "allowed-camel", score: 2 },
      { session_id: "denied", score: 3 },
      { session_id: "missing-row", score: 4 },
      { score: 5 },
    ], {
      getSession: (sessionId) => sessions.get(sessionId),
      isFolderAllowed: (folderId) => folderId === "folder-a" || folderId === "folder-b",
    })).resolves.toEqual([
      { session_id: "allowed-snake", score: 1 },
      { sessionId: "allowed-camel", score: 2 },
    ]);
  });

  it("returns an empty brief aggregate when no connected node supports reflect_brief", async () => {
    const { app, briefCollector } = createHarness({
      nodes: [
        { id: "node-c", host: "127.0.0.3", port: 4107, capabilities: {} },
      ],
    });

    const response = await app.inject({ method: "GET", url: "/cogito/briefs" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schema_version: "soulstream.reflect.aggregate.v1",
      kind: "orchestrator_node_brief_aggregate",
      status: "empty",
      generated_at: "2026-07-09T04:00:00.000Z",
      checked_at: "2026-07-09T04:00:00.000Z",
      source: {
        type: "orchestrator",
        transport: "node_ws_command",
        command: "reflect_brief",
      },
      timeout_seconds: 5,
      node_count: 0,
      nodes: [],
    });
    expect(briefCollector.reflectBrief).not.toHaveBeenCalled();

    await app.close();
  });

  it("collects ok brief entries and reports ok aggregate status", async () => {
    const briefCollector: CogitoBriefCollector = {
      reflectBrief: vi.fn(async (_node, timeoutSeconds) => ({
        checked_at: `timeout-${timeoutSeconds}`,
        brief: { package: "@soulstream/soul-server-ts" },
      })),
    };
    const { app } = createHarness({ nodes: [nodeA, nodeB], briefCollector });

    const response = await app.inject({ method: "GET", url: "/cogito/briefs?timeout=3.5" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      timeout_seconds: 3.5,
      node_count: 2,
      nodes: [
        {
          node_id: "node-a",
          status: "ok",
          checked_at: "timeout-3.5",
          source: { type: "node", transport: "websocket", command: "reflect_brief" },
          data: { package: "@soulstream/soul-server-ts" },
          errors: [],
        },
        {
          node_id: "node-b",
          status: "ok",
          checked_at: "timeout-3.5",
        },
      ],
    });
    expect(briefCollector.reflectBrief).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("keeps brief collection partial-failure tolerant with typed node entries", async () => {
    const nodes: CogitoNode[] = [
      nodeA,
      nodeB,
      { id: "node-timeout", host: "127.0.0.3", port: 4107, capabilities: { reflect_brief: true } },
      { id: "node-unavailable", host: "127.0.0.4", port: 4108, capabilities: { reflect_brief: true } },
      { id: "node-invalid", host: "127.0.0.5", port: 4109, capabilities: { reflect_brief: true } },
      { id: "node-ignored", host: "127.0.0.6", port: 4110, capabilities: {} },
    ];
    const briefCollector: CogitoBriefCollector = {
      reflectBrief: vi.fn(async (node) => {
        if (node.id === "node-a") return { brief: { ok: true } };
        if (node.id === "node-b") throw new Error("boom");
        if (node.id === "node-timeout") throw new CogitoBriefTimeoutError("slow");
        if (node.id === "node-unavailable") throw new CogitoBriefUnavailableError("closed");
        return { brief: null };
      }),
    };
    const { app } = createHarness({ nodes, briefCollector });

    const response = await app.inject({ method: "GET", url: "/cogito/briefs" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "partial",
      node_count: 5,
      nodes: [
        { node_id: "node-a", status: "ok", data: { ok: true }, errors: [] },
        {
          node_id: "node-b",
          status: "error",
          data: null,
          errors: [{ code: "node_error", message: "boom" }],
        },
        {
          node_id: "node-timeout",
          status: "timeout",
          data: null,
          errors: [{ code: "node_timeout", message: "slow" }],
        },
        {
          node_id: "node-unavailable",
          status: "unavailable",
          data: null,
          errors: [{ code: "node_unavailable", message: "closed" }],
        },
        {
          node_id: "node-invalid",
          status: "error",
          data: null,
          errors: [{
            code: "invalid_reflect_brief_response",
            message: "reflect_brief response missing object field 'brief'",
          }],
        },
      ],
    });

    await app.close();
  });

  it("reports error aggregate status when all brief entries fail and validates timeout", async () => {
    const { app } = createHarness({
      nodes: [nodeA],
      briefCollector: {
        reflectBrief: vi.fn(async () => {
          throw new Error("all failed");
        }),
      },
    });

    expect(await app.inject({ method: "GET", url: "/cogito/briefs?timeout=0" }))
      .toMatchObject({ statusCode: 422 });
    expect(await app.inject({ method: "GET", url: "/cogito/briefs?timeout=31" }))
      .toMatchObject({ statusCode: 422 });

    const response = await app.inject({ method: "GET", url: "/cogito/briefs" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "error",
      node_count: 1,
      nodes: [
        {
          node_id: "node-a",
          status: "error",
          errors: [{ code: "node_error", message: "all failed" }],
        },
      ],
    });

    await app.close();
  });
});
