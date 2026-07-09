import { describe, expect, it, vi } from "vitest";

import {
  createLiveCogitoRouteProvider,
  createLiveCogitoSearchHttpClient,
  InMemoryNodeRegistry,
} from "../src/index.js";

describe("live cogito route provider adapter", () => {
  it("lists only currently connected registry nodes as Cogito nodes", async () => {
    let now = 1_700_000_000_000;
    const registry = new InMemoryNodeRegistry({
      nowMs: () => now,
    });
    const provider = createLiveCogitoRouteProvider({ registry });

    registry.registerNode({
      type: "node_register",
      node_id: "node-b",
      host: "10.0.0.2",
      port: 4106,
      capabilities: { reflect_brief: false, custom: "discarded-by-disconnect" },
    });
    registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      host: "10.0.0.1",
      port: 4105,
      capabilities: { reflect_brief: true, custom: "kept" },
    });
    now += 1;
    registry.disconnectNode("node-b", "closed");

    const connectedNodes = await provider.listConnectedNodes();

    expect(connectedNodes).toEqual([
      {
        id: "node-a",
        host: "10.0.0.1",
        port: 4105,
        capabilities: { reflect_brief: true, custom: "kept" },
      },
    ]);
    expect(Object.keys(connectedNodes[0] ?? {}).sort()).toEqual([
      "capabilities",
      "host",
      "id",
      "port",
    ]);
  });

  it("forwards search requests through the live node HTTP boundary with explicit nodeId", async () => {
    const requestNode = vi.fn(async () => ({
      statusCode: 200,
      body: { results: [{ session_id: "hit" }] },
    }));
    const httpClient = createLiveCogitoSearchHttpClient({
      nodeHttpClient: { requestNode },
    });

    await expect(
      httpClient.get({
        nodeId: "node-a",
        url: "http://ignored.example.test/cogito/search",
        params: {
          q: "hello world",
          top_k: 7,
          search_session_id: true,
          event_types: "message,tool",
        },
        headers: {
          authorization: "Bearer token",
          cookie: "session=abc",
        },
      }),
    ).resolves.toEqual({
      statusCode: 200,
      body: { results: [{ session_id: "hit" }] },
    });
    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "node-a",
      method: "GET",
      path: "/cogito/search?q=hello+world&top_k=7&search_session_id=true&event_types=message%2Ctool",
      headers: {
        authorization: "Bearer token",
        cookie: "session=abc",
      },
    });
  });

  it("omits optional event_types while preserving the other Cogito search query keys", async () => {
    const requestNode = vi.fn(async () => ({ statusCode: 200, body: {} }));
    const httpClient = createLiveCogitoSearchHttpClient({
      nodeHttpClient: { requestNode },
    });

    await httpClient.get({
      nodeId: "node-a",
      url: "http://ignored.example.test/cogito/search",
      params: {
        q: "plain",
        top_k: 10,
        search_session_id: false,
      },
      headers: {},
    });

    expect(requestNode).toHaveBeenCalledWith({
      nodeId: "node-a",
      method: "GET",
      path: "/cogito/search?q=plain&top_k=10&search_session_id=false",
      headers: {},
    });
  });
});
