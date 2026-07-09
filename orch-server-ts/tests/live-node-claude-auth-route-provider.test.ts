import { describe, expect, it, vi } from "vitest";

import {
  LiveNodeHttpClientError,
  createLiveNodeClaudeAuthProfileHttpClient,
  type NodeConnectionSnapshot,
} from "../src/index.js";
import { createClaudeAuthHarness } from "./node-claude-auth-test-helpers.js";

const targetNode: NodeConnectionSnapshot = {
  nodeId: "fake-node",
  connectionId: "conn-1",
  host: "ignored-host",
  port: 4105,
  agents: [],
  capabilities: {},
  supportedBackends: [],
  connected: true,
  status: "connected",
  connectedAtMs: 1_700_000_000_000,
  disconnectedAtMs: undefined,
  lastSeenAtMs: 1_700_000_000_000,
  heartbeat: {
    supported: false,
    timeoutMs: 0,
    lastPingAtMs: undefined,
    lastPongAtMs: undefined,
  },
  pendingCommandCount: 0,
};

describe("live node Claude auth route provider", () => {
  it("forwards explicit profile request fields through the live node HTTP boundary", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: { profiles: [{ id: "claude" }] },
    }));
    const httpClient = createLiveNodeClaudeAuthProfileHttpClient({
      nodeHttpClient: { requestNode },
    });

    const response = await httpClient({
      method: "GET",
      url: "http://python-proxy.invalid/this/path/must/not/be/used",
      path: "/auth/claude/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
      node: targetNode,
    });

    expect(response).toEqual({
      statusCode: 200,
      body: { profiles: [{ id: "claude" }] },
    });
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "fake-node",
      method: "GET",
      path: "/auth/claude/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
    });
  });

  it("passes non-2xx upstream responses through without throwing", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 401,
      headers: { "content-type": "application/json" },
      body: { detail: "unauthorized" },
    }));
    const httpClient = createLiveNodeClaudeAuthProfileHttpClient({
      nodeHttpClient: { requestNode },
    });

    await expect(
      httpClient({
        method: "GET",
        url: "http://ignored.example.test/auth/claude/profiles",
        path: "/auth/claude/profiles",
        headers: {},
        node: targetNode,
      }),
    ).resolves.toEqual({
      statusCode: 401,
      body: { detail: "unauthorized" },
    });
  });

  it("lets the existing route return non-200 upstream status without a Python fallback", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 403,
      body: { detail: "denied" },
    }));
    const app = createClaudeAuthHarness({
      profileHttpClient: createLiveNodeClaudeAuthProfileHttpClient({
        nodeHttpClient: { requestNode },
      }),
    });

    const response = await app.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe("");
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "fake-node",
      method: "GET",
      path: "/auth/claude/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
    });

    await app.app.close();
  });

  it.each([
    [
      "stale node",
      new LiveNodeHttpClientError("NODE_HTTP_TARGET_STALE", "stale node", {
        nodeId: "fake-node",
      }),
    ],
    ["request failure", new Error("request failed")],
  ])("maps %s errors to the existing profile route 502 catch", async (_label, error) => {
    const requestNode = vi.fn(async () => {
      throw error;
    });
    const app = createClaudeAuthHarness({
      profileHttpClient: createLiveNodeClaudeAuthProfileHttpClient({
        nodeHttpClient: { requestNode },
      }),
    });

    const response = await app.app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.body).toBe("");
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "fake-node",
      method: "GET",
      path: "/auth/claude/profiles",
      headers: { cookie: "sid=test", authorization: "Bearer test-token" },
    });

    await app.app.close();
  });
});
