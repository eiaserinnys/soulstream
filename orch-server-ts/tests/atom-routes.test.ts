import { describe, expect, it, vi } from "vitest";

import {
  ATOM_API_UNAVAILABLE_DETAIL,
  ATOM_INTEGRATION_DISABLED_DETAIL,
  ATOM_NODE_NOT_FOUND_DETAIL,
  atomRouteAuthRequirements,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  type AtomHttpClient,
  type AtomRouteConfig,
  type AtomRouteConfigProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function atomConfig(overrides: Partial<AtomRouteConfig> = {}): AtomRouteConfig {
  return {
    atomEnabled: true,
    atomServerUrl: "https://atom.example.test/",
    atomApiKey: "secret",
    ...overrides,
  };
}

function createHarness(options: {
  routeConfig?: AtomRouteConfig;
  httpClient?: AtomHttpClient;
} = {}) {
  const configProvider: AtomRouteConfigProvider = {
    getConfig: vi.fn(async () => options.routeConfig ?? atomConfig()),
  };
  const httpClient = options.httpClient ?? {
    get: vi.fn(async () => ({
      statusCode: 200,
      body: [{ id: "atom-node" }],
    })),
  };
  const app = createApp({
    config,
    atomRoutes: {
      configProvider,
      httpClient,
    },
  });
  return { app, configProvider, httpClient };
}

describe("atom route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps Atom routes disabled on the default app", async () => {
    const app = createApp({ config });

    expect(await app.inject({ method: "GET", url: "/api/atom/nodes" }))
      .toMatchObject({ statusCode: 404 });
    expect(await app.inject({ method: "GET", url: "/api/atom/nodes/node-a/children" }))
      .toMatchObject({ statusCode: 404 });

    await app.close();
  });

  it("registers only Python Atom auth contract rows for route inventory order 96-97", () => {
    expect(atomRouteAuthRequirements).toEqual({
      "GET /api/atom/nodes": true,
      "GET /api/atom/nodes/:node_id/children": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) => route.order >= 96 && route.order <= 98)
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [96, "GET", "/api/atom/nodes", true],
      [97, "GET", "/api/atom/nodes/{node_id}/children", true],
      [98, "GET", "/api/tasks", true],
    ]);
    expect(Object.keys(atomRouteAuthRequirements)).not.toContain("GET /api/tasks");
  });

  it("returns Python-compatible disabled config errors without calling upstream", async () => {
    const disabled = createHarness({
      routeConfig: atomConfig({ atomEnabled: false, atomServerUrl: "https://atom.example.test" }),
    });

    const disabledResponse = await disabled.app.inject({ method: "GET", url: "/api/atom/nodes" });

    expect(disabledResponse.statusCode).toBe(503);
    expect(disabledResponse.json()).toEqual({ detail: ATOM_INTEGRATION_DISABLED_DETAIL });
    expect(disabled.httpClient.get).not.toHaveBeenCalled();
    await disabled.app.close();

    const missingUrl = createHarness({
      routeConfig: atomConfig({ atomServerUrl: "" }),
    });

    const missingUrlResponse = await missingUrl.app.inject({
      method: "GET",
      url: "/api/atom/nodes/node-a/children",
    });

    expect(missingUrlResponse.statusCode).toBe(503);
    expect(missingUrlResponse.json()).toEqual({ detail: ATOM_INTEGRATION_DISABLED_DETAIL });
    expect(missingUrl.httpClient.get).not.toHaveBeenCalled();
    await missingUrl.app.close();
  });

  it("proxies root node listing to /api/tree and preserves an empty x-api-key header", async () => {
    const httpClient: AtomHttpClient = {
      get: vi.fn(async () => ({
        statusCode: 200,
        body: [{ id: "root-a" }],
      })),
    };
    const { app } = createHarness({
      routeConfig: atomConfig({ atomApiKey: "" }),
      httpClient,
    });

    const response = await app.inject({ method: "GET", url: "/api/atom/nodes" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ children: [{ id: "root-a" }] });
    expect(httpClient.get).toHaveBeenCalledWith({
      url: "https://atom.example.test/api/tree",
      headers: { "x-api-key": "" },
    });

    await app.close();
  });

  it("uses configured root node id and strips trailing slashes from the upstream base URL", async () => {
    const httpClient: AtomHttpClient = {
      get: vi.fn(async () => ({
        statusCode: 200,
        body: [{ id: "child-a" }],
      })),
    };
    const { app } = createHarness({
      routeConfig: atomConfig({
        atomServerUrl: "https://atom.example.test///",
        atomRootNodeId: "root-node",
      }),
      httpClient,
    });

    const response = await app.inject({ method: "GET", url: "/api/atom/nodes" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ children: [{ id: "child-a" }] });
    expect(httpClient.get).toHaveBeenCalledWith({
      url: "https://atom.example.test/api/tree/root-node/children",
      headers: { "x-api-key": "secret" },
    });

    await app.close();
  });

  it("proxies node children with safe path segment encoding", async () => {
    const httpClient: AtomHttpClient = {
      get: vi.fn(async () => ({
        statusCode: 200,
        body: { children: ["from-upstream"] },
      })),
    };
    const { app } = createHarness({ httpClient });

    const response = await app.inject({
      method: "GET",
      url: "/api/atom/nodes/node%2Fwith%20space/children",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ children: { children: ["from-upstream"] } });
    expect(httpClient.get).toHaveBeenCalledWith({
      url: "https://atom.example.test/api/tree/node%2Fwith%20space/children",
      headers: { "x-api-key": "secret" },
    });

    await app.close();
  });

  it("maps upstream and request failures to Python-compatible Atom errors", async () => {
    const rootFailure = createHarness({
      httpClient: {
        get: vi.fn(async () => ({ statusCode: 404, body: { detail: "missing root" } })),
      },
    });

    const rootResponse = await rootFailure.app.inject({ method: "GET", url: "/api/atom/nodes" });

    expect(rootResponse.statusCode).toBe(502);
    expect(rootResponse.json()).toEqual({ detail: ATOM_API_UNAVAILABLE_DETAIL });
    await rootFailure.app.close();

    const nodeMissing = createHarness({
      httpClient: {
        get: vi.fn(async () => ({ statusCode: 404, body: { detail: "missing node" } })),
      },
    });

    const nodeMissingResponse = await nodeMissing.app.inject({
      method: "GET",
      url: "/api/atom/nodes/node-a/children",
    });

    expect(nodeMissingResponse.statusCode).toBe(404);
    expect(nodeMissingResponse.json()).toEqual({ detail: ATOM_NODE_NOT_FOUND_DETAIL });
    await nodeMissing.app.close();

    const nodeServerFailure = createHarness({
      httpClient: {
        get: vi.fn(async () => ({ statusCode: 500, body: { detail: "bad upstream" } })),
      },
    });

    const nodeServerFailureResponse = await nodeServerFailure.app.inject({
      method: "GET",
      url: "/api/atom/nodes/node-a/children",
    });

    expect(nodeServerFailureResponse.statusCode).toBe(502);
    expect(nodeServerFailureResponse.json()).toEqual({ detail: ATOM_API_UNAVAILABLE_DETAIL });
    await nodeServerFailure.app.close();

    const parseFailure = createHarness({
      httpClient: {
        get: vi.fn(async () => ({ statusCode: 200, body: undefined })),
      },
    });

    const parseFailureResponse = await parseFailure.app.inject({
      method: "GET",
      url: "/api/atom/nodes/node-a/children",
    });

    expect(parseFailureResponse.statusCode).toBe(502);
    expect(parseFailureResponse.json()).toEqual({ detail: ATOM_API_UNAVAILABLE_DETAIL });
    await parseFailure.app.close();

    const requestFailure = createHarness({
      httpClient: {
        get: vi.fn(async () => {
          throw new Error("connection refused");
        }),
      },
    });

    const requestFailureResponse = await requestFailure.app.inject({
      method: "GET",
      url: "/api/atom/nodes",
    });

    expect(requestFailureResponse.statusCode).toBe(502);
    expect(requestFailureResponse.json()).toEqual({ detail: ATOM_API_UNAVAILABLE_DETAIL });
    await requestFailure.app.close();
  });
});
