import type {
  FakeNodeReconnectFixture,
  OrchContractFixtures,
  RouteInventoryFixture,
} from "./types.js";

export type StaticBeforeDynamicHazard = {
  staticPath: string;
  dynamicPath: string;
};

const KNOWN_STATIC_BEFORE_DYNAMIC_HAZARDS: StaticBeforeDynamicHazard[] = [
  {
    staticPath: "/api/sessions/{session_id}/events/viewport",
    dynamicPath: "/api/sessions/{session_id}/events",
  },
  {
    staticPath: "/api/runbooks/my-turn",
    dynamicPath: "/api/runbooks/{runbook_id}",
  },
];

export function staticBeforeDynamicHazards(
  fixture: RouteInventoryFixture,
): StaticBeforeDynamicHazard[] {
  const order = new Map(fixture.routes.map((route) => [route.path, route.order]));

  return KNOWN_STATIC_BEFORE_DYNAMIC_HAZARDS.filter((hazard) => {
    const staticOrder = order.get(hazard.staticPath);
    const dynamicOrder = order.get(hazard.dynamicPath);
    return staticOrder !== undefined && dynamicOrder !== undefined && staticOrder < dynamicOrder;
  });
}

export function contractFixtureSummary(fixtures: OrchContractFixtures): {
  routeCount: number;
  publicRoutes: string[];
  dbFunctionCount: number;
} {
  return {
    routeCount: fixtures.routeInventory.routes.length,
    publicRoutes: fixtures.routeInventory.routes
      .filter((route) => !route.authRequired)
      .map((route) => route.path)
      .sort(),
    dbFunctionCount: fixtures.dbFunctionContract.functions.length,
  };
}

export function inferFakeNodeReconnectSteps(fixture: FakeNodeReconnectFixture): string[] {
  const steps: string[] = [];
  if (fixture.registration.type === "node_register") steps.push("register");
  if (fixture.ack.type === "session_created") steps.push("ack");
  if (fixture.eventRelay.type === "event") steps.push("relay");
  if (fixture.sessionsUpdateAfterReconnect.type === "sessions_update") {
    steps.push("disconnect", "reconnect", "sessions_update");
  }
  return steps;
}
