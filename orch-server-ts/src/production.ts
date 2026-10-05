import { SqlOwnedAgentRepository } from "./owned-agents/repository.js";
import { OwnedAgentService } from "./owned-agents/service.js";
import { createSessionOwnerResolver } from "./session/session_owner.js";
import { ExternalEventsService, credentialOwner } from "./external_events/service.js";
import type { McpHostOptions } from "./mcp/types.js";
import {OrchestratorLifecycle,readDashboardBuildId} from "./runtime/orchestrator_lifecycle.js";
import { serviceTokenAccessWithoutEmail } from "./runtime/live_dashboard_access_provider.js";
import type { SqlClient } from "./control_plane/control_plane_types.js";
// 500줄 예외: 프로덕션 composition root의 단일 조립 순서를 한 파일에서 검증한다.
// 도메인 동작은 각 service/repository 모듈에 있고, 이 파일은 연결만 소유한다.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";

import { createApp, type CreateAppOptions } from "./app.js";
import { BoardYjsRepository } from "./board-yjs/board_yjs_repository.js";
import { BoardYjsMoveRepository } from "./board-yjs/board_yjs_move_repository.js";
import { BoardYjsService } from "./board-yjs/board_yjs_service.js";
import type { CatalogBoardItemRow } from "./board-yjs/board_yjs_types.js";
import { createBoardProjectionHost } from "./board-yjs/board_projection_host.js";
import { PageRepository } from "./page/page_repository.js";
import { PageYjsService } from "./page/page_service.js";
import { SqlFolderProjectIdentityRepository } from "./folders/folder_project_identity_repository.js";
import { FolderProjectIdentityService } from "./folders/folder_project_identity_service.js";
import { PlannerRepository } from "./planner/planner_repository.js";
import {
  createEnvironmentConfigProvider,
  type OrchServerEnvironmentConfig,
  toOrchServerTsConfig,
} from "./config.js";
import { registerDashboardServing } from "./dashboard/dashboard_serving.js";
import { CodexEphemeralExecutor } from "./llm/codex_ephemeral_executor.js";
import type { EphemeralLlmRouteOptions } from "./llm/ephemeral_llm_routes.js";
import { InMemoryNodeRegistry, type NodeRegistryEvent } from "./node/registry.js";
import { resolveRegisteredAgentId } from "./node/agent_profile_lookup.js";
import {
  EventIngressRepository,
  LiveEventIngressSqlProvider,
} from "./node/event_ingress_repository.js";
import { FileEventIngressDeadLetterStore } from "./node/event_ingress_dead_letter_store.js";
import { applyEventSessionEffect } from "./node/event_session_effect_applier.js";
import { applyEventFeedProjection } from "./node/event_feed_projection_applier.js";
import { createSessionReconciliationSink } from "./node/session_reconciliation_sink.js";
import { runnerInventoryCommandType } from "./node/registry_helpers.js";
import { createSessionCacheSeedSink } from "./node/session_cache_seed_sink.js";
import { ReleaseActivationReceiptRepository } from "./node/release_activation_receipt_repository.js";
import { createExpoPushProvider } from "./push/expo_push_provider.js";
import {
  LiveDatabaseSchemaProvider,
  type PublicDatabaseSchemaProvider,
} from "./public/database_schema_provider.js";
import {
  PushNotifier,
  SessionForegroundObserverTracker,
  type PushNotificationLogEvent,
} from "./push/push_notifier.js";
import {
  createOrchestratorRuntimeServices,
  type OrchestratorRuntimeServices,
} from "./runtime/composition.js";
import { createR2StorageResolver } from "./runtime/r2_storage_resolver.js";
import { readR2Settings, updateR2Settings } from "./system/r2_settings.js";
import { OrchestratorMaintenanceService } from "./runtime/orchestrator_maintenance_service.js";
import { createOrchestratorMemoryStatsCollector } from "./runtime/orchestrator_memory_stats.js";
import {
  StableSessionOrderIndexMaintenance,
  startStableSessionOrderIndexMaintenance,
} from "./runtime/stable_session_order_index_maintenance.js";
import { createLiveDbCatalogRepository } from "./runtime/live_db_catalog_repository.js";
import { broadcastCatalogSnapshot } from "./runtime/live_folder_mutation_broadcaster.js";
import { broadcastTargetedSessionCatalogDelta } from
  "./runtime/live_session_catalog_mutation_broadcaster.js";
import { deletedBoardItemsDelta } from "./runtime/catalog_delta_broadcaster.js";
import {
  createLiveSearchDbConnectionFactory,
  createLiveDbSqlResolver,
  type LiveDbSqlResolver,
} from "./runtime/live_db_sql.js";
import type { LiveProviderDependencies } from "./runtime/live_provider_dependencies.js";
import {
  createLiveOrchestratorProviderBundle,
  type LiveOrchestratorProviderBundle,
} from "./runtime/live_provider_factory.js";
import { createLivePushRegistrationRepository } from "./runtime/live_push_registration_repository.js";
import { createLiveUiEventRepository } from "./runtime/live_ui_event_repository.js";
import { createPageUpdatedEmitter } from "./runtime/page_updated_broadcaster.js";
import { createCardOrchestrationAccess } from "./cards/card_orchestration_access.js";
import { createCardDispatchRuntime } from "./cards/card_dispatch_runtime.js";
import type { CardDispatcher } from "./cards/card_dispatcher.js";
import { createScheduleRepositoryProvider } from "./schedule/schedule_host_runtime.js";
import { createFolderControlPlaneServiceProvider } from "./folders/folder_control_plane_runtime.js";
import { createPersistenceHostRepositoryProvider } from "./control_plane/persistence_host_runtime.js";
import { SqlRecurringJobRepository } from "./recurring-jobs/repository.js";
import { RecurringJobService } from "./recurring-jobs/service.js";
import { RecurringJobScheduler } from "./recurring-jobs/scheduler.js";
import { createProductionRecurringJobWiring } from "./recurring-jobs/production_wiring.js";
import { createRecurringJobTargetValidator } from "./recurring-jobs/target_validator.js";
import { createRecurringSession } from "./session/recurring_session_creation.js";
import type { SessionDeliveryRepository } from
  "./control_plane/repositories/session_delivery_repository.js";
import type { LiveSystemPortraitAssetBoundary } from "./runtime/live_system_config_route_provider.js";
import { UsageSummaryService } from "./usage/usage_summary_service.js";
import { SessionDeletionRepository } from "./session/session_deletion_repository.js";
import { SessionDeletionService } from "./session/session_deletion_service.js";
import { SessionBoardMoveService } from "./session/session_board_move_service.js";
import { intervenePayload } from "./session/session_action_command_payloads.js";
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
  readonly beginShutdown?: () => Promise<void>;
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
  const startupWarnings: string[] = [];
  let warningSink: (message: string) => void = options.warn
    ?? ((message) => startupWarnings.push(message));
  const warn = (message: string) => warningSink(message);
  if (options.config.dashboard_user_folder_access_configured) {
    warn(
      "DASHBOARD_USER_FOLDER_ACCESS is configured but not enforced; manage folder permissions through the users table.",
    );
  }
  const application = await (
    options.applicationFactory ?? createLiveProductionApplication
  )(options.config, { warn });
  if (options.warn === undefined) {
    warningSink = (message) => application.app.log.warn(message);
    for (const message of startupWarnings) warningSink(message);
  }
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
  const buildId=await readDashboardBuildId(config.dashboard_dir,config.environment);
  const appConfig = toOrchServerTsConfig(config);
  const configProvider = createEnvironmentConfigProvider(config);
  const sqlResolver = overrides.sqlResolver ??
    createLiveDbSqlResolver({ databaseUrl: config.database_url });
  const searchDbConnectionFactory = createLiveSearchDbConnectionFactory({
    databaseUrl: config.database_url,
  });
  const reportSearchCancelError = (error: unknown) => {
    context.warn(`Search database cancellation failed; closing request-owned connection: ${String(error)}`);
  };
  let boardYjsService: BoardYjsService | undefined;
  let emitBoardYjsSessionCatalogDelta:
    | ((sessionIds: readonly string[], movedBoardItem: CatalogBoardItemRow | null) => Promise<void>)
    | undefined;
  const boardYjsMoveRepository = new BoardYjsMoveRepository(sqlResolver);
  const sessionBoardMoveService = new SessionBoardMoveService({
    board: {
      async withSessionBoardMoveApplications(input, persist) {
        if (!boardYjsService) throw new Error("Board Yjs service is not initialized");
        return await boardYjsService.withSessionBoardMoveApplications(input, persist);
      },
    },
    repository: boardYjsMoveRepository,
    // Board/Yjs owns this post-commit emission. REST calls moveSessionToFolder instead,
    // whose route wrapper remains its single catalog-delta owner.
    onFoldersMoveCommitted: async (folderIds) => {
      for (const folderId of folderIds) runtimeServices.sessionBroadcaster.append({type:"folder_updated",folderId});
    },
    onCardsMoveCommitted: async (cards) => {
      for (const card of cards) {
        runtimeServices.sessionBroadcaster.append({type:"card_updated",cardId:card.cardId,folderId:card.sourceFolderId});
        runtimeServices.sessionBroadcaster.append({type:"card_updated",cardId:card.cardId,folderId:card.folderId});
      }
    },
    onBoardMoveCommitted: async ({ sessionIds, movedBoardItem }) => {
      if (!emitBoardYjsSessionCatalogDelta) {
        throw new Error("Board/Yjs catalog delta emitter is not initialized");
      }
      await emitBoardYjsSessionCatalogDelta(sessionIds, movedBoardItem);
    },
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
    searchDbConnectionFactory,
    reportSearchCancelError,
  );
  const recurringJobRepository = new SqlRecurringJobRepository(sqlResolver);
  const registry = new InMemoryNodeRegistry();
  const eventIngressRepository = new EventIngressRepository(
    new LiveEventIngressSqlProvider(sqlResolver),
    applyEventSessionEffect,
    new FileEventIngressDeadLetterStore(resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      ".local",
      "event-ingress-dead-letter",
    )),
    {},
    applyEventFeedProjection,
  );
  const boardYjsRepository = new BoardYjsRepository(sqlResolver);
  const boardProjectionHost = createBoardProjectionHost(sqlResolver, boardYjsRepository);
  const pageRepository = new PageRepository(sqlResolver);
  const folderProjectIdentityRepository = new SqlFolderProjectIdentityRepository(sqlResolver);
  const plannerRepository = new PlannerRepository(sqlResolver);

  if (!config.typesafe_api_key) {
    context.warn("TYPESAFE_API_KEY is not configured; expanded session search will return partial results.");
  }
  const dbCatalogRepository = createLiveDbCatalogRepository({
    sqlResolver,
    searchDbConnectionFactory,
    configProvider,
    registry,
    typesafeApiKey: config.typesafe_api_key,
    onSearchCancelError: reportSearchCancelError,
    sessionDeletion: sessionDeletionService,
    sessionMoves: sessionBoardMoveService,
  });
  const pushRepository = createLivePushRegistrationRepository({ sqlResolver });
  const uiEventRepository = createLiveUiEventRepository({ sqlResolver });
  const foregroundObservers = new SessionForegroundObserverTracker();
  const sessionCacheSeed = createSessionCacheSeedSink({
    registry,
    repository: dbCatalogRepository,
    logError: (error, message) => context.warn(`${message}: ${String(error)}`),
    onNodeReady: async (nodeId, connectionId) =>
      await replayPendingImmediateDeliveriesForNode({
        nodeId,
        connectionId,
        deliveries: (await persistenceRepositoryProvider()).deliveries,
        sessionRouter: runtimeServices.sessionRouter,
        sessionBridge: runtimeServices.sessionBridge,
        warn: context.warn,
      }),
  });
  let logPushNotification: ((event: PushNotificationLogEvent) => void) | undefined;
  const pushNotifier = new PushNotifier({
    provider: createExpoPushProvider(),
    repository: pushRepository,
    catalog: dbCatalogRepository.folderRouteProvider,
    sessionLookup: (sessionId) =>
      registry.sessionCache.findSession(sessionId)?.payload,
    loadSessionReviewState: (sessionId) =>
      dbCatalogRepository.loadSessionReviewState(sessionId),
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
    requestSessionInventory: async (nodeId, connectionId) => {
      const node = registry.getConnectedNode(nodeId);
      if (!node || node.connectionId !== connectionId) {
        throw new Error(`node connection changed before inventory request: ${nodeId}`);
      }
      const command = registry.createCommand(nodeId, {
        type: runnerInventoryCommandType(node.capabilities),
      });
      const response = await runtimeServices.sessionBridge.sendPendingCommand({ node, command });
      const runningSessionIds = response.running_session_ids;
      if (response.requestId !== command.requestId
        || (response.type !== "runner_inventory" && response.type !== "sessions_update")
        || !Array.isArray(runningSessionIds)
        || !runningSessionIds.every((value): value is string => typeof value === "string")) {
        throw new Error(`invalid inventory response for ${nodeId}/${command.requestId}`);
      }
      return { requestId: command.requestId, runningSessionIds };
    },
    publishSessionUpdate: (update) => publishReconciledSessionUpdate(update),
  });
  let providers: LiveOrchestratorProviderBundle;
  let pageYjsService: PageYjsService | undefined;
  let folderProjectIdentityService: FolderProjectIdentityService | undefined;
  let turnSummaryPipeline: LiveTurnSummaryPipeline | undefined;
  let recurringJobScheduler: RecurringJobScheduler | undefined;
  let cardDispatcher: CardDispatcher | undefined;
  const runtimeServices = createOrchestratorRuntimeServices({
    config: appConfig,
    registry,
    eventIngress: eventIngressRepository,
    releaseActivationReceipts: new ReleaseActivationReceiptRepository(sqlResolver),
    findSessionOwnerNodeId: dbCatalogRepository.findSessionOwnerNodeId,
    findRescuableSessionOwnerNodeId:
      dbCatalogRepository.findRescuableSessionOwnerNodeId,
    agentProfiles: dbCatalogRepository.agentProfileRepository.snapshot,
    enableSessionActionCommandRoutes: true,
    enableSessionBackgroundScheduleRoutes: true,
    loadSessionSnapshot: async () => dbCatalogRepository.loadSessionSnapshot(),
    sessionHistoryProvider: dbCatalogRepository.sessionHistoryProvider,
    sessionHistoryCloseAfterHistorySync: false,
    sessionForegroundObservers: foregroundObservers,
    onNodeEventSinkError: (error, sinkIndex) =>
      context.warn(
        `node registry event sink ${sinkIndex + 1} failed: ${String(error)}`,
      ),
    additionalNodeEventSinks: [
      sessionCacheSeed,
      sessionReconciliation,
      (events) => pushNotifier.accept(events),
      (events) => turnSummaryPipeline?.accept(events),
      (events) => recurringJobScheduler?.accept(events),
      (events) => cardDispatcher?.accept(events),
    ],
    boardYjsRoutes: {
      createService: (logger) => boardYjsService ??= new BoardYjsService({
        repository: boardYjsRepository,
        logger,
        moveSessionBoardItem: async (input) =>
          await sessionBoardMoveService.moveSessionBoardItem(input),
        persistBoardItemMove: async ({ boardApplications }) =>
          await boardYjsMoveRepository.commitBoardItemMove({ boardApplications }),
        auth: {
          authBearerToken: config.auth_bearer_token,
          environment: config.environment,
          dashboardAuthEnabled: Boolean(config.google_client_id),
          resolveDashboardUserFromHeaders: (headers) =>
            providers.authenticatedUserResolvers.resolveUserFromHeaders(headers),
        },
      }),
    },
    boardProjectionHost,
    pageYjsRoutes: {
      authBearerToken: config.auth_bearer_token,
      browserReads: pageRepository,
      plannerReads: plannerRepository,
      starredFolderOrder: plannerRepository,
      onPageUpdated: ({ pageId, version }) => {
        runtimeServices.sessionBroadcaster.append({
          type: "page_updated",
          page_id: pageId,
          version,
        });
      },
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
        mutateFolderIdentity: async (input) =>
          await folderProjectIdentityService?.mutateFromPage(input) ?? null,
        auth: {
          authBearerToken: config.auth_bearer_token,
          environment: config.environment,
          dashboardAuthEnabled: Boolean(config.google_client_id),
          resolveDashboardUserFromHeaders: (headers) =>
            providers.authenticatedUserResolvers.resolveUserFromHeaders(headers),
        },
      }),
    },
  });
  emitBoardYjsSessionCatalogDelta = async (sessionIds, movedBoardItem) =>
    await broadcastTargetedSessionCatalogDelta(
      dbCatalogRepository.folderRouteProvider,
      runtimeServices.sessionBroadcaster,
      sessionIds,
      movedBoardItem ? { [movedBoardItem.id]: movedBoardItem } : {},
    );
  publishReconciledSessionUpdate = (update) => {
    const message = {
      type: "session_updated",
      agentSessionId: update.agentSessionId,
      status: update.status,
      termination_reason: update.terminationReason,
      termination_detail: update.terminationDetail,
      review_state: update.reviewState,
      updated_at: update.updatedAt.toISOString(),
    };
    registry.sessionCache.patchReconciledSessionStatus({
      nodeId: update.nodeId,
      agentSessionId: update.agentSessionId,
      status: update.status,
      nowMs: update.updatedAt.getTime(),
    });
    const events: NodeRegistryEvent[] = [{
      type: "node_session_session_updated",
      nodeId: update.nodeId,
      data: message,
    }];
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
    sharedAccountGroups: config.usage_summary_shared_accounts,
    onCollected: () => { void cardDispatcher?.dispatch(); },
    onWarning: (message, error) => context.warn(warningMessage(message, error)),
  });
  try {
    providers = createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
      uiEventRepository,
      usageSummaryRoutes: { service: usageSummaryService },
      resolveAttachmentStorage: () => createR2StorageResolver(
        async () => await sqlResolver.resolveSql() as unknown as SqlClient,
      ).resolveBinding("attachment"),
    });
  } catch (error) {
    await dbCatalogRepository.close();
    throw error;
  }
  folderProjectIdentityService = new FolderProjectIdentityService({
    repository: folderProjectIdentityRepository,
    withBoardApplication: async (input, persist) => {
      if (!boardYjsService) throw new Error("Board service is not initialized");
      return await boardYjsService.withFolderBoardApplication(input, persist);
    },
    hydratePage: async (pageId) => {
      if (!pageYjsService) throw new Error("Page Yjs service is not initialized");
      await pageYjsService.hydrateCommittedPage(`page:${pageId}`);
    },
    onCommitted: async () => {
      await broadcastCatalogSnapshot(providers.folderRoutes.provider, runtimeServices.sessionBroadcaster);
    },
    onPageUpdated: createPageUpdatedEmitter(runtimeServices.sessionBroadcaster),
  });
  const ephemeralProcessEnv = overrides.turnSummaryProcessEnv ?? process.env;
  const ephemeralCodexPath = overrides.turnSummaryCodexPath ??
    resolveCodexCliPath(config.codex_cli_path, ephemeralProcessEnv)?.path;
  const ephemeralLlmRoutes: EphemeralLlmRouteOptions = {
    authBearerToken: appConfig.authBearerToken,
    generator: new CodexEphemeralExecutor({
      ...(ephemeralCodexPath === undefined ? {} : { codexPath: ephemeralCodexPath }),
      processEnv: ephemeralProcessEnv,
    }),
  };
  const ownedAgentRepository = new SqlOwnedAgentRepository(sqlResolver);
  const ownedAgentService = new OwnedAgentService(ownedAgentRepository,
    dbCatalogRepository.adminUsersRepository.findUserByEmail, config.mcp_external_ingress_bearer_token);
  const resolveSessionOwner = createSessionOwnerResolver({
    getSession: async id => (await persistenceRepositoryProvider()).sessionReads.getSession(id),
    findUserByEmail: dbCatalogRepository.adminUsersRepository.findUserByEmail,
    findExternalAgent: ownedAgentService.findAgent,
  });
  const orchestrationAccess = createCardOrchestrationAccess({
    getSession: async id => (await persistenceRepositoryProvider()).sessionReads.getSession(id),
    listFolders: async () => providers.folderRoutes.provider.listFolders(),
    findUserByEmail: dbCatalogRepository.adminUsersRepository.findUserByEmail,
  });
  const cardDispatchRuntime=await createCardDispatchRuntime({sqlResolver,router:runtimeServices.sessionRouter,bridge:runtimeServices.sessionBridge,
    availability:providers.modelPresetAvailability,notifier:pushNotifier,admin:providers.adminUsersRoutes.provider,
    broadcaster:runtimeServices.sessionBroadcaster,warn:context.warn,
    usageSnapshot: () => usageSummaryService.getSummary(),
    validateFolder: orchestrationAccess.validateFolder,
    ensureSystemFolder: async input => {
      if (!folderProjectIdentityService) throw new Error("Folder identity service is unavailable");
      await folderProjectIdentityService.create({
        name: "⚙️ 작업 배정 · 시스템",reservedId:input.reservedId,parentFolderId:input.parentFolderId,
        actor:{actorKind:"system",actorSessionId:null,actorUserId:null},idempotencyKey:input.idempotencyKey,
      });
    },
    onFolderHeaderUpdated:()=>broadcastCatalogSnapshot(providers.folderRoutes.provider,runtimeServices.sessionBroadcaster)});
  cardDispatcher=cardDispatchRuntime.dispatcher;
  const recurringJobService = new RecurringJobService({
    repository: recurringJobRepository,
    validateTarget: createRecurringJobTargetValidator({
      registry,
      modelPresetAvailability: providers.modelPresetAvailability,
      listFolders: providers.folderRoutes.provider.listFolders,
      findUserByEmail: dbCatalogRepository.adminUsersRepository.findUserByEmail,
    }),
    launcher: {
      isNodeConnected: (nodeId) => registry.getConnectedNode(nodeId) !== undefined,
      createRecurringSession: async ({ job, run }) => await createRecurringSession({
        router: runtimeServices.sessionRouter,
        bridge: runtimeServices.sessionBridge,
        modelPresetAvailability: providers.modelPresetAvailability,
      }, {
        sessionId: run.sessionId,
        prompt: job.prompt,
        nodeId: job.nodeId,
        agentId: job.agentId,
        modelPreset: job.modelPreset,
        folderId: job.folderId,
        callerInfo: job.executionCaller,
      }),
      findDurableSession: async (sessionId) => {
        const row = await (await persistenceRepositoryProvider()).sessionReads.getSession(sessionId);
        if (!row) return null;
        const rawStatus = row.status;
        return {
          status: rawStatus === "completed" || rawStatus === "error" || rawStatus === "interrupted"
            ? rawStatus
            : "running",
        };
      },
    },
  });
  const recurringJobWiring = createProductionRecurringJobWiring({
    service: recurringJobService,
    repository: recurringJobRepository,
    authenticatedUserResolvers: providers.authenticatedUserResolvers,
    authBearerToken: config.auth_bearer_token,
    environment: config.environment,
    onError: (error, operation) => context.warn(warningMessage(`recurring jobs ${operation}`, error)),
    onTick:()=>cardDispatchRuntime.dispatcher.tick(),
  });
  recurringJobScheduler = recurringJobWiring.scheduler;
  const externalEvents = config.mcp_external_events_state_file ? await ExternalEventsService.open({
    path: config.mcp_external_events_state_file, owner: credentialOwner(config.mcp_external_ingress_path!, config.mcp_external_ingress_bearer_token!),
  }) : undefined;
  const lifecycle=new OrchestratorLifecycle(buildId,runtimeServices.sessionBroadcaster);
  const app = createApp({
    externalEvents,
    ownedAgentRoutes: { currentEmail: providers.adminUsersRoutes.provider.currentEmail, service: ownedAgentService },
    resolveSessionOwner,
    ...(config.mcp_external_ingress_enabled ? { externalIngress: {
      path: config.mcp_external_ingress_path!, nodeId: config.node_name!, source: config.mcp_external_ingress_source!,
      displayName: config.mcp_external_ingress_display_name!, ownedAgents: ownedAgentService,
      auth: { requireAuth: true, bearerToken: config.mcp_external_ingress_bearer_token!, allowedHosts: config.mcp_allowed_hosts! },
    } } : {}),
    ...buildProductionRouteOptions(
      appConfig,
      runtimeServices,
      providers,
      persistenceRepositoryProvider,
      config.cors_allowed_origins,
      folderProjectIdentityService,
      memoryStats,
      ephemeralLlmRoutes,
      cardDispatchRuntime.serviceProvider,
      createScheduleRepositoryProvider(sqlResolver),
      createFolderControlPlaneServiceProvider(sqlResolver),
      new LiveDatabaseSchemaProvider(sqlResolver),
      { enabled: config.atom_enabled, serverUrl: config.atom_server_url, apiKey: config.atom_api_key,
        nodeId: config.skill_catalog_node_id, typesafeApiKey: config.typesafe_api_key, httpClient: providers.atomRoutes.httpClient },
      cardDispatchRuntime.executionServiceProvider,
      lifecycle,
    ),
    r2SettingsRoutes: {
      currentEmail: providers.adminUsersRoutes.provider.currentEmail,
      isAdminEmail: providers.adminUsersRoutes.provider.isAdminEmail,
      getSettings: async purpose => readR2Settings(await sqlResolver.resolveSql() as unknown as SqlClient, purpose),
      updateSettings: async (purpose, input) => updateR2Settings(await sqlResolver.resolveSql() as unknown as SqlClient, purpose, input),
      check: createR2StorageResolver(async () => await sqlResolver.resolveSql() as unknown as SqlClient).check,
    },
    recurringJobRoutes: recurringJobWiring.routes,
    recurringJobHostRoutes: recurringJobWiring.hostRoutes,
    cardDispatchSettingsRoutes:cardDispatchRuntime.settingsRoutes,
    cardOrchestrationRoutes: {
      ...providers.adminUsersRoutes.provider,
      ...cardDispatchRuntime.orchestrationSettingsRoutes,
      ...orchestrationAccess,
      authBearerToken: config.auth_bearer_token,environment:config.environment,
    },
    cardOrchestrationDecisionRoutes: {
      authBearerToken:config.auth_bearer_token,environment:config.environment,
      authorizeDecision:cardDispatchRuntime.authorizeDecision,
      authorizeWorker:cardDispatchRuntime.authorizeWorker,
    },
  });
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
    recoverPendingImmediateDeliveries: async () => {
      const deliveries = (await persistenceRepositoryProvider()).deliveries;
      for (const node of registry.listConnectedNodes()) {
        try {
          await replayPendingImmediateDeliveriesForNode({
            nodeId: node.nodeId,
            connectionId: node.connectionId,
            deliveries,
            sessionRouter: runtimeServices.sessionRouter,
            sessionBridge: runtimeServices.sessionBridge,
            warn: context.warn,
            attemptTokenPrefix: "maintenance",
          });
        } catch (error) {
          context.warn(warningMessage(
            `pending immediate delivery recovery failed for ${node.nodeId}`,
            error,
          ));
        }
      }
    },
    onDeliveryRecoveryError: (error) => {
      context.warn(warningMessage("pending immediate delivery recovery failed", error));
    },
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
    beginShutdown:()=>lifecycle.beginShutdown(),
    startBackground: async () => {
      await sessionReconciliation.start();
      await recurringJobScheduler?.start();
      await dbCatalogRepository.agentProfileRepository.list();
      await cardDispatchRuntime.dispatcher.dispatch();
      startStableSessionOrderIndexMaintenance(
        stableSessionOrderIndexMaintenance,
        app.log,
      );
      usageSummaryService.start();
      maintenanceService.start();
      turnSummaryPipeline?.start?.();
      lifecycle.markReady();
    },
    async closeResources() {
      if (resourcesClosed) return;
      resourcesClosed = true;
      await maintenanceService.stop();
      await sessionReconciliation.close();
      await recurringJobScheduler?.stop();
      await usageSummaryService.stop();
      await cardDispatchRuntime.dispatcher.drain();
      await turnSummaryPipeline?.drain();
      await pushNotifier.close();
      await dbCatalogRepository.close();
    },
  };
}

export async function replayPendingImmediateDeliveriesForNode(input: {
  nodeId: string;
  connectionId: string;
  deliveries: SessionDeliveryRepository;
  sessionRouter: OrchestratorRuntimeServices["sessionRouter"];
  sessionBridge: OrchestratorRuntimeServices["sessionBridge"];
  warn(message: string): void;
  attemptTokenPrefix?: "node-ready" | "maintenance";
}): Promise<void> {
  const attemptTokenPrefix = input.attemptTokenPrefix ?? "node-ready";
  const attemptToken = `${attemptTokenPrefix}:${input.nodeId}:${input.connectionId}`;
  const claimed = await input.deliveries.recovery.claimPendingImmediateIntentsForNode(
    input.nodeId,
    attemptToken,
  );
  for (const row of claimed) {
    try {
      if (row.target_session_id === null || row.completion_id === null) {
        throw new Error(`Delivery ${row.delivery_id} has incomplete identity`);
      }
      const parsed = intervenePayload(row.target_session_id, {
        text: row.payload.text,
        user: row.payload.user,
        caller_info: row.payload.caller_info,
        ...(row.payload.attachment_paths === null
          ? {}
          : { attachment_paths: row.payload.attachment_paths }),
        ...(row.payload.context === null
          ? {}
          : { context_items: row.payload.context }),
        delivery_id: row.delivery_id,
        delivery_intent: row.intent,
        source: row.source,
        completion_id: row.completion_id,
        relation_key: row.relation_key,
        producer_terminal_revision: row.producer_terminal_revision,
        parent_delivery_id: row.parent_delivery_id,
        caller_turn_id: row.caller_turn_id,
        created_at: row.created_at.toISOString(),
        delivery_attempt_token: attemptToken,
      });
      if (!parsed.ok) throw new Error(parsed.message);
      const routed = await input.sessionRouter
        .routeExistingSessionPendingCommand(parsed.value);
      const response = await input.sessionBridge.sendPendingCommand(routed);
      if (response.status === "error") {
        throw new Error(String(response.message ?? response.code ?? "intervene failed"));
      }
    } catch (error) {
      const failure = warningMessage(
        `${attemptTokenPrefix} delivery ${row.delivery_id} dispatch failed`,
        error,
      );
      const current = await input.deliveries.get(row.delivery_id);
      if (
        current?.attempt_token === attemptToken
        && (current.state === "claimed" || current.state === "dispatching")
      ) {
        await input.deliveries.retryDeliveryAttempt(
          row.delivery_id,
          attemptToken,
          failure,
          0,
        );
      }
      input.warn(failure);
    }
  }
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
  persistenceRepositoryProvider: NonNullable<
    CreateAppOptions["persistenceHostRoutes"]
  >["repositoryProvider"],
  corsAllowedOrigins: readonly string[] = [],
  folderProjectIdentityService?: FolderProjectIdentityService,
  memoryStats?: ReturnType<typeof createOrchestratorMemoryStatsCollector>,
  ephemeralLlmRoutes?: EphemeralLlmRouteOptions,
  cardServiceProvider?: NonNullable<CreateAppOptions["folderRoutes"]>["cardServiceProvider"],
  scheduleRepositoryProvider?: NonNullable<CreateAppOptions["scheduleHostRoutes"]>["repositoryProvider"],
  folderControlPlaneServiceProvider?: NonNullable<CreateAppOptions["folderRoutes"]>["controlPlaneServiceProvider"],
  databaseSchemaProvider?: PublicDatabaseSchemaProvider,
  mcpSkills?: McpHostOptions["skills"],
  cardExecutionServiceProvider?: NonNullable<CreateAppOptions["folderRoutes"]>["cardExecutionServiceProvider"],
  lifecycle?: OrchestratorLifecycle,
): CreateAppOptions {
  const sessionAccessProvider = providers.sessionCatalogRoutes.accessProvider;
  if (scheduleRepositoryProvider !== undefined && sessionAccessProvider === undefined) {
    throw new Error("session access provider is required for resume-after-limit routes");
  }
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
    ...(folderControlPlaneServiceProvider ? {
      mcpHostRoutes: {
        sessionMessages: providers.runtime.sessionActionCommandRoutes,
        authBearerToken: config.authBearerToken,
        ...(mcpSkills ? { skills: mcpSkills } : {}),
        cards: { cardServiceProvider, provider: providers.folderRoutes.provider, resolveAccess: serviceTokenAccessWithoutEmail,
          ...(cardExecutionServiceProvider ? { cardExecutionServiceProvider } : {}) },
        cluster: {
          nodes: providers.runtime.nodeSnapshotRoutes,
          nodeAgentProfiles: providers.nodeAgentProfileRoutes,
          cogito: providers.cogitoRoutes,
          sessions: providers.runtime.sessionCommandRoutes,
          readSession: async id => (await persistenceRepositoryProvider()).sessionReads.getSession(id),
        },
        board: {
          host: providers.runtime.boardYjsHostProxyRoutes,
          getSession: async id => (await persistenceRepositoryProvider()).sessionReads.getSession(id),
          listAgentProfiles: nodeId => providers.nodeAgentProfileRoutes.provider.listAgentProfiles(nodeId),
          broadcaster: runtime.sessionBroadcaster,
          catalogFolderProvider: { listFolders: () => providers.folderRoutes.provider.listFolders() },
        },
        sessions: {
          repositoryProvider: persistenceRepositoryProvider,
          cogito: providers.cogitoRoutes,
          catalogProvider: providers.sessionCatalogRoutes.provider,
          resolveAccess: serviceTokenAccessWithoutEmail,
          broadcastRename: sessionId => broadcastTargetedSessionCatalogDelta(
            {
              listFolders: () => providers.folderRoutes.provider.listFolders(),
              listSessionAssignmentsByIds: async ids => Object.fromEntries(
                (await (await folderControlPlaneServiceProvider()).getSessionAssignmentsByIds([...ids]))
                  .map(row => [row.session_id, { folderId: row.folder_id, displayName: row.display_name }]),
              ),
            }, runtime.sessionBroadcaster, [sessionId],
          ),
        },
        folders: {
          serviceProvider: folderControlPlaneServiceProvider,
          cardServiceProvider,
          identity: folderProjectIdentityService,
          authBearerToken: config.authBearerToken,
        },
      },
    } : {}),
    folderRoutes: {
      ...providers.folderRoutes,
      ...(cardExecutionServiceProvider ? {cardExecutionServiceProvider} : {}),
      ...(cardServiceProvider ? { cardServiceProvider } : {}),
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
    contextBundleRoutes: providers.contextBundleRoutes,
    nodeClaudeAuthRoutes: {
      ...providers.nodeClaudeAuthRoutes,
      registry: runtime.registry,
      bridge: runtime.sessionBridge,
    },
    nodeSnapshotRoutes: providers.runtime.nodeSnapshotRoutes,
    nodeWsRoute: providers.runtime.nodeWsRoute,
    publicStatusRoutes: {
      ...providers.publicStatusRoutes,
      lifecycle,
      configProvider: providers.configProviders.publicStatusRoutes.configProvider,
      ...(databaseSchemaProvider ? { databaseSchemaProvider } : {}),
    },
    pushRoutes: providers.pushRoutes,
    ...(scheduleRepositoryProvider
      ? {
          scheduleHostRoutes: {
            repositoryProvider: scheduleRepositoryProvider,
            authBearerToken: config.authBearerToken,
          },
        }
      : {}),
    persistenceHostRoutes: {
      repositoryProvider: persistenceRepositoryProvider,
      authBearerToken: config.authBearerToken,
    },
    sessionActionCommandRoutes: {
      ...providers.runtime.sessionActionCommandRoutes,
      deliveryRepositoryProvider: async () =>
        (await persistenceRepositoryProvider()).deliveries,
    },
    sessionBackgroundScheduleRoutes:
      providers.runtime.sessionBackgroundScheduleRoutes,
    ...(scheduleRepositoryProvider === undefined
      ? {}
      : {
          sessionResumeAfterLimitRoutes: {
            accessProvider: sessionAccessProvider!,
            persistenceRepositoryProvider,
            scheduleRepositoryProvider,
          },
        }),
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
    uiEventRoutes: providers.uiEventRoutes,
  };
}

async function closeApplication(application: ProductionApplication): Promise<void> {
  await application.beginShutdown?.();
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

function createSystemPortraitAssets(): LiveSystemPortraitAssetBoundary {
  const portraitUrl = new URL(
    "../assets/portraits/",
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
