import { describe, expect, it } from "vitest";

import {
  buildRuntimeRouteRegistry,
  getRouteByKey,
  loadContractFixtures,
} from "../../src/index.js";

const CLIENT_PAGE_API_INVENTORY = {
  "soul-ui/v3": [
    ["GET", "/api/pages"],
    ["GET", "/api/pages/search"],
    ["POST", "/api/pages/daily"],
    ["GET", "/api/pages/{pageId}"],
    ["GET", "/api/pages/{pageId}/backlinks"],
    ["GET", "/api/pages/{pageId}/session-defaults"],
    ["POST", "/api/pages/block-transfers"],
    ["POST", "/api/pages/{pageId}/operations"],
    ["PATCH", "/api/pages/{pageId}/starred"],
  ],
  "soul-app": [
    ["POST", "/api/pages/daily"],
    ["GET", "/api/pages/{pageId}"],
    ["GET", "/api/pages/{pageId}/backlinks"],
    ["POST", "/api/pages/block-transfers"],
    ["POST", "/api/pages/{pageId}/operations"],
    ["PATCH", "/api/pages/{pageId}/starred"],
  ],
} as const;

const PAGE_YDOC_INFRASTRUCTURE = [
  ["POST", "/api/page-yjs/host/{operation}"],
  ["WEBSOCKET", "/yjs/page/{pageId}"],
] as const;

describe("active Page API client inventory", () => {
  const registry = buildRuntimeRouteRegistry(loadContractFixtures().routeInventory);

  it.each(Object.entries(CLIENT_PAGE_API_INVENTORY))(
    "keeps every %s Page API registered and authenticated",
    (_client, routes) => {
      for (const [method, path] of routes) {
        expect(getRouteByKey(registry, method, path)).toMatchObject({
          family: "page_yjs",
          authRequired: true,
        });
      }
    },
  );

  it("keeps the canonical Page Y.Doc mutation and synchronization routes", () => {
    for (const [method, path] of PAGE_YDOC_INFRASTRUCTURE) {
      expect(getRouteByKey(registry, method, path)).toMatchObject({ family: "page_yjs" });
    }
  });

  it("does not restore the retired generic block browser routes", () => {
    expect(getRouteByKey(registry, "GET", "/api/blocks/search")).toBeUndefined();
    expect(getRouteByKey(registry, "GET", "/api/blocks/{blockId}")).toBeUndefined();
  });
});
