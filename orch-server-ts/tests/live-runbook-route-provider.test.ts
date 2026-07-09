import { describe, expect, it, vi } from "vitest";

import {
  LiveNodeHttpClientError,
  createApp,
  createLiveRunbookMutationHttpClient,
  parseOrchServerConfig,
  type RunbookAccessProvider,
  type RunbookRouteProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const targetNode = {
  nodeId: "runbook-node",
  host: "ignored-host",
  port: 4105,
};

describe("live runbook route provider", () => {
  it("forwards explicit runbook mutation fields through the live node HTTP boundary", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 202,
      headers: { "content-type": "application/json" },
      body: { accepted: true },
    }));
    const httpClient = createLiveRunbookMutationHttpClient({
      nodeHttpClient: { requestNode },
    });
    const body = {
      status: "completed",
      expectedVersion: 7,
      idempotencyKey: "idem-runbook",
      reason: "done",
    };

    const response = await httpClient({
      method: "POST",
      url: "http://python-proxy.invalid/this/path/must/not/be/used",
      upstreamPath: "/api/runbooks/rb%2F1/status",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      body,
      target: targetNode,
    });

    expect(response).toEqual({
      statusCode: 202,
      headers: { "content-type": "application/json" },
      body: { accepted: true },
    });
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "runbook-node",
      method: "POST",
      path: "/api/runbooks/rb%2F1/status",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      body,
    });
  });

  it("passes non-2xx non-JSON upstream responses through without throwing", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 409,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "conflict",
    }));
    const httpClient = createLiveRunbookMutationHttpClient({
      nodeHttpClient: { requestNode },
    });

    await expect(
      httpClient({
        method: "POST",
        url: "http://ignored.example.test/api/runbooks/rb-1/status",
        upstreamPath: "/api/runbooks/rb-1/status",
        headers: {},
        body: { status: "completed", expectedVersion: 1, idempotencyKey: "idem" },
        target: targetNode,
      }),
    ).resolves.toEqual({
      statusCode: 409,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "conflict",
    });
  });

  it.each([
    [
      "stale node",
      new LiveNodeHttpClientError("NODE_HTTP_TARGET_STALE", "stale node", {
        nodeId: "runbook-node",
      }),
    ],
    ["request failure", new Error("request failed")],
  ])("maps %s errors to the existing runbook route 502 catch", async (_label, error) => {
    const requestNode = vi.fn(async () => {
      throw error;
    });
    const app = createRunbookApp(
      createLiveRunbookMutationHttpClient({ nodeHttpClient: { requestNode } }),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/runbooks/rb-1/status",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      payload: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "idem",
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.body).toBe("");
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "runbook-node",
      method: "POST",
      path: "/api/runbooks/rb-1/status",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      body: {
        status: "completed",
        expectedVersion: 1,
        idempotencyKey: "idem",
      },
    });

    await app.close();
  });
});

function createRunbookApp(httpClient: ReturnType<typeof createLiveRunbookMutationHttpClient>) {
  const provider: RunbookRouteProvider = {
    async listFolders() {
      return [{ id: "folder-a", parentFolderId: null, name: "Alpha" }];
    },
    async getRunbookSnapshot() {
      return {
        runbook: {
          id: "rb-1",
          folder_id: "folder-a",
          created_session_id: "sess-created",
        },
        sections: [],
        items: [],
      };
    },
    async findSessionNode() {
      return targetNode;
    },
    listConnectedNodes() {
      return [targetNode];
    },
  };
  const accessProvider: RunbookAccessProvider = {
    async resolveAccess() {
      return { restricted: false };
    },
  };
  return createApp({
    config,
    runbookRoutes: {
      provider,
      accessProvider,
      httpClient,
    },
  });
}
