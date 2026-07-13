import { describe, expect, it, vi } from "vitest";

import {
  RunbookRouteError,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  runbookRouteAuthRequirements,
  type RunbookAccessProvider,
  type RunbookMutationHttpClient,
  type RunbookRouteProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const folders = [
  { id: "folder-a", parentFolderId: null, name: "Alpha" },
  { id: "folder-a-child", parentFolderId: "folder-a", name: "Child" },
  { id: "folder-b", parentFolderId: null, name: "Beta" },
];

const overview = {
  my_turn_items: [
    { item_id: "item-a", folder_id: "folder-a-child", title: "Allowed" },
    { item_id: "item-b", folder_id: "folder-b", title: "Denied" },
    "ignored",
  ],
  runbooks: [
    {
      runbook_id: "rb-a",
      folder_id: "folder-a",
      title: "Allowed group",
      items: [
        { item_id: "item-a", folder_id: "folder-a-child" },
        { item_id: "item-b", folder_id: "folder-b" },
      ],
    },
    {
      runbook_id: "rb-b",
      folder_id: "folder-b",
      title: "Denied group",
      items: [{ item_id: "item-b", folder_id: "folder-b" }],
    },
  ],
};

const snapshot = {
  runbook: {
    id: "rb/1",
    folder_id: "folder-a",
    title: "Runbook",
    created_session_id: "sess-created",
    completed_session_id: "sess-completed",
  },
  sections: [
    {
      id: "sec-1",
      created_session_id: "sess-section-created",
      updated_session_id: "sess-section-updated",
    },
  ],
  items: [
    {
      id: "item/1",
      section_id: "sec-1",
      assignee_session_id: "sess-assignee",
      updated_session_id: "sess-updated",
      created_session_id: "sess-item-created",
    },
  ],
};

const ownerNode = {
  nodeId: "owner-node",
  host: "localhost",
  port: 4105,
};

const fallbackNode = {
  nodeId: "fallback-node",
  host: "localhost",
  port: 4106,
};

type ProviderCall =
  | ["listFolders"]
  | ["access"]
  | ["user"]
  | ["overview", unknown]
  | ["snapshot", string]
  | ["findNode", string]
  | ["listNodes"];

function createHarness(overrides: Partial<RunbookRouteProvider> = {}) {
  const calls: ProviderCall[] = [];
  const provider: RunbookRouteProvider = {
    async listFolders() {
      calls.push(["listFolders"]);
      return folders;
    },
    async getRunbookOverview(input) {
      calls.push(["overview", input]);
      return overview;
    },
    async getRunbookSnapshot(runbookId) {
      calls.push(["snapshot", runbookId]);
      return runbookId === "missing" ? null : snapshot;
    },
    async findSessionNode(actorSessionId) {
      calls.push(["findNode", actorSessionId]);
      return actorSessionId === "sess-missing" ? null : ownerNode;
    },
    listConnectedNodes() {
      calls.push(["listNodes"]);
      return [fallbackNode];
    },
    ...overrides,
  };
  return { calls, provider };
}

function createAccessProvider(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  calls: ProviderCall[],
): RunbookAccessProvider {
  return {
    async resolveAccess() {
      calls.push(["access"]);
      return access;
    },
  };
}

function createAppWithRunbooks(
  access: { restricted: boolean; allowedFolderIds?: string[] },
  overrides: Partial<RunbookRouteProvider> = {},
  httpClient: RunbookMutationHttpClient = vi.fn(async () => ({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: { ok: true },
  })),
) {
  const harness = createHarness(overrides);
  const app = createApp({
    config,
    runbookRoutes: {
      provider: harness.provider,
      accessProvider: createAccessProvider(access, harness.calls),
      httpClient,
      async resolveDashboardUserId() {
        harness.calls.push(["user"]);
        return "user@example.com";
      },
    },
  });
  return { app, calls: harness.calls, httpClient };
}

describe("runbook route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps runbook routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["POST", "/api/runbooks", { title: "Work", folder_id: "folder-a" }],
      ["GET", "/api/runbooks/my-turn", undefined],
      ["POST", "/api/runbooks/rb-1/items/item-1/status", { status: "review" }],
      ["POST", "/api/runbooks/rb-1/status", { status: "completed" }],
      ["GET", "/api/runbooks/rb-1", undefined],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 76-79", () => {
    expect(runbookRouteAuthRequirements).toEqual({
      "POST /api/runbooks": true,
      "GET /api/runbooks/my-turn": true,
      "POST /api/runbooks/:runbook_id/items/:item_id/status": true,
      "POST /api/runbooks/:runbook_id/status": true,
      "GET /api/runbooks/:runbook_id": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "get_runbook_my_turn",
          "proxy_runbook_item_status",
          "proxy_runbook_status",
          "get_runbook",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [76, "GET", "/api/runbooks/my-turn", true],
      [77, "POST", "/api/runbooks/{runbook_id}/items/{item_id}/status", true],
      [78, "POST", "/api/runbooks/{runbook_id}/status", true],
      [79, "GET", "/api/runbooks/{runbook_id}", true],
    ]);
  });

  it("proxies browser runbook creation to a connected node after folder access", async () => {
    const httpClient: RunbookMutationHttpClient = vi.fn(async () => ({
      statusCode: 201,
      headers: { "content-type": "application/json" },
      body: { ok: true, runbookId: "rb-browser" },
    }));
    const { app, calls } = createAppWithRunbooks(
      { restricted: true, allowedFolderIds: ["folder-a"] },
      {},
      httpClient,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/runbooks",
      headers: { cookie: "sid=test" },
      payload: {
        runbook_id: "rb-browser",
        title: "Browser work",
        folder_id: "folder-a-child",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([["listFolders"], ["access"], ["listNodes"]]);
    expect(httpClient).toHaveBeenCalledWith({
      method: "POST",
      url: "http://localhost:4106/api/runbooks",
      upstreamPath: "/api/runbooks",
      headers: { cookie: "sid=test" },
      body: {
        runbook_id: "rb-browser",
        title: "Browser work",
        folder_id: "folder-a-child",
      },
      target: fallbackNode,
    });

    await app.close();
  });

  it("keeps my-turn ahead of the dynamic runbook id route", async () => {
    const { app, calls } = createAppWithRunbooks({ restricted: false });

    const response = await app.inject({
      method: "GET",
      url: "/api/runbooks/my-turn",
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["listFolders"],
      ["user"],
      ["overview", { userId: "user@example.com", limit: 100 }],
      ["access"],
    ]);
    expect(calls).not.toContainEqual(["snapshot", "my-turn"]);

    await app.close();
  });

  it("filters my-turn overview by descendant folder access", async () => {
    const { app } = createAppWithRunbooks({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/runbooks/my-turn?limit=25",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      my_turn_items: [{ item_id: "item-a", folder_id: "folder-a-child", title: "Allowed" }],
      runbooks: [
        {
          runbook_id: "rb-a",
          folder_id: "folder-a",
          title: "Allowed group",
          items: [{ item_id: "item-a", folder_id: "folder-a-child" }],
        },
      ],
    });

    await app.close();
  });

  it("maps missing runbook storage provider to 503", async () => {
    const { app } = createAppWithRunbooks(
      { restricted: false },
      { getRunbookOverview: undefined },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/runbooks/my-turn",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ detail: "Runbook storage is not configured" });

    await app.close();
  });

  it("returns runbook snapshots after access check", async () => {
    const { app, calls } = createAppWithRunbooks({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/runbooks/rb%2F1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(calls).toEqual([
      ["snapshot", "rb/1"],
      ["listFolders"],
      ["access"],
    ]);

    await app.close();
  });

  it("proxies item status mutations to the actor session node with auth headers", async () => {
    const httpClient: RunbookMutationHttpClient = vi.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { ok: true },
    }));
    const { app, calls } = createAppWithRunbooks(
      { restricted: true, allowedFolderIds: ["folder-a"] },
      {},
      httpClient,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/runbooks/rb%2F1/items/item%2F1/status",
      headers: {
        authorization: "Bearer test-token",
        cookie: "sid=test",
        "x-extra": "not-forwarded",
      },
      payload: {
        status: "review",
        expected_version: 7,
        idempotency_key: "idem-1",
        reason: "ready",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["snapshot", "rb/1"],
      ["listFolders"],
      ["access"],
      ["findNode", "sess-assignee"],
    ]);
    expect(httpClient).toHaveBeenCalledWith({
      method: "POST",
      url: "http://localhost:4105/api/runbooks/rb%2F1/items/item%2F1/status",
      upstreamPath: "/api/runbooks/rb%2F1/items/item%2F1/status",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      body: {
        status: "review",
        expectedVersion: 7,
        idempotencyKey: "idem-1",
        reason: "ready",
      },
      target: ownerNode,
    });

    await app.close();
  });

  it("falls back to the first connected node when actor session is not routable", async () => {
    const fallbackSnapshot = {
      ...snapshot,
      runbook: { ...snapshot.runbook, created_session_id: "sess-missing" },
      items: [{ id: "item-1" }],
    };
    const { app, calls, httpClient } = createAppWithRunbooks(
      { restricted: false },
      { async getRunbookSnapshot() {
        return fallbackSnapshot;
      } },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/items/item-1/status",
      payload: { status: "completed", expectedVersion: 1, idempotencyKey: "idem" },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toContainEqual(["findNode", "sess-missing"]);
    expect(calls).toContainEqual(["listNodes"]);
    expect(httpClient).toHaveBeenCalledWith(expect.objectContaining({
      target: fallbackNode,
    }));

    await app.close();
  });

  it("rejects missing item, missing provenance, and invalid status before proxying", async () => {
    const httpClient: RunbookMutationHttpClient = vi.fn();
    const { app } = createAppWithRunbooks(
      { restricted: false },
      { async getRunbookSnapshot() {
        return {
          runbook: { id: "rb-1", folder_id: "folder-a" },
          sections: [],
          items: [{ id: "item-1" }],
        };
      } },
      httpClient,
    );

    const missingItem = await app.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/items/missing/status",
      payload: { status: "review", expectedVersion: 1, idempotencyKey: "idem" },
    });
    const missingProvenance = await app.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/items/item-1/status",
      payload: { status: "review", expectedVersion: 1, idempotencyKey: "idem" },
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/items/item-1/status",
      payload: { status: "open", expectedVersion: 1, idempotencyKey: "idem" },
    });

    expect(missingItem.statusCode).toBe(404);
    expect(missingItem.json()).toEqual({ detail: "Runbook item not found" });
    expect(missingProvenance.statusCode).toBe(422);
    expect(missingProvenance.json()).toEqual({
      detail: "Runbook item has no session provenance",
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({
      detail: "status must be one of: pending, review, completed, cancelled",
    });
    expect(httpClient).not.toHaveBeenCalled();

    await app.close();
  });

  it("proxies runbook status mutations and preserves non-JSON upstream responses", async () => {
    const httpClient: RunbookMutationHttpClient = vi.fn(async () => ({
      statusCode: 409,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "conflict",
    }));
    const { app } = createAppWithRunbooks(
      { restricted: false },
      {},
      httpClient,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/runbooks/rb%2F1/status",
      payload: {
        status: "completed",
        expectedVersion: 3,
        idempotencyKey: "idem-runbook",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe("conflict");
    expect(httpClient).toHaveBeenCalledWith(expect.objectContaining({
      upstreamPath: "/api/runbooks/rb%2F1/status",
      body: {
        status: "completed",
        expectedVersion: 3,
        idempotencyKey: "idem-runbook",
      },
      target: ownerNode,
    }));

    await app.close();
  });

  it("preserves non-fallback resolver errors and maps request failures to 502", async () => {
    const httpClient: RunbookMutationHttpClient = vi.fn(async () => {
      throw new Error("network down");
    });
    const resolverError = new RunbookRouteError(
      "NODE_RESOLVER_FAILED",
      "resolver failed",
      409,
    );
    const { app: resolverApp } = createAppWithRunbooks(
      { restricted: false },
      { async findSessionNode() {
        throw resolverError;
      } },
    );
    const { app: requestApp } = createAppWithRunbooks(
      { restricted: false },
      {},
      httpClient,
    );

    const resolverResponse = await resolverApp.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/status",
      payload: { status: "completed", expectedVersion: 1, idempotencyKey: "idem" },
    });
    const requestResponse = await requestApp.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/status",
      payload: { status: "completed", expectedVersion: 1, idempotencyKey: "idem" },
    });

    expect(resolverResponse.statusCode).toBe(409);
    expect(resolverResponse.json()).toEqual({ detail: "resolver failed" });
    expect(requestResponse.statusCode).toBe(502);
    expect(requestResponse.body).toBe("");

    await resolverApp.close();
    await requestApp.close();
  });
});
