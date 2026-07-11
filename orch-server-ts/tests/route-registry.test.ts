import { describe, expect, it } from "vitest";

import {
  EXPECTED_PUBLIC_ROUTE_KEYS,
  assertNoDuplicateRouteKeys,
  buildPlanningRouteOwnerManifest,
  buildRouteRegistry,
  findDuplicateRouteKeys,
  getRouteByKey,
  getRoutesByMethod,
  getRoutesByPath,
  isLowRiskRouteEntry,
  loadContractFixtures,
  routeKey,
  validatePublicRouteAuthMatrix,
  validateStaticBeforeDynamicPriority,
  type RouteInventoryFixture,
} from "../src/index.js";

describe("route registry", () => {
  const fixtures = loadContractFixtures();
  const registry = buildRouteRegistry(fixtures.routeInventory);

  it("expands the route inventory into method+path keyed entries", () => {
    expect(registry.routes).toHaveLength(fixtures.routeInventory.routes.length);
    expect(registry.entries).toHaveLength(
      fixtures.routeInventory.routes.reduce((count, route) => count + route.methods.length, 0),
    );
    expect(routeKey("GET", "/api/health")).toBe("GET /api/health");
    expect(getRouteByKey(registry, "GET", "/api/health")).toMatchObject({
      key: "GET /api/health",
      method: "GET",
      path: "/api/health",
      family: "public_config",
      authRequired: false,
    });
  });

  it("supports path and method lookup without losing route metadata", () => {
    expect(getRoutesByPath(registry, "/api/sessions/folder").map((route) => route.method)).toEqual([
      "PUT",
      "PATCH",
    ]);

    const websocketRoutes = getRoutesByMethod(registry, "WEBSOCKET");
    expect(websocketRoutes).toHaveLength(2);
    expect(websocketRoutes.find((route) => route.path === "/ws/node")).toMatchObject({
      key: "WEBSOCKET /ws/node",
      family: "control_plane",
      authRequired: false,
    });
    expect(websocketRoutes.find((route) => route.path === "/yjs/page/{pageId}"))
      .toMatchObject({ family: "page_yjs", authRequired: false });
  });

  it("detects duplicate method+path keys before route registration exists", () => {
    const duplicateFixture: RouteInventoryFixture = {
      ...fixtures.routeInventory,
      routes: [
        ...fixtures.routeInventory.routes,
        {
          order: 999,
          methods: ["GET"],
          path: "/api/health",
          name: "duplicate_health",
          authRequired: false,
        },
      ],
    };
    const duplicateRegistry = buildRouteRegistry(duplicateFixture);

    expect(findDuplicateRouteKeys(duplicateRegistry)).toEqual(["GET /api/health"]);
    expect(() => assertNoDuplicateRouteKeys(duplicateRegistry)).toThrow(
      "duplicate route keys: GET /api/health",
    );
  });

  it("validates static-before-dynamic priority at registry level", () => {
    const priority = validateStaticBeforeDynamicPriority(registry);

    expect(priority.valid).toBe(true);
    expect(priority.violations).toEqual([]);
    expect(priority.hazards).toEqual([
      {
        staticPath: "/api/sessions/{session_id}/events/viewport",
        dynamicPath: "/api/sessions/{session_id}/events",
      },
      {
        staticPath: "/api/runbooks/my-turn",
        dynamicPath: "/api/runbooks/{runbook_id}",
      },
    ]);

    const brokenFixture: RouteInventoryFixture = {
      ...fixtures.routeInventory,
      routes: fixtures.routeInventory.routes.map((route) => {
        if (route.path === "/api/runbooks/my-turn") return { ...route, order: 80 };
        if (route.path === "/api/runbooks/{runbook_id}") return { ...route, order: 76 };
        return route;
      }),
    };
    const brokenPriority = validateStaticBeforeDynamicPriority(buildRouteRegistry(brokenFixture));
    expect(brokenPriority.valid).toBe(false);
    expect(brokenPriority.violations).toContainEqual({
      staticPath: "/api/runbooks/my-turn",
      dynamicPath: "/api/runbooks/{runbook_id}",
      staticOrder: 80,
      dynamicOrder: 76,
    });
  });

  it("keeps the current Python public route auth matrix fixed", () => {
    const matrix = validatePublicRouteAuthMatrix(registry);

    expect(matrix.valid).toBe(true);
    expect(matrix.publicRouteKeys).toEqual(EXPECTED_PUBLIC_ROUTE_KEYS);
    expect(matrix.missingExpectedPublicRouteKeys).toEqual([]);
    expect(matrix.unexpectedPublicRouteKeys).toEqual([]);
    expect(matrix.expectedPublicRoutesRequiringAuth).toEqual([]);
  });

  it("does not classify node registry, node WS, or SSE control-plane routes as low risk", () => {
    const routeExpectations = [
      ["WEBSOCKET", "/ws/node", "control_plane"],
      ["GET", "/api/nodes", "control_plane"],
      ["GET", "/api/nodes/stream", "control_plane"],
      ["GET", "/api/sessions/stream", "control_plane"],
      ["GET", "/api/sessions/{session_id}/events", "control_plane"],
      ["GET", "/api/tasks/stream", "control_plane"],
      ["POST", "/api/execute", "control_plane"],
      ["POST", "/api/board-yjs/host/{operation}", "board_yjs_proxy"],
      ["POST", "/api/page-yjs/host/{operation}", "page_yjs"],
      ["WEBSOCKET", "/yjs/page/{pageId}", "page_yjs"],
      ["GET", "/api/runbooks/{runbook_id}", "runbook"],
      ["GET", "/api/tasks", "task_tree"],
      ["GET", "/api/admin/users", "admin_or_user"],
      ["GET", "/api/sessions/{session_id}/messages", "session"],
    ] as const;

    for (const [method, path, family] of routeExpectations) {
      const route = getRouteByKey(registry, method, path);
      expect(route?.family).toBe(family);
      expect(route && isLowRiskRouteEntry(route)).toBe(false);
    }

    expect(isLowRiskRouteEntry(getRouteByKey(registry, "GET", "/api/health")!)).toBe(true);
  });

  it("builds a planning-only owner manifest from the Python fixture without TS production owners", () => {
    const manifest = buildPlanningRouteOwnerManifest(registry);

    expect(manifest).toMatchObject({
      version: 1,
      artifactOnly: true,
      ownerMeaning: "planning_only_not_production_split",
    });
    expect(manifest.entries).toHaveLength(registry.entries.length);
    expect(manifest.entries.every((entry) => entry.owner === "python")).toBe(true);
    expect(manifest.entries.some((entry) => entry.owner === "ts")).toBe(false);
    expect(manifest.entries.find((entry) => entry.key === "WEBSOCKET /ws/node")).toMatchObject({
      family: "control_plane",
      owner: "python",
      artifactOnly: true,
    });
  });
});
