// 500줄 예외: 프로덕션 composition root의 단일 조립 순서를 한 파일에서 검증한다.
// 도메인 동작은 각 service/repository 모듈에 있고, 이 파일은 연결만 소유한다.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { createApp, type CreateAppOptions } from "./app.js";
import { BoardYjsRepository } from "./board-yjs/board_yjs_repository.js";
import { BoardYjsMoveRepository } from "./board-yjs/board_yjs_move_repository.js";
import { BoardYjsService } from "./board-yjs/board_yjs_service.js";
import { createBoardProjectionHost } from "./board-yjs/board_projection_host.js";
import { PageRepository } from "./page/page_repository.js";
import { PageYjsService } from "./page/page_service.js";
import { SqlFolderProjectIdentityRepository } from "./folders/folder_project_identity_repository.js";
import { FolderProjectIdentityService } from "./folders/folder_project_identity_service.js";
import { PlannerRepository } from "./planner/planner_repository.js";
import { SqlTaskIdentityRepository } from "./tasks/task_identity_repository.js";
import { TaskIdentityService } from "./tasks/task_identity_service.js";
import {
  createEnvironmentConfigProvider,
  type OrchServerEnvironmentConfig,
  toOrchServerTsConfig,
} from "./config.js";
import { registerDashboardServing } from "./dashboard/dashboard_serving.js";
import { CodexEphemeralExecutor } from "./llm/codex_ephemeral_executor.js";
import type { EphemeralLlmRouteOptions } from "./llm/ephemeral_llm_routes.js";
import { InMemoryNodeRegistry } from "./node/registry.js";
import { resolveRegisteredAgentId } from "./node/agent_profile_lookup.js";
import {
  EventIngressRepository,
  LiveEventIngressSqlProvider,
} from "./node/event_ingress_repository.js";
import { applyEventSessionEffect } from "./node/event_session_effect_applier.js";
import { createSessionReconciliationSink } from "./node/session_reconciliation_sink.js";
import { createExpoPushProvider } from "./push/expo_push_provider.js";
import {
  PushNotifier,
  SessionForegroundObserverTracker,
  type PushNotificationLogEvent,
} from "./push/push_notifier.js";
import {
  createOrchestratorRuntimeServices,
  type OrchestratorRuntimeServices,
} from "./runtime/composition.js";
import { resolveLiveBoardAssetStorageFromConfig } from "./runtime/live_board_asset_storage.js";
import { OrchestratorMaintenanceService } from "./runtime/orchestrator_maintenance_service.js";
import { createOrchestratorMemoryStatsCollector } from "./runtime/orchestrator_memory_stats.js";
import {
  StableSessionOrderIndexMaintenance,
  startStableSessionOrderIndexMaintenance,
} from "./runtime/stable_session_order_index_maintenance.js";
import { createLiveDbCatalogRepository } from "./runtime/live_db_catalog_repository.js";
import { broadcastCatalogSnapshot } from "./runtime/live_folder_mutation_broadcaster.js";
import { deletedBoardItemsDelta } from "./runtime/catalog_delta_broadcaster.js";
import {
  createLiveDbSqlResolver,
  type LiveDbSqlResolver,
} from "./runtime/live_db_sql.js";
import type { LiveProviderDependencies } from "./runtime/live_provider_dependencies.js";
import {
  createLiveOrchestratorProviderBundle,
  type LiveOrchestratorProviderBundle,
} from "./runtime/live_provider_factory.js";
import { createLivePushRegistrationRepository } from "./runtime/live_push_registration_repository.js";
import { createPageUpdatedEmitter } from "./runtime/page_updated_broadcaster.js";
import { createTaskControlPlaneServiceProvider } from "./tasks/task_control_plane_runtime.js";
import { createScheduleRepositoryProvider } from "./schedule/schedule_host_runtime.js";
import { createFolderControlPlaneServiceProvider } from "./folders/folder_control_plane_runtime.js";
import { createPersistenceHostRepositoryProvider } from "./control_plane/persistence_host_runtime.js";
import type { LiveSystemPortraitAssetBoundary } from "./runtime/live_system_config_route_provider.js";
import { UsageSummaryService } from "./usage/usage_summary_service.js";
import { SessionDeletionRepository } from "./session/session_deletion_repository.js";
import { SessionDeletionService } from "./session/session_deletion_service.js";
import { SessionBoardMoveService } from "./session/session_board_move_service.js";
import {
  createLiveTurnSummaryPipeline,
  type LiveTurnSummaryPipeline,
  type LiveTurnSummaryProductionOverrides,
} from "./turn-summary/live_turn_summary_pipeline.js";
import { resolveCodexCliPath } from "./turn-summary/codex_cli_path.js";

export type ProductionApplication = {
  readonly app: FastifyInstance;
  readonly startBackground: () => Promise<void>;
  readonly closeResources: () => Promise<void>;
};

export type ProductionApplicationFactory = (
  config: OrchServerEnvironmentConfig,
  context: { readonly warn: (message: string) => void },
) => Promise<ProductionApplication>;

export type LiveProductionApplicationOverrides = {
  readonly sqlResolver?: LiveDbSqlResolver;
} & LiveTurnSummaryProductionOverrides;

export type CreateProductionOrchestratorOptions = {
  readonly config: OrchServerEnvironmentConfig;
  readonly applicationFactory?: ProductionApplicationFactory;
  readonly warn?: (message: string) => void;
};

export type ProductionOrchestrator = {
  readonly app: FastifyInstance;
  readonly listen: () => Promise<string>;
  readonly close: () => Promise<void>;
};

export async function createProductionOrchestrator(
  options: CreateProductionOrchestratorOptions,
): Promise<ProductionOrchestrator> {
  const warn = options.warn ?? console.warn;
  const application = await (
    options.applicationFactory ?? createLiveProductionApplication
  )(options.config, { warn });
  await registerDashboardServing(application.app, {
    dashboardDir: options.config.dashboard_dir,
    warn,
  });

  let startAttempted = false;
  let closed = false;
  return {
    app: application.app,
    async listen() {
      if (closed) throw new Error("Production orchestrator is already closed");
      if (startAttempted) throw new Error("Production orchestrator listen() may only run once");
      startAttempted = true;
      try {
        await application.startBackground();
        return await application.app.listen({
          host: options.config.host,
          port: options.config.port,
        });
      } catch (error) {
        await closeApplication(application);
        closed = true;
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeApplication(application);
    },
  };
}

export async function createLiveProductionApplication(
  config: OrchServerEnvironmentConfig,
  context: { readonly warn: (message: string) => void },
  overrides: LiveProductionApplicationOverrides = {},
): Promise<ProductionApplication> {
  const appConfig = toOrchServerTsConfig(config);
  const configProvider = createEnvironmentConfigProvider(config);
  const sqlResolver = overrides.sqlResolver ??
    createLiveDbSqlResolver({ databaseUrl: config.database_url });
  let boardYjsService: BoardYjsService | undefined;
  const boardYjsMoveRepository = new BoardYjsMoveRepository(sqlResolver);
  const sessionBoardMoveService = new SessionBoardMoveService({
    board: {
      async withSessionBoardMoveApplications(input, persist) {
        if (!boardYjsService) throw new Error("Board Yjs service is not initialized");
        return await boardYjsService.withSessionBoardMoveApplications(input, persist);
      },
    },
    repository: boardYjsMoveRepository,
  });
  const sessionDeletionService = new SessionDeletionService({
    board: {
      async withBoardItemRemovalApplications(boardItems, persist) {
        if (!boardYjsService) throw new Error("Board Yjs service is not initialized");
        return await boardYjsService.withBoardItemRemovalApplications(boardItems, persist);
      },
    },
    repository: new SessionDeletionRepository(sqlResolver),
  });
  const persistenceRepositoryProvider = createPersistenceHostRepositoryProvider(
    sqlResolver,
    sessionDeletionService,
  );
  const registry = new InMemoryNodeRegistry();
  const eventIngressRepository = new EventIngressRepository(
    new LiveEventIngressSqlProvider(sqlResolver),
    applyEventSessionEffect,
  );
  const boardYjsRepository = new BoardYjsRepository(sqlResolver);
  const boardProjectionHost = createBoardProjectionHost(sqlResolver, boardYjsRepository);
  const pageRepository = new PageRepository(sqlResolver);
  const taskIdentityRepository = new SqlTaskIdentityRepository(sqlResolver);
  const folderProjectIdentityRepository = new SqlFolderProjectIdentityRepository(sqlResolver);
  const plannerRepository = new PlannerRepository(sqlResolver);
  const boardAssetStorage = await resolveLiveBoardAssetStorageFromConfig(config);
  warnForPartialR2Config(config, context.warn);
  const dbCatalogRepository = createLiveDbCatalogRepository({
    sqlResolver,
    configProvider,
    registry,
    boardAssetStorage,
    sessionDeletion: sessionDeletionService,
    sessionMoves: sessionBoardMoveService,
  });
  const pushRepository = createLivePushRegistrationRepository({ sqlResolver });
  const foregroundObservers = new SessionForegroundObserverTracker();
  let logPushNotification: ((event: PushNotificationLogEvent) => void) | undefined;
  const pushNotifier = new PushNotifier({
    provider: createExpoPushProvider(),
    repository: pushRepository,
    catalog: dbCatalogRepository.folderRouteProvider,
    sessionLookup: (sessionId) =>
      registry.sessionCache.findSession(sessionId)?.payload,
    resolveNodeEmail: (nodeId) =>
      stringValue(registry.getUserInfo(nodeId).email) || config.allowed_email || undefined,
    foregroundObservers,
    onInfo: (event) => logPushNotification?.(event),
    onWarning: (message, error) => context.warn(warningMessage(message, error)),
  });
  let publishReconciledSessionUpdate:
    NonNullable<Parameters<typeof createSessionReconciliationSink>[0]["publishSessionUpdate"]>
      = () => undefined;
  const sessionReconciliation = createSessionReconciliationSink({
    repositoryProvider: async () => (await persistenceRepositoryProvider()).sessionMutations,
    logError: (error, message) => context.warn(`${message}: ${String(error)}`),
    isLeaseAwareNode: (nodeId) =>
      registry.getNodeState(nodeId)?.capabilities.runner_process_v1 === true,
    restoreLeaseGraceOnStartup: config.soul_runner_process_enabled,
    disconnectGraceMs: config.soul_runner_lease_timeout_ms,
    getConnectedNode: (nodeId) => registry.getConnectedNode(nodeId),
    requestSessionInventory: async (nodeId) => {
      const node = registry.getConnectedNode(nodeId);
      if (!node) throw new Error(`node disconnected before inventory request: ${nodeId}`);
      await runtimeServices.sessionBridge.sendFireAndForgetCommand({
        node,
        command: registry.createFireAndForgetCommand(nodeId, {
          type: "list_sessions",
        }),
      });
    },
    publishSessionUpdate: (update) => publishReconciledSessionUpdate(update),
  });
  let providers: LiveOrchestratorProviderBundle;
  let pageYjsService: PageYjsService | undefined;
  let taskIdentityService: TaskIdentityService | undefined;
  let folderProjectIdentityService: FolderProjectIdentityService | undefined;
  let turnSummaryPipeline: LiveTurnSummaryPipeline | undefined;
  const runtimeServices = createOrchestratorRuntimeServices({
    config: appConfig,
    registry,
    eventIngress: eventIngressRepository,
    runnerRegistrationPolicy: {
      leaseAware: config.soul_runner_process_enabled,
      leaseTimeoutMs: config.soul_runner_lease_timeout_ms,
    },
    findSessionOwnerNodeId: dbCatalogRepository.findSessionOwnerNodeId,
    agentProfiles: dbCatalogRepository.agentProfileRepository.snapshot,
    enableSessionActionCommandRoutes: true,
    enableSessionBackgroundScheduleRoutes: true,
    loadSessionSnapshot: async () => dbCatalogRepository.loadSessionSnapshot(),
    sessionHistoryProvider: dbCatalogRepository.sessionHistoryProvider,
    sessionHistoryCloseAfterHistorySync: false,
    sessionForegroundObservers: foregroundObservers,
    additionalNodeEventSinks: [
      (events) => pushNotifier.accept(events),
      (events) => turnSummaryPipeline?.accept(events),
      sessionReconciliation,
    ],
    boardYjsRoutes: {
      createService: (logger) => boardYjsService ??= new BoardYjsService({
        repository: boardYjsRepository,
        logger,
        moveTaskBoardItem: async (input) => {
          if (!taskIdentityService) throw new Error("Task identity service is not initialized");
          return await taskIdentityService.moveBoardItemToContainer(input);
        },
        moveSessionBoardItem: async (input) =>
          await sessionBoardMoveService.moveSessionBoardItem(input),
        persistBoardItemMove: async ({ boardApplications }) =>
          await boardYjsMoveRepository.commitBoardItemMove({ boardApplications }),
        auth: {
          authBearerToken: config.auth_bearer_token,
          environment: config.environment,
          dashboardAuthEnabled: Boolean(config.google_client_id),
          verifyDashboardToken: async (token) =>
            await providers.authRoutes.jwt.verifyToken(token),
        },
      }),
    },
    boardProjectionHost,
    pageYjsRoutes: {
      authBearerToken: config.auth_bearer_token,
      browserReads: pageRepository,
      plannerReads: plannerRepository,
      resolveAgentId: (nodeId, agentId) =>
        resolveRegisteredAgentId(
          registry,
          nodeId,
          agentId,
          dbCatalogRepository.agentProfileRepository.snapshot(),
        ),
      resolveBrowserUser: async (request) =>
        await providers.authenticatedUserResolvers.resolveUser(request),
      createService: (logger) => pageYjsService ??= new PageYjsService({
        repository: pageRepository,
        logger,
        onPageUpdated: createPageUpdatedEmitter(runtimeServices.sessionBroadcaster),
        mutateTaskIdentity: async (input) =>
          await taskIdentityService?.mutateFromPage(input) ?? null,
        mutateProjectIdentity: async (input) =>
          await folderProjectIdentityService?.mutateFromPage(input) ?? null,
        auth: {
          authBearerToken: config.auth_bearer_token,
          environment: config.environment,
          dashboardAuthEnabled: Boolean(config.google_client_id),
          verifyDashboardToken: async (token) =>
            await providers.authRoutes.jwt.verifyToken(token),
        },
      }),
    },
  });
  publishReconciledSessionUpdate = (update) => {
    const node = registry.getConnectedNode(update.nodeId);
    if (!node) return;
    const events = registry.receiveNodeMessage(
      { nodeId: update.nodeId, connectionId: node.connectionId },
      {
        type: "session_updated",
        agentSessionId: update.agentSessionId,
        status: update.status,
        termination_reason: update.terminationReason,
        termination_detail: update.terminationDetail,
        review_state: update.reviewState,
        updated_at: update.updatedAt.toISOString(),
      },
    );
    runtimeServices.routeOptions.nodeWsRoute.eventSink?.(events);
  };
  const memoryStats = createOrchestratorMemoryStatsCollector({
    sessionBroadcaster: runtimeServices.sessionBroadcaster,
    sessionCache: registry.sessionCache,
    registry,
    pushNotifier,
    foregroundObservers,
    boardYjsDocuments: () =>
      boardYjsService?.getStats().activeDocuments ?? 0,
    pageYjsDocuments: () =>
      pageYjsService?.getPersistenceDiagnostics().activeDocuments ?? 0,
  });
  taskIdentityService = new TaskIdentityService({
    board: {
      async withTaskBoardApplication(input, persist) {
        if (!boardYjsService) throw new Error("Board Yjs service is not initialized");
        return await boardYjsService.withTaskBoardApplication(input, persist);
      },
      async withTaskBoardMoveApplication(input, persist) {
        if (!boardYjsService) throw new Error("Board Yjs service is not initialized");
        return await boardYjsService.withTaskBoardMoveApplication(input, persist);
      },
    },
    repository: taskIdentityRepository,
    hydratePage: async (pageId) => {
      if (!pageYjsService) throw new Error("Page Yjs service is not initialized");
      await pageYjsService.hydrateCommittedPage(`page:${pageId}`);
    },
    resolveAgentId: (nodeId, agentId) =>
      resolveRegisteredAgentId(
        registry,
        nodeId,
        agentId,
        dbCatalogRepository.agentProfileRepository.snapshot(),
      ),
    onPageUpdated: createPageUpdatedEmitter(runtimeServices.sessionBroadcaster),
  });
  const dependencies: LiveProviderDependencies = {
    dbCatalogRepository,
    nodeHttpClient: runtimeServices.nodeHttpClient,
    pushRepository,
    configProvider,
    systemPortraitAssets: createSystemPortraitAssets(),
  };
  const usageSummaryService = new UsageSummaryService({
    registry: runtimeServices.registry,
    bridge: runtimeServices.sessionBridge,
    pollIntervalMs: config.usage_summary_poll_interval_seconds * 1_000,
    onWarning: (message, error) => context.warn(warningMessage(message, error)),
  });
  try {
    providers = createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
      usageSummaryRoutes: { service: usageSummaryService },
    });
  } catch (error) {
    await dbCatalogRepository.close();
    throw error;
  }
  folderProjectIdentityService = new FolderProjectIdentityService({
    repository: folderProjectIdentityRepository,
    hydratePage: async (pageId) => {
      if (!pageYjsService) throw new Error("Page Yjs service is not initialized");
      await pageYjsService.hydrateCommittedPage(`page:${pageId}`);
    },
    onCommitted: async (delta) => {
      await broadcastCatalogSnapshot(
        providers.folderRoutes.provider,
        runtimeServices.sessionBroadcaster,
        delta
          ? {
              sessionsDelta: delta.sessionsDelta,
              boardItemsDelta: deletedBoardItemsDelta(delta.deletedBoardItemIds),
            }
          : {},
      );
    },
    onPageUpdated: createPageUpdatedEmitter(runtimeServices.sessionBroadcaster),
  });
  const ephemeralProcessEnv = overrides.turnSummaryProcessEnv ?? process.env;
  const ephemeralCodexPath = overrides.turnSummaryCodexPath ??
    resolveCodexCliPath(ephemeralProcessEnv)?.path;
  const ephemeralLlmRoutes: EphemeralLlmRouteOptions = {
    authBearerToken: appConfig.authBearerToken,
    generator: new CodexEphemeralExecutor({
      ...(ephemeralCodexPath === undefined ? {} : { codexPath: ephemeralCodexPath }),
      processEnv: ephemeralProcessEnv,
    }),
  };
  const app = createApp(buildProductionRouteOptions(
    appConfig,
    runtimeServices,
    providers,
    config.cors_allowed_origins,
    taskIdentityService,
    folderProjectIdentityService,
    memoryStats,
    ephemeralLlmRoutes,
    createTaskControlPlaneServiceProvider({
      sqlResolver,
      broadcaster: runtimeServices.sessionBroadcaster,
    }),
    createScheduleRepositoryProvider(sqlResolver),
    createFolderControlPlaneServiceProvider(sqlResolver),
    persistenceRepositoryProvider,
  ));
  logPushNotification = (event) => {
    app.log.info(
      { pushNotification: event },
      event.action === "sent" ? "Push notification sent" : "Push notification suppressed",
    );
  };
  turnSummaryPipeline = createLiveTurnSummaryPipeline({
    config,
    configPath: overrides.turnSummaryConfigPath ??
      fileURLToPath(new URL("../config/turn-summary.yaml", import.meta.url)),
    sqlResolver,
    registry,
    agentProfiles: dbCatalogRepository.agentProfileRepository.snapshot,
    eventHub: runtimeServices.sessionEventHub,
    sessionBroadcaster: runtimeServices.sessionBroadcaster,
    logger: app.log,
    warn: context.warn,
    overrides,
  });
  const maintenanceService = new OrchestratorMaintenanceService({
    sessionCache: registry.sessionCache,
    pushNotifier,
    memoryStats,
    onInfo: (event) => {
      app.log.info({ runtimeMemory: event }, "Orchestrator runtime memory");
    },
    onWarning: (event) => {
      app.log.warn(
        { runtimeMemory: event },
        "Orchestrator runtime memory RSS threshold exceeded",
      );
    },
  });
  const stableSessionOrderIndexMaintenance =
    new StableSessionOrderIndexMaintenance(sqlResolver);
  let resourcesClosed = false;
  return {
    app,
    startBackground: async () => {
      await sessionReconciliation.start();
      await dbCatalogRepository.agentProfileRepository.list();
      startStableSessionOrderIndexMaintenance(
        stableSessionOrderIndexMaintenance,
        app.log,
      );
      usageSummaryService.start();
      maintenanceService.start();
      turnSummaryPipeline?.start?.();
    },
    async closeResources() {
      if (resourcesClosed) return;
      resourcesClosed = true;
      maintenanceService.stop();
      await sessionReconciliation.close();
      await usageSummaryService.stop();
      await turnSummaryPipeline?.drain();
      await pushNotifier.close();
      await dbCatalogRepository.close();
    },
  };
}

function warningMessage(message: string, error: unknown): string {
  if (error instanceof Error && error.message) return `${message}: ${error.message}`;
  return error === undefined ? message : `${message}: ${String(error)}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function buildProductionRouteOptions(
  config: CreateAppOptions["config"],
  runtime: OrchestratorRuntimeServices,
  providers: LiveOrchestratorProviderBundle,
  corsAllowedOrigins: readonly string[] = [],
  taskIdentityService?: TaskIdentityService,
  folderProjectIdentityService?: FolderProjectIdentityService,
  memoryStats?: ReturnType<typeof createOrchestratorMemoryStatsCollector>,
  ephemeralLlmRoutes?: EphemeralLlmRouteOptions,
  taskControlPlaneServiceProvider?: NonNullable<CreateAppOptions["taskRoutes"]>["taskControlPlaneServiceProvider"],
  scheduleRepositoryProvider?: NonNullable<CreateAppOptions["scheduleHostRoutes"]>["repositoryProvider"],
  folderControlPlaneServiceProvider?: NonNullable<CreateAppOptions["folderRoutes"]>["controlPlaneServiceProvider"],
  persistenceRepositoryProvider?: NonNullable<CreateAppOptions["persistenceHostRoutes"]>["repositoryProvider"],
): CreateAppOptions {
  return {
    config,
    corsAllowedOrigins,
    productionAuth: {
      resolveTokenAccess: providers.authRoutes.resolveTokenAccess,
    },
    adminUsersRoutes: providers.adminUsersRoutes,
    atomRoutes: providers.atomRoutes,
    authRoutes: providers.authRoutes,
    attachmentRoutes: providers.attachmentRoutes,
    boardAssetRoutes: providers.boardAssetRoutes,
    boardItemRoutes: {
      ...providers.boardItemRoutes,
      hostProxy: providers.runtime.boardYjsHostProxyRoutes,
    },
    boardYjsHostProxyRoutes: providers.runtime.boardYjsHostProxyRoutes,
    boardYjsRoutes: runtime.routeOptions.boardYjsRoutes,
    pageYjsRoutes: runtime.routeOptions.pageYjsRoutes,
    cogitoRoutes: providers.cogitoRoutes,
    executeProxyRoutes: providers.executeProxyRoutes,
    ...(ephemeralLlmRoutes === undefined ? {} : { ephemeralLlmRoutes }),
    folderRoutes: {
      ...providers.folderRoutes,
      authBearerToken: config.authBearerToken,
      ...(folderProjectIdentityService
        ? { projectIdentityService: folderProjectIdentityService }
        : {}),
      ...(folderControlPlaneServiceProvider
        ? { controlPlaneServiceProvider: folderControlPlaneServiceProvider }
        : {}),
    },
    markdownDocumentRoutes: {
      ...providers.markdownDocumentRoutes,
      hostProxy: providers.runtime.boardYjsHostProxyRoutes,
    },
    nodeAgentProfileRoutes: providers.nodeAgentProfileRoutes,
    agentProfileRoutes: providers.agentProfileRoutes,
    nodeClaudeAuthRoutes: {
      ...providers.nodeClaudeAuthRoutes,
      registry: runtime.registry,
      bridge: runtime.sessionBridge,
    },
    nodeSnapshotRoutes: providers.runtime.nodeSnapshotRoutes,
    nodeWsRoute: providers.runtime.nodeWsRoute,
    publicStatusRoutes: {
      ...providers.publicStatusRoutes,
      configProvider: providers.configProviders.publicStatusRoutes.configProvider,
    },
    pushRoutes: providers.pushRoutes,
    taskRoutes: {
      ...providers.taskRoutes,
      authBearerToken: config.authBearerToken,
      ...(taskIdentityService ? { taskIdentityService } : {}),
      ...(taskControlPlaneServiceProvider ? { taskControlPlaneServiceProvider } : {}),
    },
    ...(scheduleRepositoryProvider
      ? {
          scheduleHostRoutes: {
            repositoryProvider: scheduleRepositoryProvider,
            authBearerToken: config.authBearerToken,
          },
        }
      : {}),
    ...(persistenceRepositoryProvider
      ? {
          persistenceHostRoutes: {
            repositoryProvider: persistenceRepositoryProvider,
            authBearerToken: config.authBearerToken,
          },
        }
      : {}),
    sessionActionCommandRoutes: providers.runtime.sessionActionCommandRoutes,
    sessionBackgroundScheduleRoutes:
      providers.runtime.sessionBackgroundScheduleRoutes,
    sessionCatalogRoutes: providers.sessionCatalogRoutes,
    sessionCommandRoutes: providers.runtime.sessionCommandRoutes,
    sessionHistoryRoutes: providers.runtime.sessionHistoryRoutes,
    sessionSnapshotRoutes: providers.runtime.sessionSnapshotRoutes,
    sseReplayRoutes: providers.runtime.sseReplayRoutes,
    systemConfigRoutes: providers.systemConfigRoutes,
    ...(memoryStats === undefined
      ? {}
      : {
          runtimeMemoryRoutes: {
            accessProvider: providers.adminUsersRoutes.provider,
            stats: memoryStats,
          },
        }),
    userBackgroundRoutes: providers.userBackgroundRoutes,
    userPreferencesRoutes: providers.userPreferencesRoutes,
    usageSummaryRoutes: providers.usageSummaryRoutes,
  };
}

async function closeApplication(application: ProductionApplication): Promise<void> {
  let appCloseError: unknown;
  try {
    await application.app.close();
  } catch (error) {
    appCloseError = error;
  }
  try {
    await application.closeResources();
  } catch (resourceError) {
    if (appCloseError !== undefined) {
      throw new AggregateError(
        [appCloseError, resourceError],
        "Failed to close production orchestrator",
      );
    }
    throw resourceError;
  }
  if (appCloseError !== undefined) throw appCloseError;
}

function warnForPartialR2Config(
  config: OrchServerEnvironmentConfig,
  warn: (message: string) => void,
): void {
  const values = [
    config.r2_board_assets_access_key_id,
    config.r2_board_assets_secret_access_key,
    config.r2_board_assets_bucket,
    config.r2_board_assets_endpoint,
  ];
  if (values.some(Boolean) && !values.every(Boolean)) {
    warn("Board asset R2 storage is partially configured; asset uploads are disabled");
  }
}

function createSystemPortraitAssets(): LiveSystemPortraitAssetBoundary {
  const portraitUrl = new URL(
    "../../packages/soul-common/src/soul_common/portraits/",
    import.meta.url,
  );
  return {
    async readSystemPortraitAsset(filename) {
      try {
        return await readFile(new URL(filename, portraitUrl));
      } catch (error) {
        if (isMissingFileError(error)) return undefined;
        throw error;
      }
    },
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
