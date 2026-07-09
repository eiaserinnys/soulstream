import type { AtomRouteConfigProvider } from "../atom/atom_routes.js";
import type { PublicStatusRouteConfigProvider } from "../public/public_status_routes.js";
import type { LiveConfigProviderBoundary } from "./live_provider_dependencies.js";

type LiveConfigRouteProviderPath =
  | {
      readonly owner: "atom";
      readonly path: "atomRoutes.configProvider";
    }
  | {
      readonly owner: "node.claude-auth";
      readonly path: "nodeClaudeAuthRoutes.provider";
    }
  | {
      readonly owner: "public.status";
      readonly path: "publicStatusRoutes.configProvider";
    };

export type LiveConfigProviderFailureReason = "missing" | "invalid_type";

export type LiveConfigProviderFailure = LiveConfigRouteProviderPath & {
  readonly key: string;
  readonly reason: LiveConfigProviderFailureReason;
  readonly expected: string;
  readonly actualType: string;
};

export type LiveConfigRouteProviderBundle = {
  readonly atomRoutes: {
    readonly configProvider: AtomRouteConfigProvider;
  };
  readonly publicStatusRoutes: {
    readonly configProvider: PublicStatusRouteConfigProvider;
  };
};

export class LiveConfigProviderError extends Error {
  readonly failures: readonly LiveConfigProviderFailure[];

  constructor(failures: readonly LiveConfigProviderFailure[]) {
    super(formatLiveConfigProviderError(failures));
    this.name = "LiveConfigProviderError";
    this.failures = failures;
  }
}

export function createLiveConfigRouteProviders(
  configProvider: LiveConfigProviderBoundary,
): LiveConfigRouteProviderBundle {
  return {
    atomRoutes: {
      configProvider: {
        getConfig: () => atomRouteConfig(configProvider),
      },
    },
    publicStatusRoutes: {
      configProvider: {
        getConfig: () => publicStatusRouteConfig(configProvider),
      },
    },
  };
}

async function publicStatusRouteConfig(
  configProvider: LiveConfigProviderBoundary,
) {
  const route = {
    owner: "public.status",
    path: "publicStatusRoutes.configProvider",
  } as const;
  const [snapshot, googleClientId, atomEnabled] = await Promise.all([
    configProvider.getConfig(),
    requireString(configProvider, route, "google_client_id"),
    requireBoolean(configProvider, route, "atom_enabled"),
  ]);

  return {
    nodeName: optionalString(snapshot, route, "node_name"),
    authEnabled: googleClientId.length > 0,
    atomEnabled,
  };
}

async function atomRouteConfig(configProvider: LiveConfigProviderBoundary) {
  const route = {
    owner: "atom",
    path: "atomRoutes.configProvider",
  } as const;
  const atomEnabled = await requireBoolean(configProvider, route, "atom_enabled");
  if (!atomEnabled) {
    return {
      atomEnabled,
      atomServerUrl: "",
      atomApiKey: "",
      atomRootNodeId: null,
    };
  }

  const [snapshot, atomServerUrl, atomApiKey] = await Promise.all([
    configProvider.getConfig(),
    requireString(configProvider, route, "atom_server_url"),
    requireString(configProvider, route, "atom_api_key"),
  ]);
  return {
    atomEnabled,
    atomServerUrl,
    atomApiKey,
    atomRootNodeId: optionalString(snapshot, route, "atom_root_node_id"),
  };
}

async function requireString(
  configProvider: LiveConfigProviderBoundary,
  route: LiveConfigRouteProviderPath,
  key: string,
): Promise<string> {
  const value = await readRequiredConfig(configProvider, route, key, "string");
  if (value === undefined || value === null) {
    throw new LiveConfigProviderError([
      failure(route, key, "missing", "string", value),
    ]);
  }
  if (typeof value !== "string") {
    throw new LiveConfigProviderError([
      failure(route, key, "invalid_type", "string", value),
    ]);
  }
  return value;
}

async function requireBoolean(
  configProvider: LiveConfigProviderBoundary,
  route: LiveConfigRouteProviderPath,
  key: string,
): Promise<boolean> {
  const value = await readRequiredConfig(configProvider, route, key, "boolean");
  if (value === undefined || value === null) {
    throw new LiveConfigProviderError([
      failure(route, key, "missing", "boolean", value),
    ]);
  }
  if (typeof value !== "boolean") {
    throw new LiveConfigProviderError([
      failure(route, key, "invalid_type", "boolean", value),
    ]);
  }
  return value;
}

async function readRequiredConfig(
  configProvider: LiveConfigProviderBoundary,
  route: LiveConfigRouteProviderPath,
  key: string,
  expected: string,
): Promise<unknown> {
  try {
    return await configProvider.requireConfig(key);
  } catch {
    throw new LiveConfigProviderError([
      failure(route, key, "missing", expected, undefined),
    ]);
  }
}

function optionalString(
  snapshot: Readonly<Record<string, unknown>>,
  route: LiveConfigRouteProviderPath,
  key: string,
): string | null {
  const value = snapshot[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new LiveConfigProviderError([
      failure(route, key, "invalid_type", "string | null", value),
    ]);
  }
  return value;
}

function failure(
  route: LiveConfigRouteProviderPath,
  key: string,
  reason: LiveConfigProviderFailureReason,
  expected: string,
  actual: unknown,
): LiveConfigProviderFailure {
  return {
    ...route,
    key,
    reason,
    expected,
    actualType: actualType(actual),
  };
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function formatLiveConfigProviderError(
  failures: readonly LiveConfigProviderFailure[],
): string {
  const details = failures
    .map(
      (failureItem) =>
        `${failureItem.owner}: ${failureItem.path} key=${failureItem.key} ${failureItem.reason} expected=${failureItem.expected} actual=${failureItem.actualType}`,
    )
    .join("; ");
  return `Live config provider cannot build route config: ${details}`;
}
