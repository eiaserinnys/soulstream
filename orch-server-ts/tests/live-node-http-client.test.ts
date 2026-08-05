import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  LiveNodeHttpClientError,
  createLiveNodeHttpClientBoundary,
  type NodeRegistrationPayload,
} from "../src/index.js";

describe("live node HTTP client boundary", () => {
  it("resolves generic requestNode calls from the connected registry snapshot", async () => {
    const registry = createRegistry();
    registerNode(registry, "worker-node", "10.0.0.8", 4106, false);
    const fetch = vi.fn(async () => jsonResponse({ pong: true }));
    const client = createLiveNodeHttpClientBoundary({ registry, fetch });

    await expect(
      client.requestNode({
        nodeId: "worker-node",
        method: "GET",
        path: "/health",
        headers: { authorization: "Bearer token" },
      }),
    ).resolves.toEqual({
      statusCode: 200,
      headers: expect.objectContaining({
        "content-type": "application/json",
      }),
      body: { pong: true },
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://10.0.0.8:4106/health",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer token" },
        body: undefined,
      }),
    );
  });

  it("preserves binary requestNode responses when requested explicitly", async () => {
    const registry = createRegistry();
    registerNode(registry, "worker-node", "10.0.0.8", 4106, false);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    const fetch = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    );
    const client = createLiveNodeHttpClientBoundary({ registry, fetch });

    await expect(
      client.requestNode({
        nodeId: "worker-node",
        method: "GET",
        path: "/api/agents/agent-a/portrait",
        responseType: "arrayBuffer",
      }),
    ).resolves.toEqual({
      statusCode: 200,
      headers: expect.objectContaining({
        "content-type": "image/png",
      }),
      body: Buffer.from(bytes),
    });
  });

  it("maps upstream request failure and timeout to typed errors", async () => {
    const registry = createRegistry();
    registerNode(registry, "worker-node", "10.0.0.8", 4106, false);

    const failed = createLiveNodeHttpClientBoundary({
      registry,
      fetch: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    await expect(
      failed.requestNode({ nodeId: "worker-node", method: "GET", path: "/health" }),
    ).rejects.toMatchObject({
      code: "NODE_HTTP_REQUEST_FAILED",
      nodeId: "worker-node",
    });

    const timedOut = createLiveNodeHttpClientBoundary({
      registry,
      timeoutMs: 1,
      fetch: vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            setTimeout(() => reject(new DOMException("aborted", "AbortError")), 5);
          }),
      ),
    });
    await expect(
      timedOut.requestNode({ nodeId: "worker-node", method: "GET", path: "/health" }),
    ).rejects.toBeInstanceOf(LiveNodeHttpClientError);
    await expect(
      timedOut.requestNode({ nodeId: "worker-node", method: "GET", path: "/health" }),
    ).rejects.toMatchObject({
      code: "NODE_HTTP_REQUEST_TIMEOUT",
      nodeId: "worker-node",
    });
  });
});

function createRegistry(): InMemoryNodeRegistry {
  return new InMemoryNodeRegistry({ nowMs: () => 1_700_000_000_000 });
}

function registerNode(
  registry: InMemoryNodeRegistry,
  nodeId: string,
  host: string,
  port: number,
  hasNodeHttpCapability: boolean,
): string {
  return registry.registerNode({
    type: "node_register",
    node_id: nodeId,
    host,
    port,
    agents: [],
    capabilities: { node_http: hasNodeHttpCapability },
  } satisfies NodeRegistrationPayload).node.connectionId;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init.headers).entries()),
    },
  });
}
