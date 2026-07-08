import type {
  FakeNodeReconnectFixture,
  OrchContractFixtures,
  RouteInventoryFixture,
} from "./types.js";
import {
  buildRouteRegistry,
  validateStaticBeforeDynamicPriority,
  type StaticBeforeDynamicHazard,
} from "./route_registry.js";

export type { StaticBeforeDynamicHazard };

export function staticBeforeDynamicHazards(
  fixture: RouteInventoryFixture,
): StaticBeforeDynamicHazard[] {
  return validateStaticBeforeDynamicPriority(buildRouteRegistry(fixture)).hazards;
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
