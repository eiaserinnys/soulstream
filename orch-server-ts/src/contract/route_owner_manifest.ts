export type RouteOwner = "python" | "ts" | "delegated";

export type RouteOwnerManifestEntry = {
  method: string;
  path: string;
  owner: RouteOwner;
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
