import type {
  RouteKey,
  RouteRegistry,
  RouteRegistryEntry,
} from "./route_registry.js";

export type RouteAuthRequirements = Readonly<Record<string, boolean>>;

export type RouteCoverageOwner = {
  owner: string;
  routeKeys?: readonly string[];
  authRequirements: RouteAuthRequirements;
};

export type DuplicateRouteOwner = {
  key: RouteKey;
  owners: string[];
};

export type UnknownRouteOwner = {
  key: RouteKey;
  owners: string[];
};

export type RouteAuthRequiredMismatch = {
  key: RouteKey;
  owner: string;
  expected: boolean;
  actual: boolean;
};

export type RouteCoverageCompletenessResult = {
  valid: boolean;
  expectedRouteKeys: RouteKey[];
  registeredRouteKeys: RouteKey[];
  routeOwnerKeys: RouteKey[];
  authRequirementKeys: RouteKey[];
  missingRegisteredRouteKeys: RouteKey[];
  missingRouteOwnerKeys: RouteKey[];
  missingAuthRequirementKeys: RouteKey[];
  authRequiredMismatches: RouteAuthRequiredMismatch[];
  duplicateRouteOwners: DuplicateRouteOwner[];
  duplicateAuthRequirementOwners: DuplicateRouteOwner[];
  unknownRouteOwnerKeys: UnknownRouteOwner[];
  unknownAuthRequirementKeys: UnknownRouteOwner[];
};

export type RouteCoverageCompletenessInput = {
  registry: RouteRegistry;
  registeredRouteKeys: readonly string[];
  owners: readonly RouteCoverageOwner[];
};

export function validateRouteCoverageCompleteness(
  input: RouteCoverageCompletenessInput,
): RouteCoverageCompletenessResult {
  const expectedRouteKeys = sortedRouteKeys(input.registry.entries.map((entry) => entry.key));
  const expectedRouteKeySet = new Set<RouteKey>(expectedRouteKeys);
  const registeredRouteKeys = sortedRouteKeys(input.registeredRouteKeys.map(normalizeRouteKey));
  const routeOwnerIndex = buildOwnerIndex(input.owners, "route");
  const authRequirementIndex = buildOwnerIndex(input.owners, "auth");
  const routeOwnerKeys = sortedRouteKeys([...routeOwnerIndex.keys()]);
  const authRequirementKeys = sortedRouteKeys([...authRequirementIndex.keys()]);
  const missingRegisteredRouteKeys = missingFrom(expectedRouteKeys, registeredRouteKeys);
  const missingRouteOwnerKeys = missingFrom(expectedRouteKeys, routeOwnerKeys);
  const missingAuthRequirementKeys = missingFrom(expectedRouteKeys, authRequirementKeys);
  const duplicateRouteOwners = duplicateOwners(routeOwnerIndex);
  const duplicateAuthRequirementOwners = duplicateOwners(authRequirementIndex);
  const unknownRouteOwnerKeys = unknownOwners(routeOwnerIndex, expectedRouteKeySet);
  const unknownAuthRequirementKeys = unknownOwners(authRequirementIndex, expectedRouteKeySet);
  const authRequiredMismatches = authMismatches(input.registry, input.owners);

  return {
    valid:
      missingRegisteredRouteKeys.length === 0 &&
      missingRouteOwnerKeys.length === 0 &&
      missingAuthRequirementKeys.length === 0 &&
      authRequiredMismatches.length === 0 &&
      duplicateRouteOwners.length === 0 &&
      duplicateAuthRequirementOwners.length === 0 &&
      unknownRouteOwnerKeys.length === 0 &&
      unknownAuthRequirementKeys.length === 0,
    expectedRouteKeys,
    registeredRouteKeys,
    routeOwnerKeys,
    authRequirementKeys,
    missingRegisteredRouteKeys,
    missingRouteOwnerKeys,
    missingAuthRequirementKeys,
    authRequiredMismatches,
    duplicateRouteOwners,
    duplicateAuthRequirementOwners,
    unknownRouteOwnerKeys,
    unknownAuthRequirementKeys,
  };
}

export function pythonRoutePathToFastifyPath(path: string): string {
  return path.replace(/\{([^}/]+)\}/g, ":$1");
}

export function normalizeRouteKey(key: string): RouteKey {
  const trimmed = key.trim();
  const separatorIndex = trimmed.indexOf(" ");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new Error(`invalid route key: ${key}`);
  }
  const method = trimmed.slice(0, separatorIndex).toUpperCase();
  const path = trimmed.slice(separatorIndex + 1);
  return `${method} ${normalizeRoutePath(path)}` as RouteKey;
}

export function normalizeRoutePath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? `{${segment.slice(1)}}` : segment))
    .join("/");
}

function buildOwnerIndex(
  owners: readonly RouteCoverageOwner[],
  kind: "route" | "auth",
): Map<RouteKey, string[]> {
  const index = new Map<RouteKey, string[]>();
  for (const owner of owners) {
    const keys =
      kind === "route"
        ? owner.routeKeys ?? Object.keys(owner.authRequirements)
        : Object.keys(owner.authRequirements);
    for (const rawKey of keys) {
      addOwner(index, normalizeRouteKey(rawKey), owner.owner);
    }
  }
  return index;
}

function addOwner(index: Map<RouteKey, string[]>, key: RouteKey, owner: string): void {
  const owners = index.get(key);
  if (owners === undefined) {
    index.set(key, [owner]);
    return;
  }
  if (!owners.includes(owner)) owners.push(owner);
}

function duplicateOwners(index: Map<RouteKey, string[]>): DuplicateRouteOwner[] {
  return [...index.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([key, owners]) => ({ key, owners: [...owners].sort() }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function unknownOwners(
  index: Map<RouteKey, string[]>,
  expectedRouteKeySet: ReadonlySet<RouteKey>,
): UnknownRouteOwner[] {
  return [...index.entries()]
    .filter(([key]) => !expectedRouteKeySet.has(key))
    .map(([key, owners]) => ({ key, owners: [...owners].sort() }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function authMismatches(
  registry: RouteRegistry,
  owners: readonly RouteCoverageOwner[],
): RouteAuthRequiredMismatch[] {
  const mismatches: RouteAuthRequiredMismatch[] = [];
  for (const owner of owners) {
    for (const [rawKey, actual] of Object.entries(owner.authRequirements)) {
      const key = normalizeRouteKey(rawKey);
      const expected = registry.byKey.get(key)?.authRequired;
      if (expected !== undefined && expected !== actual) {
        mismatches.push({ key, owner: owner.owner, expected, actual });
      }
    }
  }
  return mismatches.sort((left, right) =>
    `${left.key} ${left.owner}`.localeCompare(`${right.key} ${right.owner}`),
  );
}

function missingFrom(expected: readonly RouteKey[], actual: readonly RouteKey[]): RouteKey[] {
  const actualSet = new Set(actual);
  return expected.filter((key) => !actualSet.has(key));
}

function sortedRouteKeys(keys: Iterable<string>): RouteKey[] {
  return [...new Set([...keys].map(normalizeRouteKey))].sort();
}

export function routeKeyFromRegistryEntry(entry: RouteRegistryEntry): RouteKey {
  return normalizeRouteKey(entry.key);
}
