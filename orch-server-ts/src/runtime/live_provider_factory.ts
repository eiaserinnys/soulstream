import type { OrchestratorRuntimeServices } from "./composition.js";
import {
  createLiveCogitoRouteProviders,
  type LiveCogitoRouteProviderBundle,
} from "./live_cogito_route_provider.js";
import {
  createLiveConfigRouteProviders,
  type LiveConfigRouteProviderBundle,
} from "./live_config_route_providers.js";
import {
  createLiveSystemConfigRouteProviders,
  type LiveSystemConfigRouteProviderBundle,
} from "./live_system_config_route_provider.js";
import type { LiveProviderDependencies } from "./live_provider_dependencies.js";
import { liveProviderDependencyCategories } from "./live_provider_dependencies.js";
import {
  liveProviderWiringInventory,
  type LiveProviderPath,
  type LiveProviderWiringInventoryEntry,
  type LiveProviderWiringStatus,
} from "./provider_wiring_inventory.js";

export type LiveRuntimeProviderBundle = {
  readonly boardYjsHostProxyRoutes: OrchestratorRuntimeServices["routeOptions"]["boardYjsHostProxyRoutes"];
  readonly nodeSnapshotRoutes: OrchestratorRuntimeServices["routeOptions"]["nodeSnapshotRoutes"];
  readonly nodeWsRoute: OrchestratorRuntimeServices["routeOptions"]["nodeWsRoute"];
  readonly sessionActionCommandRoutes: NonNullable<
    OrchestratorRuntimeServices["routeOptions"]["sessionActionCommandRoutes"]
  >;
  readonly sessionBackgroundScheduleRoutes: NonNullable<
    OrchestratorRuntimeServices["routeOptions"]["sessionBackgroundScheduleRoutes"]
  >;
  readonly sessionCommandRoutes: OrchestratorRuntimeServices["routeOptions"]["sessionCommandRoutes"];
  readonly sessionSnapshotRoutes: OrchestratorRuntimeServices["routeOptions"]["sessionSnapshotRoutes"];
};

export type LiveOrchestratorProviderBundle = {
  readonly runtime: LiveRuntimeProviderBundle;
  readonly cogitoRoutes: LiveCogitoRouteProviderBundle["cogitoRoutes"];
  readonly configProviders: LiveConfigRouteProviderBundle;
  readonly systemConfigRoutes: LiveSystemConfigRouteProviderBundle["systemConfigRoutes"];
  readonly implementedProviderPaths: readonly LiveProviderPath[];
};

export type LiveProviderFactoryFailureStatus =
  | LiveProviderWiringStatus
  | "factory_missing"
  | "factory_extra";

export type LiveProviderFactoryFailure = LiveProviderPath & {
  readonly status: LiveProviderFactoryFailureStatus;
  readonly source: string;
  readonly notes: string;
};

export type LiveProviderFactoryInventoryAlignmentResult = {
  readonly valid: boolean;
  readonly implementedInventoryProviderPaths: LiveProviderPath[];
  readonly factoryProviderPaths: LiveProviderPath[];
  readonly missingImplementedProviderPaths: LiveProviderPath[];
  readonly extraFactoryProviderPaths: LiveProviderPath[];
  readonly blockedFactoryProviderPaths: LiveProviderWiringInventoryEntry[];
  readonly unresolvedProviderPaths: LiveProviderWiringInventoryEntry[];
};

export type ValidateLiveProviderFactoryInventoryAlignmentInput = {
  readonly inventory?: readonly LiveProviderWiringInventoryEntry[];
  readonly factoryProviderPaths?: readonly LiveProviderPath[];
};

export type CreateLiveOrchestratorProviderBundleOptions = {
  readonly dependencies: LiveProviderDependencies;
  readonly runtimeServices: OrchestratorRuntimeServices;
  readonly inventory?: readonly LiveProviderWiringInventoryEntry[];
  readonly factoryProviderPaths?: readonly LiveProviderPath[];
};

export const liveFactoryImplementedProviderPaths = [
  { owner: "atom", path: "atomRoutes.configProvider" },
  { owner: "board.yjs-host", path: "runtime.boardYjsHostHttpClient" },
  { owner: "cogito", path: "cogitoRoutes.briefCollector" },
  { owner: "cogito", path: "cogitoRoutes.httpClient" },
  { owner: "cogito", path: "cogitoRoutes.provider" },
  { owner: "node.snapshot", path: "runtime" },
  { owner: "node.ws", path: "runtime" },
  { owner: "public.status", path: "publicStatusRoutes.configProvider" },
  { owner: "session.actions", path: "runtime" },
  { owner: "session.background-schedule", path: "runtime" },
  { owner: "session.command", path: "runtime" },
  { owner: "session.snapshot", path: "runtime" },
  { owner: "system.config", path: "systemConfigRoutes.httpClient" },
  { owner: "system.config", path: "systemConfigRoutes.provider" },
] as const satisfies readonly LiveProviderPath[];

export class LiveProviderFactoryError extends Error {
  readonly failures: readonly LiveProviderFactoryFailure[];

  constructor(failures: readonly LiveProviderFactoryFailure[]) {
    super(formatLiveProviderFactoryError(failures));
    this.name = "LiveProviderFactoryError";
    this.failures = failures;
  }
}

export function createLiveOrchestratorProviderBundle(
  options: CreateLiveOrchestratorProviderBundleOptions,
): LiveOrchestratorProviderBundle {
  assertLiveProviderDependencies(options.dependencies);
  const inventory = options.inventory ?? liveProviderWiringInventory;
  const factoryProviderPaths =
    options.factoryProviderPaths ?? liveFactoryImplementedProviderPaths;
  const alignment = validateLiveProviderFactoryInventoryAlignment({
    inventory,
    factoryProviderPaths,
  });
  const failures = liveProviderFactoryFailures(alignment, inventory);
  if (failures.length > 0) {
    throw new LiveProviderFactoryError(failures);
  }

  const systemConfigProviders = createLiveSystemConfigRouteProviders({
    registry: options.runtimeServices.registry,
    nodeHttpClient: options.dependencies.nodeHttpClient,
    portraitAssets: options.dependencies.systemPortraitAssets,
  });
  const cogitoProviders = createLiveCogitoRouteProviders({
    registry: options.runtimeServices.registry,
    bridge: options.runtimeServices.sessionBridge,
    nodeHttpClient: options.dependencies.nodeHttpClient,
  });

  return {
    runtime: buildLiveRuntimeProviderBundle(options.runtimeServices),
    cogitoRoutes: cogitoProviders.cogitoRoutes,
    configProviders: createLiveConfigRouteProviders(options.dependencies.configProvider),
    systemConfigRoutes: systemConfigProviders.systemConfigRoutes,
    implementedProviderPaths: alignment.factoryProviderPaths,
  };
}

export function validateLiveProviderFactoryInventoryAlignment(
  input: ValidateLiveProviderFactoryInventoryAlignmentInput,
): LiveProviderFactoryInventoryAlignmentResult {
  const inventory = input.inventory ?? liveProviderWiringInventory;
  const factoryProviderPaths = sortedProviderPaths(
    input.factoryProviderPaths ?? liveFactoryImplementedProviderPaths,
  );
  const factoryKeys = new Set(factoryProviderPaths.map(providerKey));
  const inventoryByKey = new Map(
    inventory.map((entry) => [providerKey(entry), entry]),
  );
  const implementedInventoryProviderPaths = sortedProviderPaths(
    inventory
      .filter((entry) => entry.status === "implemented")
      .map((entry) => ({ owner: entry.owner, path: entry.path })),
  );
  const implementedKeys = new Set(
    implementedInventoryProviderPaths.map(providerKey),
  );
  const missingImplementedProviderPaths =
    implementedInventoryProviderPaths.filter(
      (path) => !factoryKeys.has(providerKey(path)),
    );
  const extraFactoryProviderPaths = factoryProviderPaths.filter(
    (path) => !inventoryByKey.has(providerKey(path)),
  );
  const blockedFactoryProviderPaths = factoryProviderPaths.flatMap((path) => {
    const entry = inventoryByKey.get(providerKey(path));
    return entry !== undefined && entry.status !== "implemented" ? [entry] : [];
  });
  const unresolvedProviderPaths = inventory
    .filter((entry) => entry.status !== "implemented")
    .sort(compareProviderPath);

  return {
    valid:
      missingImplementedProviderPaths.length === 0 &&
      extraFactoryProviderPaths.length === 0 &&
      blockedFactoryProviderPaths.length === 0 &&
      unresolvedProviderPaths.length === 0 &&
      factoryProviderPaths.every((path) => implementedKeys.has(providerKey(path))),
    implementedInventoryProviderPaths,
    factoryProviderPaths,
    missingImplementedProviderPaths,
    extraFactoryProviderPaths,
    blockedFactoryProviderPaths,
    unresolvedProviderPaths,
  };
}

function assertLiveProviderDependencies(
  dependencies: unknown,
): asserts dependencies is LiveProviderDependencies {
  const missing = liveProviderDependencyCategories.filter(
    (category) =>
      dependencies == null ||
      (dependencies as Partial<Record<typeof category, unknown>>)[category] ==
        null,
  );
  if (missing.length > 0) {
    throw new LiveProviderFactoryError(
      missing.map((category) => ({
        owner: "live.dependencies",
        path: category,
        status: "factory_missing",
        source: "CreateLiveOrchestratorProviderBundleOptions.dependencies",
        notes: "Live provider factory dependencies must be passed explicitly.",
      })),
    );
  }
}

function buildLiveRuntimeProviderBundle(
  services: OrchestratorRuntimeServices,
): LiveRuntimeProviderBundle {
  return {
    boardYjsHostProxyRoutes: services.routeOptions.boardYjsHostProxyRoutes,
    nodeSnapshotRoutes: services.routeOptions.nodeSnapshotRoutes,
    nodeWsRoute: services.routeOptions.nodeWsRoute,
    sessionActionCommandRoutes: requireRuntimeRouteOption(
      services.routeOptions.sessionActionCommandRoutes,
      "session.actions",
      "runtime",
    ),
    sessionBackgroundScheduleRoutes: requireRuntimeRouteOption(
      services.routeOptions.sessionBackgroundScheduleRoutes,
      "session.background-schedule",
      "runtime",
    ),
    sessionCommandRoutes: services.routeOptions.sessionCommandRoutes,
    sessionSnapshotRoutes: services.routeOptions.sessionSnapshotRoutes,
  };
}

function requireRuntimeRouteOption<T>(
  value: T | undefined,
  owner: string,
  path: string,
): T {
  if (value === undefined) {
    throw new LiveProviderFactoryError([
      {
        owner,
        path,
        status: "implemented",
        source: "createOrchestratorRuntimeServices",
        notes: "Runtime service did not expose a route option marked implemented in the live provider inventory.",
      },
    ]);
  }
  return value;
}

function liveProviderFactoryFailures(
  alignment: LiveProviderFactoryInventoryAlignmentResult,
  inventory: readonly LiveProviderWiringInventoryEntry[],
): LiveProviderFactoryFailure[] {
  const inventoryByKey = new Map(
    inventory.map((entry) => [providerKey(entry), entry]),
  );
  const failures = [
    ...alignment.missingImplementedProviderPaths.map((path) =>
      failureForPath(
        path,
        inventoryByKey.get(providerKey(path)),
        "factory_missing",
        "Inventory marks this provider path implemented, but the factory does not expose it.",
      ),
    ),
    ...alignment.extraFactoryProviderPaths.map((path) =>
      failureForPath(
        path,
        undefined,
        "factory_extra",
        "Factory exposes a provider path that is not present in the live provider inventory.",
      ),
    ),
    ...alignment.blockedFactoryProviderPaths.map((entry) =>
      failureForEntry(
        entry,
        "Factory tried to provide a path that is not marked implemented.",
      ),
    ),
    ...alignment.unresolvedProviderPaths.map((entry) =>
      failureForEntry(
        entry,
        "Live provider path is not implemented yet; factory cannot return a runnable bundle.",
      ),
    ),
  ];
  return dedupeFailures(failures).sort(compareProviderPath);
}

function failureForPath(
  path: LiveProviderPath,
  entry: LiveProviderWiringInventoryEntry | undefined,
  status: LiveProviderFactoryFailureStatus,
  notes: string,
): LiveProviderFactoryFailure {
  return {
    owner: path.owner,
    path: path.path,
    status,
    source: entry?.source ?? "live provider factory",
    notes: entry?.notes ?? notes,
  };
}

function failureForEntry(
  entry: LiveProviderWiringInventoryEntry,
  notes: string,
): LiveProviderFactoryFailure {
  return {
    owner: entry.owner,
    path: entry.path,
    status: entry.status,
    source: entry.source,
    notes: entry.notes.length > 0 ? entry.notes : notes,
  };
}

function dedupeFailures(
  failures: readonly LiveProviderFactoryFailure[],
): LiveProviderFactoryFailure[] {
  const deduped = new Map<string, LiveProviderFactoryFailure>();
  for (const failure of failures) {
    deduped.set(providerKey(failure), failure);
  }
  return [...deduped.values()];
}

function sortedProviderPaths(paths: readonly LiveProviderPath[]): LiveProviderPath[] {
  return [...paths]
    .map((path) => ({ owner: path.owner, path: path.path }))
    .sort(compareProviderPath);
}

function providerKey(path: LiveProviderPath): string {
  return `${path.owner}\0${path.path}`;
}

function compareProviderPath(left: LiveProviderPath, right: LiveProviderPath): number {
  return providerKey(left).localeCompare(providerKey(right));
}

function formatLiveProviderFactoryError(
  failures: readonly LiveProviderFactoryFailure[],
): string {
  const details = failures
    .map(
      (failure) =>
        `${failure.owner}: ${failure.path} (${failure.status}) source=${failure.source}`,
    )
    .join("; ");
  return `Live provider factory cannot build provider bundle: ${details}`;
}
