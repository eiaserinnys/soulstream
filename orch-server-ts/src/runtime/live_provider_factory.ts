import type { FastifyRequest } from "fastify";

import type { AdminUsersRouteOptions } from "../admin/admin_users_routes.js";
import type { AtomRouteOptions } from "../atom/atom_routes.js";
import type { AttachmentRouteOptions } from "../attachments/attachment_routes.js";
import type { OrchestratorRuntimeServices } from "./composition.js";
import type { LiveTaskChangeListener } from "./live_task_change_listener.js";
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
import type { BoardAssetRouteOptions } from "../board/board_asset_routes.js";
import type { BoardItemRouteOptions } from "../board/board_item_routes.js";
import type { MarkdownDocumentRouteOptions } from "../board/markdown_document_routes.js";
import type { PublicStatusRouteOptions } from "../public/public_status_routes.js";
import type { PushRouteOptions } from "../push/push_routes.js";
import type { UserPreferencesRouteOptions } from "../user/user_preferences_routes.js";
import type { UserBackgroundRouteOptions } from "../user/user_background_routes.js";
import type { RunbookRouteOptions } from "../runbooks/runbook_route_types.js";
import type { SessionCatalogRouteOptions } from "../session/session_catalog_routes.js";
import type { TaskMutationRouteOptions } from "../tasks/task_mutation_routes.js";
import type { TaskReadRouteOptions } from "../tasks/task_read_routes.js";
import { withTaskMutationBroadcasts } from "./live_task_mutation_broadcaster.js";
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
import {
  createSessionCreateLifecycle,
  type SessionCreateLifecycle,
} from "../session/session_create_lifecycle.js";
import {
  createSessionStreamEventFilter,
  type SessionStreamEventFilter,
} from "../session/session_stream_event_filter.js";
import { withFolderMutationBroadcasts } from "./live_folder_mutation_broadcaster.js";
import { withSessionCatalogMutationBroadcasts } from "./live_session_catalog_mutation_broadcaster.js";
import { withBoardAssetMutationBroadcasts } from "./live_board_asset_mutation_broadcaster.js";
import {
  createLiveAuthenticatedUserResolvers,
  type LiveCallerInfoResolver,
} from "./live_authenticated_user_resolver.js";
import { createLiveAdminUsersRouteProvider } from "./live_admin_users_route_provider.js";
import { createLiveAtomHttpClient } from "./live_atom_route_provider.js";
import { createLiveAttachmentRouteProviders } from "./live_attachment_route_provider.js";
import { broadcastCatalogSnapshot } from "./live_folder_mutation_broadcaster.js";
import type { SessionStreamSnapshot } from "../sse/sse_replay_routes.js";
import {
  resolveSessionSnapshotIds,
  resolveSessionSnapshotLimit,
  resolveSessionSnapshotOffset,
} from "../session/session_snapshot_service.js";
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
  readonly taskChangeListener: LiveTaskChangeListener;
};

export type LiveOrchestratorProviderBundle = {
  readonly adminUsersRoutes: AdminUsersRouteOptions;
  readonly atomRoutes: AtomRouteOptions;
  readonly attachmentRoutes: Pick<
    AttachmentRouteOptions,
    "provider" | "accessProvider" | "transport"
  >;
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
  readonly folderRoutes: Pick<FolderRouteOptions, "accessProvider" | "provider">;
  readonly boardAssetRoutes: Pick<BoardAssetRouteOptions, "accessProvider" | "provider">;
  readonly boardItemRoutes: Pick<BoardItemRouteOptions, "accessProvider" | "provider">;
  readonly markdownDocumentRoutes: Pick<
    MarkdownDocumentRouteOptions,
    "accessProvider" | "provider"
  >;
  readonly publicStatusRoutes: Pick<
    PublicStatusRouteOptions,
    "folderCountsProvider"
  >;
  readonly pushRoutes: PushRouteOptions;
  readonly userPreferencesRoutes: UserPreferencesRouteOptions;
  readonly userBackgroundRoutes: UserBackgroundRouteOptions;
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
  readonly taskMutationRoutes: TaskMutationRouteOptions;
  readonly taskReadRoutes: TaskReadRouteOptions;
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
    provider: options.dependencies.dbCatalogRepository.runbookRouteProvider,
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
    repository: options.dependencies.dbCatalogRepository.adminUsersRepository,
  });
  const authenticatedUserResolvers = createLiveAuthenticatedUserResolvers({
    jwt: authJwt,
  });
  const sessionResourceAccessProvider = createSessionResourceAccessProvider({
    accessProvider: dashboardAccessProvider,
    repository: options.dependencies.dbCatalogRepository.sessionResourceAccessRepository,
  });
  const attachmentProviders = createLiveAttachmentRouteProviders({
    registry: options.runtimeServices.registry,
    bridge: options.runtimeServices.sessionBridge,
    dashboardAccessProvider,
    sessionResourceAccessProvider,
  });
  const sessionStreamEventFilter = createSessionStreamEventFilter({
    accessProvider: sessionResourceAccessProvider,
    repository: options.dependencies.dbCatalogRepository.sessionResourceAccessRepository,
  });
  const sessionCreateLifecycle = createSessionCreateLifecycle({
    resolveCallerInfo: authenticatedUserResolvers.resolveCallerInfo,
    boardItems: options.dependencies.dbCatalogRepository.boardItemRouteProvider,
    access: sessionResourceAccessProvider,
    tasks: options.dependencies.dbCatalogRepository.taskMutationProvider,
  });
  const taskChangeListener =
    options.dependencies.dbCatalogRepository.createTaskChangeListener(
      options.runtimeServices.taskBroadcaster,
    );

  return {
    adminUsersRoutes: {
      provider: createLiveAdminUsersRouteProvider({
        repository: options.dependencies.dbCatalogRepository.adminUsersRepository,
        currentEmail: authenticatedUserResolvers.resolveEmail,
        isAdminEmail: dashboardAccessProvider.isAdminEmail,
        listFolders: options.dependencies.dbCatalogRepository.folderRouteProvider.listFolders,
        broadcastAccessChange: () =>
          broadcastCatalogSnapshot(
            options.dependencies.dbCatalogRepository.folderRouteProvider,
            options.runtimeServices.sessionBroadcaster,
          ),
      }),
    },
    atomRoutes: {
      configProvider: configProviders.atomRoutes.configProvider,
      httpClient: createLiveAtomHttpClient(),
    },
    attachmentRoutes: attachmentProviders,
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
    folderRoutes: {
      provider: withFolderMutationBroadcasts(
        options.dependencies.dbCatalogRepository.folderRouteProvider,
        options.runtimeServices.sessionBroadcaster,
      ),
      accessProvider: dashboardAccessProvider,
    },
    boardAssetRoutes: {
      provider: withBoardAssetMutationBroadcasts(
        options.dependencies.dbCatalogRepository.boardAssetRouteProvider,
        options.dependencies.dbCatalogRepository.folderRouteProvider,
        options.runtimeServices.sessionBroadcaster,
      ),
      accessProvider: dashboardAccessProvider,
    },
    boardItemRoutes: {
      provider: options.dependencies.dbCatalogRepository.boardItemRouteProvider,
      accessProvider: dashboardAccessProvider,
    },
    markdownDocumentRoutes: {
      provider: options.dependencies.dbCatalogRepository.markdownDocumentRouteProvider,
      accessProvider: dashboardAccessProvider,
    },
    publicStatusRoutes: {
      folderCountsProvider: {
        ...options.dependencies.dbCatalogRepository.folderCountsProvider,
        resolveAccess: dashboardAccessProvider.resolveAccess,
      },
    },
    pushRoutes: {
      repository: options.dependencies.pushRepository,
      resolveJwtUser: authenticatedUserResolvers.resolveUser,
    },
    userPreferencesRoutes: {
      repository: options.dependencies.dbCatalogRepository.userPreferencesRepository,
      resolveAuthenticatedEmail: authenticatedUserResolvers.resolveEmail,
    },
    userBackgroundRoutes: {
      repository: options.dependencies.dbCatalogRepository.userPreferencesRepository,
      resolveAuthenticatedEmail: authenticatedUserResolvers.resolveEmail,
    },
    sessionCatalogRoutes: {
      provider: withSessionCatalogMutationBroadcasts(
        options.dependencies.dbCatalogRepository.sessionCatalogProvider,
        options.dependencies.dbCatalogRepository.folderRouteProvider,
        options.runtimeServices.sessionBroadcaster,
      ),
      accessProvider: sessionResourceAccessProvider,
    },
    runtime: buildLiveRuntimeProviderBundle(
      options.runtimeServices,
      sessionResourceAccessProvider,
      sessionStreamEventFilter,
      authenticatedUserResolvers.resolveCallerInfo,
      sessionCreateLifecycle,
      {
        snapshotService: {
          async listSessions(query, request) {
            const folderId = query.folder_id ?? query.folderId;
            if (folderId !== undefined) {
              await sessionResourceAccessProvider.requireFolderAccess({
                request,
                folderId,
              });
            }
            const access = await sessionResourceAccessProvider.resolveAccess({ request });
            return options.dependencies.dbCatalogRepository.listSessionSnapshots({
              access,
              sessionIds: resolveSessionSnapshotIds(query.session_ids),
              feedOnly: query.feed_only === true,
              folderId,
              sessionType: query.session_type,
              offset: resolveSessionSnapshotOffset(query),
              limit: resolveSessionSnapshotLimit(query.limit),
            });
          },
        },
      },
      async (request) => {
        const access = await sessionResourceAccessProvider.resolveAccess({ request });
        return options.dependencies.dbCatalogRepository.loadSessionSnapshot({
          access,
          feedOnly: queryBool(request.query, "feed_only"),
        });
      },
      taskChangeListener,
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
    taskMutationRoutes: {
      provider: withTaskMutationBroadcasts(
        options.dependencies.dbCatalogRepository.taskMutationProvider,
        options.runtimeServices.taskBroadcaster,
        {
          shouldBroadcast: () => !taskChangeListener.isRunning(),
        },
      ),
    },
    taskReadRoutes: {
      provider: options.dependencies.dbCatalogRepository.taskReadProvider,
    },
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
  sessionStreamEventFilter: SessionStreamEventFilter,
  resolveCallerInfo: LiveCallerInfoResolver,
  sessionCreateLifecycle: SessionCreateLifecycle,
  sessionSnapshotRoutes: OrchestratorRuntimeServices["routeOptions"]["sessionSnapshotRoutes"],
  loadSessionSnapshot: (request: FastifyRequest) => Promise<SessionStreamSnapshot>,
  taskChangeListener: LiveTaskChangeListener,
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
    sessionActionCommandRoutes: {
      ...requireRuntimeRouteOption(
        services.routeOptions.sessionActionCommandRoutes,
        "session.actions",
        "runtime",
      ),
      resolveCallerInfo: (request, bodyCallerInfo, targetSessionId) =>
        resolveCallerInfo(
          request,
          bodyCallerInfo,
          services.registry.findSessionOwner(targetSessionId)?.nodeId ?? "",
        ),
    },
    sessionBackgroundScheduleRoutes: requireRuntimeRouteOption(
      services.routeOptions.sessionBackgroundScheduleRoutes,
      "session.background-schedule",
      "runtime",
    ),
    sessionCommandRoutes: {
      ...services.routeOptions.sessionCommandRoutes,
      createSessionLifecycle: sessionCreateLifecycle,
    },
    sessionHistoryRoutes: { ...sessionHistoryRoutes, accessProvider },
    sessionSnapshotRoutes,
    sseReplayRoutes: {
      ...services.routeOptions.sseReplayRoutes,
      session: {
        ...services.routeOptions.sseReplayRoutes.session,
        loadSnapshot: loadSessionSnapshot,
        filterEvent: sessionStreamEventFilter,
      },
    },
    taskChangeListener,
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
