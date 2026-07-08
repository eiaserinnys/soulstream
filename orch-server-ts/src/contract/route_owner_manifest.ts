import type {
  RouteFamily,
  RouteKey,
  RouteMethod,
  RouteRegistry,
} from "./route_registry.js";

export type RouteOwner = "python" | "ts" | "delegated";

export type RouteOwnerManifestEntry = {
  key: RouteKey;
  method: RouteMethod;
  path: string;
  routeName: string;
  authRequired: boolean;
  family: RouteFamily;
  owner: RouteOwner;
  artifactOnly: true;
  notes?: string;
};

export type RouteOwnerManifest = {
  version: 1;
  artifactOnly: true;
  ownerMeaning: "planning_only_not_production_split";
  entries: RouteOwnerManifestEntry[];
};

export const routeOwnerManifest: RouteOwnerManifest = {
  version: 1,
  artifactOnly: true,
  ownerMeaning: "planning_only_not_production_split",
  entries: [],
};

export function buildPlanningRouteOwnerManifest(registry: RouteRegistry): RouteOwnerManifest {
  return {
    ...routeOwnerManifest,
    entries: registry.entries.map((entry) => ({
      key: entry.key,
      method: entry.method,
      path: entry.path,
      routeName: entry.name,
      authRequired: entry.authRequired,
      family: entry.family,
      owner: "python",
      artifactOnly: true,
      notes: "Current Python orch owner. Planning artifact only; not a TS production split owner.",
    })),
  };
}
