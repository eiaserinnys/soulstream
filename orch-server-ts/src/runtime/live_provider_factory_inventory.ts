import {
  liveProviderWiringInventory,
  type LiveProviderPath,
  type LiveProviderWiringInventoryEntry,
  type LiveProviderWiringStatus,
} from "./provider_wiring_inventory.js";

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

export const liveFactoryImplementedProviderPaths = [
  { owner: "atom", path: "atomRoutes.configProvider" },
  { owner: "auth", path: "authRoutes.configProvider" },
  { owner: "auth", path: "authRoutes.httpClient" },
  { owner: "auth", path: "authRoutes.jwt" },
  { owner: "auth", path: "authRoutes.nativeVerifier" },
  { owner: "auth", path: "authRoutes.resolveTokenAccess" },
  { owner: "auth", path: "authRoutes.userPayloadExtra" },
  { owner: "board.assets", path: "boardAssetRoutes.accessProvider" },
  { owner: "board.assets", path: "boardAssetRoutes.provider" },
  { owner: "board.items", path: "boardItemRoutes.accessProvider" },
  { owner: "board.items", path: "boardItemRoutes.provider" },
  { owner: "board.yjs-host", path: "runtime.boardYjsHostHttpClient" },
  { owner: "cogito", path: "cogitoRoutes.briefCollector" },
  { owner: "cogito", path: "cogitoRoutes.httpClient" },
  { owner: "cogito", path: "cogitoRoutes.provider" },
  { owner: "execute", path: "executeProxyRoutes.provider" },
  { owner: "folders", path: "folderRoutes.accessProvider" },
  { owner: "folders", path: "folderRoutes.provider" },
  { owner: "markdown.documents", path: "markdownDocumentRoutes.accessProvider" },
  { owner: "markdown.documents", path: "markdownDocumentRoutes.provider" },
  { owner: "node.agent-profiles", path: "nodeAgentProfileRoutes.provider" },
  { owner: "node.claude-auth", path: "nodeClaudeAuthRoutes.pkce" },
  { owner: "node.claude-auth", path: "nodeClaudeAuthRoutes.profileHttpClient" },
  { owner: "node.claude-auth", path: "nodeClaudeAuthRoutes.provider" },
  { owner: "node.claude-auth", path: "nodeClaudeAuthRoutes.sessionStore" },
  { owner: "node.claude-auth", path: "nodeClaudeAuthRoutes.tokenExchange" },
  { owner: "node.snapshot", path: "runtime" },
  { owner: "node.ws", path: "runtime" },
  { owner: "public.status", path: "publicStatusRoutes.configProvider" },
  { owner: "public.status", path: "publicStatusRoutes.folderCountsProvider" },
  { owner: "push", path: "pushRoutes.repository" },
  { owner: "push", path: "pushRoutes.resolveJwtUser" },
  { owner: "runbooks", path: "runbookRoutes.accessProvider" },
  { owner: "runbooks", path: "runbookRoutes.httpClient" },
  { owner: "runbooks", path: "runbookRoutes.provider" },
  { owner: "session.actions", path: "runtime" },
  { owner: "session.background-schedule", path: "runtime" },
  { owner: "session.catalog", path: "sessionCatalogRoutes.accessProvider" },
  { owner: "session.catalog", path: "sessionCatalogRoutes.provider" },
  { owner: "session.command", path: "runtime" },
  { owner: "session.history", path: "runtime.sessionHistoryProvider" },
  { owner: "session.snapshot", path: "runtime" },
  { owner: "sse.replay", path: "runtime.loadSessionSnapshot" },
  { owner: "sse.replay", path: "runtime.loadTaskSnapshot" },
  { owner: "system.config", path: "systemConfigRoutes.httpClient" },
  { owner: "system.config", path: "systemConfigRoutes.provider" },
  { owner: "tasks.mutation", path: "taskMutationRoutes.provider" },
  { owner: "tasks.read", path: "taskReadRoutes.provider" },
  { owner: "user.preferences", path: "userPreferencesRoutes.repository" },
  {
    owner: "user.preferences",
    path: "userPreferencesRoutes.resolveAuthenticatedEmail",
  },
] as const satisfies readonly LiveProviderPath[];

export class LiveProviderFactoryError extends Error {
  readonly failures: readonly LiveProviderFactoryFailure[];

  constructor(failures: readonly LiveProviderFactoryFailure[]) {
    super(formatLiveProviderFactoryError(failures));
    this.name = "LiveProviderFactoryError";
    this.failures = failures;
  }
}

export function validateLiveProviderFactoryInventoryAlignment(
  input: ValidateLiveProviderFactoryInventoryAlignmentInput,
): LiveProviderFactoryInventoryAlignmentResult {
  const inventory = input.inventory ?? liveProviderWiringInventory;
  const factoryProviderPaths = sortedProviderPaths(
    input.factoryProviderPaths ?? liveFactoryImplementedProviderPaths,
  );
  const factoryKeys = new Set(factoryProviderPaths.map(providerKey));
  const inventoryByKey = new Map(inventory.map((entry) => [providerKey(entry), entry]));
  const implementedInventoryProviderPaths = sortedProviderPaths(
    inventory
      .filter((entry) => entry.status === "implemented")
      .map((entry) => ({ owner: entry.owner, path: entry.path })),
  );
  const implementedKeys = new Set(implementedInventoryProviderPaths.map(providerKey));
  const missingImplementedProviderPaths = implementedInventoryProviderPaths.filter(
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

export function liveProviderFactoryFailures(
  alignment: LiveProviderFactoryInventoryAlignmentResult,
  inventory: readonly LiveProviderWiringInventoryEntry[],
): LiveProviderFactoryFailure[] {
  const inventoryByKey = new Map(inventory.map((entry) => [providerKey(entry), entry]));
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
      failureForEntry(entry, "Factory tried to provide a path that is not marked implemented."),
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
