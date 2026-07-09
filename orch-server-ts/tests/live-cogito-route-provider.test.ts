import { describe, expect, it } from "vitest";

import {
  createLiveCogitoRouteProvider,
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
});
