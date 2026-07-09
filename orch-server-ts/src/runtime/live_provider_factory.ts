import type { FastifyRequest } from "fastify";

import type { OrchestratorRuntimeServices } from "./composition.js";
import {
  createLiveAuthHttpClient,
  createLiveAuthJwtHelper,
  createLiveAuthNativeVerifier,
  createLiveAuthTokenResolver,
  createLiveAuthUserAuthorizer,
} from "./live_auth_route_provider.js";
import {
  createLiveCogitoRouteProviders,
  type LiveCogitoRouteProviderBundle,
} from "./live_cogito_route_provider.js";
import {
  createLiveConfigRouteProviders,
  type LiveConfigRouteProviderBundle,
} from "./live_config_route_providers.js";
import type { ExecuteProxyRouteOptions } from "../execute/execute_proxy_routes.js";
import type { FolderRouteOptions } from "../folders/folder_routes.js";
import type { BoardItemRouteOptions } from "../board/board_item_routes.js";
import type { MarkdownDocumentRouteOptions } from "../board/markdown_document_routes.js";
import type { RunbookRouteOptions } from "../runbooks/runbook_route_types.js";
import type { SessionCatalogRouteOptions } from "../session/session_catalog_routes.js";
import { createLiveDashboardAccessProvider } from "./live_dashboard_access_provider.js";
import { createLiveExecuteProxyRouteProvider } from "./live_execute_proxy_route_provider.js";
import {
  createLiveNodeClaudeAuthRouteProviders,
  type LiveNodeClaudeAuthRouteProviderBundle,
} from "./live_node_claude_auth_route_provider.js";
import {
  createLiveNodeAgentProfileRouteProviders,
  type LiveNodeAgentProfileRouteProviderBundle,
} from "./live_node_agent_profile_route_provider.js";
import {
  createLiveRunbookRouteProviders,
  type LiveRunbookRouteProviderBundle,
} from "./live_runbook_route_provider.js";
import {
  createLiveSystemConfigRouteProviders,
  type LiveSystemConfigRouteProviderBundle,
} from "./live_system_config_route_provider.js";
import type { AuthRouteOptions } from "../auth/auth_routes.js";
import type { LiveProviderDependencies } from "./live_provider_dependencies.js";
import { liveProviderDependencyCategories } from "./live_provider_dependencies.js";
import {
  createSessionResourceAccessProvider,
  type SessionResourceAccessProvider,
} from "../session/session_resource_access.js";
import type { SessionStreamSnapshot } from "../sse/sse_replay_routes.js";
import {
  liveProviderWiringInventory,
  type LiveProviderPath,
  type LiveProviderWiringInventoryEntry,
} from "./provider_wiring_inventory.js";
import {
  LiveProviderFactoryError,
  liveFactoryImplementedProviderPaths,
  liveProviderFactoryFailures,
  validateLiveProviderFactoryInventoryAlignment,
  type LiveProviderFactoryFailure,
  type LiveProviderFactoryInventoryAlignmentResult,
  type ValidateLiveProviderFactoryInventoryAlignmentInput,
} from "./live_provider_factory_inventory.js";

export {
  LiveProviderFactoryError,
  liveFactoryImplementedProviderPaths,
  validateLiveProviderFactoryInventoryAlignment,
  type LiveProviderFactoryFailure,
  type LiveProviderFactoryFailureStatus,
  type LiveProviderFactoryInventoryAlignmentResult,
  type ValidateLiveProviderFactoryInventoryAlignmentInput,
} from "./live_provider_factory_inventory.js";

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
  readonly sessionHistoryRoutes: NonNullable<
    OrchestratorRuntimeServices["routeOptions"]["sessionHistoryRoutes"]
  >;
  readonly sessionSnapshotRoutes: OrchestratorRuntimeServices["routeOptions"]["sessionSnapshotRoutes"];
  readonly sseReplayRoutes: OrchestratorRuntimeServices["routeOptions"]["sseReplayRoutes"];
};

export type LiveOrchestratorProviderBundle = {
  readonly authRoutes: Pick<
    AuthRouteOptions,
    | "configProvider"
    | "httpClient"
    | "jwt"
    | "nativeVerifier"
    | "resolveTokenAccess"
    | "authorizeUser"
    | "userPayloadExtra"
  >;
  readonly folderRoutes: Pick<FolderRouteOptions, "accessProvider">;
  readonly boardItemRoutes: Pick<BoardItemRouteOptions, "accessProvider">;
  readonly markdownDocumentRoutes: Pick<MarkdownDocumentRouteOptions, "accessProvider">;
  readonly sessionCatalogRoutes: SessionCatalogRouteOptions;
  readonly runtime: LiveRuntimeProviderBundle;
  readonly cogitoRoutes: LiveCogitoRouteProviderBundle["cogitoRoutes"];
  readonly configProviders: LiveConfigRouteProviderBundle;
  readonly executeProxyRoutes: ExecuteProxyRouteOptions;
  readonly nodeAgentProfileRoutes: LiveNodeAgentProfileRouteProviderBundle["nodeAgentProfileRoutes"];
  readonly nodeClaudeAuthRoutes: LiveNodeClaudeAuthRouteProviderBundle["nodeClaudeAuthRoutes"];
  readonly runbookRoutes:
    & LiveRunbookRouteProviderBundle["runbookRoutes"]
    & Pick<RunbookRouteOptions, "accessProvider">;
  readonly systemConfigRoutes: LiveSystemConfigRouteProviderBundle["systemConfigRoutes"];
  readonly implementedProviderPaths: readonly LiveProviderPath[];
};

export type CreateLiveOrchestratorProviderBundleOptions = {
  readonly dependencies: LiveProviderDependencies;
  readonly runtimeServices: OrchestratorRuntimeServices;
  readonly inventory?: readonly LiveProviderWiringInventoryEntry[];
  readonly factoryProviderPaths?: readonly LiveProviderPath[];
};

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
  const runbookProviders = createLiveRunbookRouteProviders({
    nodeHttpClient: options.dependencies.nodeHttpClient,
  });
  const configProviders = createLiveConfigRouteProviders(
    options.dependencies.configProvider,
  );
  const nodeClaudeAuthProviders = createLiveNodeClaudeAuthRouteProviders({
    configProvider: options.dependencies.configProvider,
    nodeHttpClient: options.dependencies.nodeHttpClient,
  });
  const nodeAgentProfileProviders = createLiveNodeAgentProfileRouteProviders({
    registry: options.runtimeServices.registry,
    bridge: options.runtimeServices.sessionBridge,
    nodeHttpClient: options.dependencies.nodeHttpClient,
  });
  const authJwt = createLiveAuthJwtHelper({
    configProvider: options.dependencies.configProvider,
  });
  const dashboardAccessProvider = createLiveDashboardAccessProvider({
    configProvider: options.dependencies.configProvider,
    jwt: authJwt,
  });
  const sessionResourceAccessProvider = createSessionResourceAccessProvider({
    accessProvider: dashboardAccessProvider,
    repository: options.dependencies.dbCatalogRepository.sessionResourceAccessRepository,
  });

  return {
    authRoutes: {
      configProvider: configProviders.authRoutes.configProvider,
      httpClient: createLiveAuthHttpClient(),
      jwt: authJwt,
      nativeVerifier: createLiveAuthNativeVerifier({
        configProvider: options.dependencies.configProvider,
      }),
      resolveTokenAccess: createLiveAuthTokenResolver({
        configProvider: options.dependencies.configProvider,
        jwt: authJwt,
      }),
      authorizeUser: createLiveAuthUserAuthorizer({
        configProvider: options.dependencies.configProvider,
      }),
      userPayloadExtra: dashboardAccessProvider.userPayloadExtra,
    },
    folderRoutes: { accessProvider: dashboardAccessProvider },
    boardItemRoutes: { accessProvider: dashboardAccessProvider },
    markdownDocumentRoutes: { accessProvider: dashboardAccessProvider },
    sessionCatalogRoutes: {
      provider: options.dependencies.dbCatalogRepository.sessionCatalogProvider,
      accessProvider: sessionResourceAccessProvider,
    },
    runtime: buildLiveRuntimeProviderBundle(
      options.runtimeServices,
      sessionResourceAccessProvider,
      async (request) => {
        const access = await sessionResourceAccessProvider.resolveAccess({ request });
        return options.dependencies.dbCatalogRepository.loadSessionSnapshot({
          access,
          feedOnly: queryBool(request.query, "feed_only"),
        });
      },
    ),
    cogitoRoutes: cogitoProviders.cogitoRoutes,
    configProviders,
    executeProxyRoutes: {
      provider: createLiveExecuteProxyRouteProvider({
        registry: options.runtimeServices.registry,
        router: options.runtimeServices.sessionRouter,
        bridge: options.runtimeServices.sessionBridge,
        sessionEventHub: options.runtimeServices.sessionEventHub,
      }),
    },
    nodeAgentProfileRoutes: nodeAgentProfileProviders.nodeAgentProfileRoutes,
    nodeClaudeAuthRoutes: nodeClaudeAuthProviders.nodeClaudeAuthRoutes,
    runbookRoutes: {
      ...runbookProviders.runbookRoutes,
      accessProvider: dashboardAccessProvider,
    },
    systemConfigRoutes: systemConfigProviders.systemConfigRoutes,
    implementedProviderPaths: alignment.factoryProviderPaths,
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
  accessProvider: SessionResourceAccessProvider,
  loadSessionSnapshot: (request: FastifyRequest) => Promise<SessionStreamSnapshot>,
): LiveRuntimeProviderBundle {
  const sessionHistoryRoutes = requireRuntimeRouteOption(
    services.routeOptions.sessionHistoryRoutes,
    "session.history",
    "runtime.sessionHistoryProvider",
  );
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
    sessionHistoryRoutes: { ...sessionHistoryRoutes, accessProvider },
    sessionSnapshotRoutes: services.routeOptions.sessionSnapshotRoutes,
    sseReplayRoutes: {
      ...services.routeOptions.sseReplayRoutes,
      session: {
        ...services.routeOptions.sseReplayRoutes.session,
        loadSnapshot: loadSessionSnapshot,
      },
    },
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

function queryBool(query: unknown, key: string): boolean {
  if (typeof query !== "object" || query === null || !(key in query)) return false;
  const value = (query as Record<string, unknown>)[key];
  const raw = Array.isArray(value) ? value[0] : value;
  return (
    typeof raw === "string" &&
    ["1", "true", "yes", "on"].includes(raw.toLowerCase())
  );
}
