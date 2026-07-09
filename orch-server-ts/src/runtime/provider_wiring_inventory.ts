export type LiveProviderWiringStatus = "implemented" | "stub" | "blocked";

export type LiveProviderCutoverRisk = "low" | "medium" | "high";

export type LiveProviderDependency =
  | "auth"
  | "db"
  | "env"
  | "filesystem"
  | "http"
  | "jwt"
  | "node_http"
  | "oauth"
  | "r2"
  | "runtime"
  | "session_registry"
  | "sse"
  | "websocket";

export type LiveProviderWiringInventoryEntry = {
  readonly owner: string;
  readonly path: string;
  readonly status: LiveProviderWiringStatus;
  readonly source: string;
  readonly dependencies: readonly LiveProviderDependency[];
  readonly cutoverRisk: LiveProviderCutoverRisk;
  readonly notes: string;
};

export type LiveProviderWiringRequirement = {
  readonly owner: string;
  readonly paths: readonly string[];
};

export type LiveProviderPath = {
  readonly owner: string;
  readonly path: string;
};

export type DuplicateLiveProviderPath = LiveProviderPath & {
  readonly count: number;
};

export type LiveProviderWiringInventoryResult = {
  readonly valid: boolean;
  readonly expectedProviderPaths: LiveProviderPath[];
  readonly inventoryProviderPaths: LiveProviderPath[];
  readonly missingProviderPaths: LiveProviderPath[];
  readonly extraProviderPaths: LiveProviderPath[];
  readonly duplicateProviderPaths: DuplicateLiveProviderPath[];
};

export type LiveProviderWiringInventoryInput = {
  readonly requirements: readonly LiveProviderWiringRequirement[];
  readonly inventory: readonly LiveProviderWiringInventoryEntry[];
};

export { liveProviderWiringInventory } from "./provider_wiring_inventory_data.js";

export function validateLiveProviderWiringInventory(
  input: LiveProviderWiringInventoryInput,
): LiveProviderWiringInventoryResult {
  const expectedProviderPaths = sortedProviderPaths(
    input.requirements.flatMap((requirement) =>
      requirement.paths.map((path) => ({ owner: requirement.owner, path })),
    ),
  );
  const inventoryProviderPaths = sortedProviderPaths(input.inventory);
  const expectedKeys = new Set(expectedProviderPaths.map(providerKey));
  const inventoryKeys = new Set(inventoryProviderPaths.map(providerKey));
  const duplicateProviderPaths = duplicateInventoryProviderPaths(input.inventory);
  const missingProviderPaths = expectedProviderPaths.filter(
    (path) => !inventoryKeys.has(providerKey(path)),
  );
  const extraProviderPaths = inventoryProviderPaths.filter(
    (path) => !expectedKeys.has(providerKey(path)),
  );

  return {
    valid:
      missingProviderPaths.length === 0 &&
      extraProviderPaths.length === 0 &&
      duplicateProviderPaths.length === 0,
    expectedProviderPaths,
    inventoryProviderPaths,
    missingProviderPaths,
    extraProviderPaths,
    duplicateProviderPaths,
  };
}

function duplicateInventoryProviderPaths(
  entries: readonly LiveProviderWiringInventoryEntry[],
): DuplicateLiveProviderPath[] {
  const counts = new Map<string, { path: LiveProviderPath; count: number }>();
  for (const entry of entries) {
    const path = { owner: entry.owner, path: entry.path };
    const key = providerKey(path);
    const existing = counts.get(key);
    counts.set(key, {
      path,
      count: existing === undefined ? 1 : existing.count + 1,
    });
  }
  return [...counts.values()]
    .filter(({ count }) => count > 1)
    .map(({ path, count }) => ({ ...path, count }))
    .sort(compareProviderPath);
}

function sortedProviderPaths(paths: readonly LiveProviderPath[]): LiveProviderPath[] {
  return [
    ...new Map(
      paths.map((path) => [
        providerKey(path),
        { owner: path.owner, path: path.path } satisfies LiveProviderPath,
      ]),
    ).values(),
  ].sort(compareProviderPath);
}

function providerKey(path: LiveProviderPath): string {
  return `${path.owner}\0${path.path}`;
}

function compareProviderPath(left: LiveProviderPath, right: LiveProviderPath): number {
  return providerKey(left).localeCompare(providerKey(right));
}
