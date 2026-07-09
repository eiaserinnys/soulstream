import { describe, expect, it, vi } from "vitest";

import {
  createLiveSystemConfigRouteProvider,
  InMemoryNodeRegistry,
  type LiveSystemPortraitAssetBoundary,
} from "../src/index.js";

describe("live system config route provider adapter", () => {
  it("maps Python system portrait sources to the canonical system.png asset", async () => {
    const assets = createPortraitAssets();
    const provider = createLiveSystemConfigRouteProvider({
      registry: new InMemoryNodeRegistry(),
      portraitAssets: assets,
    });

    await expect(provider.getSystemPortrait("system")).resolves.toMatchObject({
      body: Buffer.from("asset:system.png"),
    });
    await expect(
      provider.getSystemPortrait("channel_observer"),
    ).resolves.toMatchObject({
      body: Buffer.from("asset:system.png"),
    });
    await expect(
      provider.getSystemPortrait("trello_watcher"),
    ).resolves.toMatchObject({
      body: Buffer.from("asset:system.png"),
    });
    expect(assets.readSystemPortraitAsset).toHaveBeenCalledTimes(3);
    expect(assets.readSystemPortraitAsset).toHaveBeenNthCalledWith(1, "system.png");
    expect(assets.readSystemPortraitAsset).toHaveBeenNthCalledWith(2, "system.png");
    expect(assets.readSystemPortraitAsset).toHaveBeenNthCalledWith(3, "system.png");
  });

  it("returns undefined when the explicit portrait asset boundary cannot load the asset", async () => {
    const provider = createLiveSystemConfigRouteProvider({
      registry: new InMemoryNodeRegistry(),
      portraitAssets: {
        readSystemPortraitAsset: vi.fn(async () => undefined),
      },
    });

    await expect(provider.getSystemPortrait("system")).resolves.toBeUndefined();
  });

  it("lists only currently connected nodes as nodeId host port candidates", async () => {
    let now = 1_700_000_000_000;
    const registry = new InMemoryNodeRegistry({
      nowMs: () => now,
    });
    const provider = createLiveSystemConfigRouteProvider({
      registry,
      portraitAssets: createPortraitAssets(),
    });

    registry.registerNode({
      type: "node_register",
      node_id: "node-b",
      host: "10.0.0.2",
      port: 4106,
      capabilities: { board_yjs_host: true },
    });
    registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      host: "10.0.0.1",
      port: 4105,
      agents: [{ id: "agent-a" }],
    });
    now += 1;
    registry.disconnectNode("node-b", "closed");

    const connectedNodes = await provider.listConnectedNodes();

    expect(connectedNodes).toEqual([
      {
        nodeId: "node-a",
        host: "10.0.0.1",
        port: 4105,
      },
    ]);
    expect(Object.keys(connectedNodes[0] ?? {}).sort()).toEqual([
      "host",
      "nodeId",
      "port",
    ]);
  });
});

function createPortraitAssets(): LiveSystemPortraitAssetBoundary {
  return {
    readSystemPortraitAsset: vi.fn(async (filename) =>
      Buffer.from(`asset:${filename}`),
    ),
  };
}
