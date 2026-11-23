import { createMcpCentralService, type McpCentralService } from "./mcp_central/service.js";
import { ConversationMessageService } from "./conversation/conversation_messages.js";
import { HandoverGate, guardMethods } from "./runtime/handover_gate.js";
import { closeNodeSocketsForHandover } from "./websocket_plugin.js";
import { createConversationMessagePorts } from "./conversation/conversation_message_ports.js";
import { ConversationService } from "./conversation/conversation_service.js";
import { ConversationCatalog } from "./conversation/conversation_catalog.js";
import { dashboardAuthEnabled, resolveDashboardLoginMode } from "./auth/login_mode.js";
import { verifyServiceBearerAuthorization } from "./auth/service_bearer.js";
import { SqlOwnedAgentRepository } from "./owned-agents/repository.js";
import type { OnPersistentReportPosted, PublishPersistentReports } from "./session/persistent_report_service.js";
import { createReportTimelineAppender, type AppendReportTimeline } from "./session/report_timeline_publisher.js";
import { OwnedAgentService } from "./owned-agents/service.js";
import { createSessionOwnerResolver } from "./session/session_owner.js";
import { ExternalEventsService, credentialOwner } from "./external_events/service.js";
import type { McpHostOptions } from "./mcp/types.js";
import {DashboardBuildInfo,OrchestratorLifecycle} from "./runtime/orchestrator_lifecycle.js";
import { serviceTokenAccessWithoutEmail } from "./runtime/live_dashboard_access_provider.js";
import type { SqlClient } from "./control_plane/control_plane_types.js";
// 500줄 예외: 프로덕션 composition root의 단일 조립 순서를 한 파일에서 검증한다.
// 도메인 동작은 각 service/repository 모듈에 있고, 이 파일은 연결만 소유한다.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyListenOptions, FastifyRequest } from "fastify";
import { SERVICE_CALLER, isServiceCaller, type ServiceCaller } from "./auth/service_caller.js";

import { createApp, type CreateAppOptions } from "./app.js";
import { FlatFolderContentHost } from "./board/flat_folder_content_host.js";
import { MarkdownDocumentService } from "./board/markdown_document_service.js";
import { SessionFolderMoveRepository } from "./session/session_folder_move_repository.js";
import type { SessionRequestAccessGuard } from "./session/session_resource_access.js";
import { SessionFolderMoveService } from "./session/session_folder_move_service.js";
import { broadcastCatalogDelta } from "./runtime/catalog_delta_broadcaster.js";
import { PageRepository } from "./page/page_repository.js";
import { PageYjsService } from "./page/page_service.js";
import { SqlFolderProjectIdentityRepository } from "./folders/folder_project_identity_repository.js";
import { FolderProjectIdentityService } from "./folders/folder_project_identity_service.js";
import { SqlNodeCredentialRepository } from "./node_credentials/credential_repository.js";
import { NodeCredentialStore } from "./node_credentials/credential_store.js";
import type { NodeCredentialResolver } from "./node_credentials/types.js";
import { NodePairingService } from "./node_credentials/pairing_service.js";
import { PlannerRepository } from "./planner/planner_repository.js";
import {
  createEnvironmentConfigProvider,
  type OrchServerEnvironmentConfig,
  toOrchServerTsConfig,
} from "./config.js";
import { registerDashboardServing } from "./dashboard/dashboard_serving.js";
import { CodexEphemeralExecutor } from "./llm/codex_ephemeral_executor.js";
import { AntigravityEphemeralExecutor } from "./llm/antigravity_ephemeral_executor.js";
import { resolveAntigravityCliPath } from "./llm/antigravity_cli_path.js";
import type { EphemeralLlmRouteOptions } from "./llm/ephemeral_llm_routes.js";
import { InMemoryNodeRegistry, type NodeRegistryEvent } from "./node/registry.js";
import { resolveRegisteredAgentId } from "./node/agent_profile_lookup.js";
import {
  EventIngressRepository,
  LiveEventIngressSqlProvider,
  type EventIngressWarnSink,
  type EventSessionEffectApplier,
} from "./node/event_ingress_repository.js";
import { FileEventIngressDeadLetterStore } from "./node/event_ingress_dead_letter_store.js";
import {
  queryEventIngressDeliveryLatency,
  type DeliveryLatencySql,
} from "./node/event_ingress_delivery_latency.js";
import { applyEventSessionEffect } from "./node/event_session_effect_applier.js";
import { applyEventFeedProjection } from "./node/event_feed_projection_applier.js";
import { createSessionReconciliationSink } from "./node/session_reconciliation_sink.js";
import { runnerInventoryCommandType } from "./node/registry_helpers.js";
import { PendingNodeCommandRejectedError } from "./node/pending_commands.js";
import { RUNNER_INVENTORY_COMMAND_TIMEOUT_MS } from "./node/node_timeouts.js";
import {
  DELIVERY_CLAIM_TTL_MS,
  nodeRejectionDetailsSuffix,
  releaseDeliveryAttemptAfterSendFailure,
} from "./control_plane/session_delivery_release.js";
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
} from "./push/push_notifier.js";
import { createProductionOutboundWebhook } from "./webhooks/production_wiring.js";
import { ConversationHistory } from "./conversation/conversation_history.js";
import { ExternalAccessGrantRepository } from "./external_access/external_access_grant_repository.js";
import {
  createExternalInterventionDispatch,
  ExternalInputService,
} from "./external_access/external_input_service.js";
import { ExternalAccessTokenBucket } from "./external_access/external_access_token_bucket.js";
import { ExternalReplySignal } from "./external_access/external_reply_signal.js";
import { executeInterruptCommand } from "./session/session_action_command_errors.js";
import type { OutboundWebhookService } from "./webhooks/outbound_service.js";
import {
  createOrchestratorRuntimeServices,
  type OrchestratorRuntimeServices,
} from "./runtime/composition.js";
import { createR2StorageResolver } from "./runtime/r2_storage_resolver.js";
import { readR2Settings, updateR2Settings } from "./system/r2_settings.js";
import { OrchestratorMaintenanceService } from "./runtime/orchestrator_maintenance_service.js";
import { createOrchestratorMemoryStatsCollector } from "./runtime/orchestrator_memory_stats.js";
import { createLiveDbCatalogRepository } from "./runtime/live_db_catalog_repository.js";
import { broadcastCatalogSnapshot } from "./runtime/live_folder_mutation_broadcaster.js";
import { broadcastTargetedSessionCatalogDelta } from
  "./runtime/live_session_catalog_mutation_broadcaster.js";
import { boardItemsDelta } from "@soulstream/wire-schema/catalog";
import { isTerminalSessionStatus } from "./session/session_status.js";
import {
  createLiveSearchDbConnectionFactory,
  createLiveDbSqlResolver,
  type LiveDbSqlResolver,
} from "./runtime/live_db_sql.js";
import type { LiveProviderDependencies } from "./runtime/live_provider_dependencies.js";
import type { ModelCatalogSource } from "./model/model_catalog_source.js";
import {
  createLiveOrchestratorProviderBundle,
  type LiveOrchestratorProviderBundle,
} from "./runtime/live_provider_factory.js";
import { createLivePushRegistrationRepository } from "./runtime/live_push_registration_repository.js";
import { createLiveUiEventRepository } from "./runtime/live_ui_event_repository.js";
import { createPageUpdatedEmitter } from "./runtime/page_updated_broadcaster.js";
import { createCardOrchestrationAccess } from "./cards/card_orchestration_access.js";
import { createCardDispatchRuntime } from "./cards/card_dispatch_runtime.js";
import { CardDispatchRepository } from "./cards/card_dispatch_repository.js";
import { resolveCardOwnerEmail } from "./cards/card_question_board.js";
import { cardRouteErrorResponse } from "./cards/card_route_body.js";
import { createCardCommentAttachmentUploader } from "./cards/card_comment_attachment_upload.js";
import { applyCardQuestionReply } from "./session/card_question_reply.js";
import { dashboardFolderActor } from "./folders/folder_workspace_routes.js";
import { FolderContentSqlResolver } from "./board/folder_content_sql.js";
import { relayCanonicalErrorTx } from "./cards/card_work_error_delivery.js";
import type { RepositorySql } from "./cards/control_plane/card_types.js";
import type { CardDispatcher } from "./cards/card_dispatcher.js";
import { createScheduleRepositoryProvider } from "./schedule/schedule_host_runtime.js";
import { createFolderControlPlaneServiceProvider } from "./folders/folder_control_plane_runtime.js";
import { createPersistenceHostRepositoryProvider } from "./control_plane/persistence_host_runtime.js";
import { SessionStoryReadRepository } from "./control_plane/repositories/session_story_read_repository.js";
import { createPersistentContextCandidateRepositories } from "./persistent-context/persistent_context_candidates.js";
import { createPersistentContextService } from "./persistent-context/persistent_context_service.js";
import { SqlRecurringJobRepository } from "./recurring-jobs/repository.js";
import { RecurringJobService } from "./recurring-jobs/service.js";
import { RecurringJobScheduler } from "./recurring-jobs/scheduler.js";
import { createProductionRecurringJobWiring } from "./recurring-jobs/production_wiring.js";
import { createRecurringJobTargetValidator } from "./recurring-jobs/target_validator.js";
import {
  createRecurringSession,
  type CreateRecurringSessionInput,
} from "./session/recurring_session_creation.js";
import type { RecurringJob, RecurringJobRun } from "./recurring-jobs/types.js";
import type { SessionDeliveryRepository } from
  "./control_plane/repositories/session_delivery_repository.js";
import type { LiveSystemPortraitAssetBoundary } from "./runtime/live_system_config_route_provider.js";
import { ClaudeAccountReloginNotifier } from "./usage/claude_account_relogin_notifier.js";
import { SessionStatisticsUpdateNotifier } from "./usage/session_statistics_update_notifier.js";
import { UsageSummaryService } from "./usage/usage_summary_service.js";
import { createSqlClaudeCentralAccountRepository } from "./claude_central/account_repository.js";
import { createSqlClaudeCentralSettingsRepository } from "./claude_central/settings_repository.js";
import { ClaudeCentralService } from "./claude_central/service.js";
import { SessionDeletionRepository } from "./session/session_deletion_repository.js";
import { SessionDeletionService } from "./session/session_deletion_service.js";
import { ChildSessionCheckRepository } from "./session/child_session_check_repository.js";
import {
  CHILD_SESSION_CHECK_SOURCE,
  ChildSessionCheckService,
} from "./session/child_session_check_service.js";
import { sessionDeliveryInterventionPayload } from
  "./session/session_delivery_intervention_payload.js";
import { PersistentSessionSettingsService } from "./session/persistent_session_settings_service.js";
import { executeCreateSessionRoute } from "./session/session_command_routes.js";
import {
  executeSessionIntervention,
  type SessionActionInlineAttachmentUpload,
} from "./session/session_action_command_routes.js";
import {
  createLiveTurnSummaryPipeline,
  type LiveTurnSummaryPipeline,
  type LiveTurnSummaryProductionOverrides,
} from "./turn-summary/live_turn_summary_pipeline.js";
import { resolveCodexCliPath } from "@soulstream/executable-path";

export type ProductionApplication = {
  readonly app: FastifyInstance;
  readonly startBackground: () => Promise<void>;
  readonly closeResources: () => Promise<void>;
  readonly closeHandoverResources?: () => Promise<void>;
  readonly beginShutdown?: () => Promise<void>;
  readonly stopBackground?: () => Promise<void>;
  readonly fenceWrites?: () => Promise<void>;
  readonly resumeBackground?: () => Promise<void>;
  readonly waitForPendingCommands?: () => Promise<void>;
  readonly closePages?: () => Promise<void>;
  readonly markOwner?: () => void;
};

export type ShutdownStageReporter = (step: string) => void;

export type ProductionApplicationFactory = (
  config: OrchServerEnvironmentConfig,
  context: {
    readonly warn: (message: string) => void;
    /** Names the shutdown step about to start, for the entrypoint's deadline log. */
    readonly onShutdownStage?: ShutdownStageReporter;
  },
) => Promise<ProductionApplication>;

export type LiveProductionApplicationOverrides = {
  readonly sqlResolver?: LiveDbSqlResolver;
  /** Opened once by the entrypoint; every consumer reads the same file-backed store. */
  readonly modelCatalog: ModelCatalogSource;
  readonly pageGate?: HandoverGate;
} & LiveTurnSummaryProductionOverrides;

export type CreateProductionOrchestratorOptions = {
  readonly config: OrchServerEnvironmentConfig;
  readonly modelCatalog: ModelCatalogSource;
  readonly applicationFactory?: ProductionApplicationFactory;
  readonly warn?: (message: string) => void;
  readonly onShutdownStage?: ShutdownStageReporter;
  readonly handover?: boolean;
};

export type ProductionOrchestrator = {
  readonly app: FastifyInstance;
  readonly listen: () => Promise<string>;
  readonly close: () => Promise<void>;
  readonly pageGate: HandoverGate;
  readonly stopBackground: () => Promise<void>;
  readonly fenceWrites: () => Promise<void>;
  readonly resumeBackground: () => Promise<void>;
  readonly stopListening: () => void;
  readonly waitForPendingCommands: () => Promise<void>;
  readonly closeNodeSockets: () => void;
  readonly closePages: () => Promise<void>;
  readonly closeForHandover: () => Promise<void>;
};

export function createRunnerInventoryCommand(
  registry: Pick<InMemoryNodeRegistry, "createCommand">,
  nodeId: string,
  capabilities: unknown,
) {
  const type = runnerInventoryCommandType(capabilities);
  return registry.createCommand(
    nodeId,
    { type },
    type === "list_runner_inventory"
      ? { timeoutMs: RUNNER_INVENTORY_COMMAND_TIMEOUT_MS }
      : {},
  );
}

export async function createProductionOrchestrator(
  options: CreateProductionOrchestratorOptions,
): Promise<ProductionOrchestrator> {
  const startupWarnings: string[] = [];
  const pageGate = new HandoverGate();
  let warningSink: (message: string) => void = options.warn
    ?? ((message) => startupWarnings.push(message));
  const warn = (message: string) => warningSink(message);
  if (options.config.dashboard_user_folder_access_configured) {
    warn(
      "DASHBOARD_USER_FOLDER_ACCESS is configured but not enforced; manage folder permissions through the users table.",
    );
  }
  const application = await (
    options.applicationFactory === undefined
      ? (config: OrchServerEnvironmentConfig, context: {
          readonly warn: (message: string) => void;
          readonly onShutdownStage?: ShutdownStageReporter;
        }) => createLiveProductionApplication(config, context, { modelCatalog: options.modelCatalog, ...(options.handover ? { pageGate } : {}) })
      : options.applicationFactory
  )(options.config, { warn, onShutdownStage: options.onShutdownStage });
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
  let listenerClosed: Promise<void> | undefined;
  return {
    app: application.app,
    pageGate,
    async listen() {
      if (closed) throw new Error("Production orchestrator is already closed");
      if (startAttempted) throw new Error("Production orchestrator listen() may only run once");
      startAttempted = true;
      try {
        application.markOwner?.();
        await application.startBackground();
        return await application.app.listen({
          host: options.config.host,
          port: options.config.port,
          ...(options.handover ? { reusePort: true } : {}),
        } as FastifyListenOptions & { reusePort?: boolean });
      } catch (error) {
        if (options.handover) await pageGate.close();
        await closeApplication(application);
        closed = true;
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeApplication(application, options.onShutdownStage);
    },
    stopBackground: async () => await application.stopBackground?.(),
    fenceWrites: async () => await application.fenceWrites?.(),
    resumeBackground: async () => await application.resumeBackground?.(),
    stopListening() { listenerClosed = new Promise<void>(resolve => application.app.server.close(() => resolve())); },
    waitForPendingCommands: async () => await application.waitForPendingCommands?.(),
    closeNodeSockets: () => closeNodeSocketsForHandover(application.app),
    closePages: async () => await application.closePages?.(),
    async closeForHandover() {
      await application.beginShutdown?.();
      await Promise.race([listenerClosed, new Promise<void>(resolve => setTimeout(resolve, 10_000))]);
      if (!closed) { closed = true; await closeApplication(application, options.onShutdownStage, true); }
    },
  };
}

const SESSION_SEARCH_SLOW_WARN_MS = 3_000;
const SESSION_DOCUMENT_INDEX_WARMUP_DELAY_MS = 10_000;
/** On handover exit, a stop that is still running gets this long before the next shutdown step. */
const HANDOVER_BACKGROUND_STOP_WAIT_MS = 5_000;
function unrestrictedPageGate(): HandoverGate { const gate = new HandoverGate(); gate.open(); return gate; }

export async function createLiveProductionApplication(
  config: OrchServerEnvironmentConfig,
  context: {
    readonly warn: (message: string) => void;
    readonly onShutdownStage?: ShutdownStageReporter;
  },
  overrides: LiveProductionApplicationOverrides,
): Promise<ProductionApplication> {
  const buildInfo=await DashboardBuildInfo.open(config.dashboard_dir,config.environment);
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
  const sessionFolderMoveService = new SessionFolderMoveService({
    repository: new SessionFolderMoveRepository(sqlResolver),
    onFoldersMoveCommitted: async (folderIds) => {
      for (const folderId of folderIds) runtimeServices.sessionBroadcaster.append({ type: "folder_updated", folderId });
    },
    onCardsMoveCommitted: async (cards) => {
      for (const card of cards) {
        runtimeServices.sessionBroadcaster.append({ type: "card_updated", cardId: card.cardId, folderId: card.sourceFolderId });
        runtimeServices.sessionBroadcaster.append({ type: "card_updated", cardId: card.cardId, folderId: card.folderId });
      }
    },
  });
  const sessionDeletionService = new SessionDeletionService({
    repository: new SessionDeletionRepository(sqlResolver, {
      onCardsUpdated: ({ cardId, folderId }) => {
        runtimeServices.sessionBroadcaster.append({ type: "card_updated", cardId, folderId });
      },
    }),
  });
  let publishPersistentReports: PublishPersistentReports = () => undefined;
  let notifyPersistentReportPosted: OnPersistentReportPosted = () => undefined;
  let appendReportTimeline: AppendReportTimeline = async () => undefined;
  const persistenceRepositoryProvider = createPersistenceHostRepositoryProvider(
    sqlResolver,
    sessionDeletionService,
    searchDbConnectionFactory,
    reportSearchCancelError,
    updates => publishPersistentReports(updates),
    input => notifyPersistentReportPosted(input),
    (sessionId, event) => appendReportTimeline(sessionId, event),
  );
  const recurringJobRepository = new SqlRecurringJobRepository(sqlResolver);
  const registry = new InMemoryNodeRegistry();
  let backgroundActive = false;
  const nodeRecoveryTasks = new Set<Promise<void>>();
  let cardDispatchRuntime: Awaited<ReturnType<typeof createCardDispatchRuntime>> | undefined;
  const applyCardWorkErrorEffect = createCardWorkErrorSessionEffectApplier();
  // 앱 로거는 여기서 아직 없으므로 startupWarnings를 거쳐 앱 로거로 넘어가는
  // context.warn에 연결한다. 구조화 필드는 문장에 실어 pino 스트림 안에 남긴다.
  const eventIngressWarn: EventIngressWarnSink = (fields, message) =>
    context.warn(`${message}: ${JSON.stringify(fields)}`);
  const deadLetterStore = new FileEventIngressDeadLetterStore(resolve(
    dirname(fileURLToPath(import.meta.url)), "..", ".local", "event-ingress-dead-letter",
  ));
  const sessionStatisticsUpdates = new SessionStatisticsUpdateNotifier({
    onError: (error) => context.warn(warningMessage("Session statistics update listener failed", error)),
  });
  const eventIngressRepository = new EventIngressRepository(
    new LiveEventIngressSqlProvider(sqlResolver),
    applyCardWorkErrorEffect,
    deadLetterStore,
    {
      modelCatalog: overrides.modelCatalog,
      warn: eventIngressWarn,
      onSessionStatisticsFactsInserted: () => sessionStatisticsUpdates.notify(),
    },
    applyEventFeedProjection,
  );
  const eventIngressCommitter = createCardWorkErrorIngressCommitter(
    eventIngressRepository,
    async (sessionId, eventId) => await cardDispatchRuntime?.kickCanonicalWorkError(sessionId, eventId),
  );
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
    onSearchTiming: (timing) => {
      if (timing.status !== "partial" && timing.totalMs <= SESSION_SEARCH_SLOW_WARN_MS) return;
      context.warn(`session search ${timing.status}: ${JSON.stringify(timing)}`);
    },
    sessionDeletion: sessionDeletionService,
    sessionMoves: sessionFolderMoveService,
  });
  const pushRepository = createLivePushRegistrationRepository({ sqlResolver });
  const uiEventRepository = createLiveUiEventRepository({ sqlResolver });
  const foregroundObservers = new SessionForegroundObserverTracker();
  const sessionCacheSeed = createSessionCacheSeedSink({
    registry,
    repository: dbCatalogRepository,
    logError: (error, message) => context.warn(`${message}: ${String(error)}`),
    onNodeReady: (nodeId, connectionId) => {
      if (!backgroundActive) return Promise.resolve();
      const task = (async () => {
      try {
        await replayPendingImmediateDeliveriesForNode({
          nodeId,
          connectionId,
          deliveries: (await persistenceRepositoryProvider()).deliveries,
          sessionRouter: runtimeServices.sessionRouter,
          sessionBridge: runtimeServices.sessionBridge,
          warn: context.warn,
        });
      } finally {
        try {
          if (backgroundActive) await cardDispatchRuntime?.kickPendingWorkForNode(nodeId);
        } catch (error) {
          context.warn(warningMessage(`pending card work recovery failed for ${nodeId}`, error));
        }
      }
      })();
      nodeRecoveryTasks.add(task);
      void task.finally(() => nodeRecoveryTasks.delete(task)).catch(() => {});
      return task;
    },
  });
  const pushNotifier = new PushNotifier({
    provider: createExpoPushProvider(),
    repository: pushRepository,
    catalog: dbCatalogRepository.folderRouteProvider,
    resolveNodeEmail: (nodeId) =>
      stringValue(registry.getUserInfo(nodeId).email) || config.allowed_email || undefined,
    onWarning: (message, error) => context.warn(warningMessage(message, error)),
  });
  const claudeAccountReloginNotifier = new ClaudeAccountReloginNotifier((alert) => {
    void pushNotifier.notifyClaudeAccountRelogin(alert);
  });
  // 노드 등록 이벤트 싱크가 런타임 서비스 생성 전에 조립되므로 먼저 선언하고 뒤에서 채운다.
  let claudeCentralService: ClaudeCentralService | undefined;
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
      const command = createRunnerInventoryCommand(registry, nodeId, node.capabilities);
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
  const markdownDocuments = new MarkdownDocumentService(sqlResolver, async mutation => {
    await broadcastCatalogDelta(dbCatalogRepository.folderRouteProvider, runtimeServices.sessionBroadcaster, {
      boardItemsDelta: boardItemsDelta(mutation.boardItems, mutation.deletedBoardItemIds),
    });
    for (const folderId of mutation.folderIds) runtimeServices.sessionBroadcaster.append({ type: "folder_updated", folderId });
    runtimeServices.sessionBroadcaster.append({ type: "page_updated", page_id: mutation.documentId, version: mutation.version });
  });
  const flatFolderContentHost = new FlatFolderContentHost(sqlResolver, markdownDocuments, sessionFolderMoveService,
    async (folderId, parentFolderId, idempotencyKey) => {
      if (!folderProjectIdentityService) throw new Error("Folder identity service is unavailable");
      const folder = await folderProjectIdentityRepository.findByFolderId(folderId);
      if (!folder) throw Object.assign(new Error("Folder not found"), { statusCode: 404 });
      await folderProjectIdentityService.mutateFromFolder({ folderId, expectedVersion: folder.version,
        update: { parentFolderId }, actor: { actorKind: "system" }, idempotencyKey });
    }, async (item, sourceFolderId, sessionIds) => {
      if (sessionIds) {
        await broadcastTargetedSessionCatalogDelta(dbCatalogRepository.folderRouteProvider,
          runtimeServices.sessionBroadcaster, sessionIds, { [item.id]: item });
      } else {
        await broadcastCatalogDelta(dbCatalogRepository.folderRouteProvider, runtimeServices.sessionBroadcaster,
          { boardItemsDelta: { [item.id]: item } });
      }
      runtimeServices.sessionBroadcaster.append({ type: "folder_updated", folderId: sourceFolderId });
      runtimeServices.sessionBroadcaster.append({ type: "folder_updated", folderId: item.folderId });
    });
  let turnSummaryPipeline: LiveTurnSummaryPipeline | undefined;
  let recurringJobScheduler: RecurringJobScheduler | undefined;
  let cardDispatcher: CardDispatcher | undefined;
  let childSessionCheckService: ChildSessionCheckService | undefined;
  let usageSummaryService: UsageSummaryService | undefined;
  let outboundWebhookService: OutboundWebhookService | undefined;
  const nodeCredentialRepository = new SqlNodeCredentialRepository(
    async () => await sqlResolver.resolveSql(),
  );
  const nodeCredentialStore = new NodeCredentialStore({ repository: nodeCredentialRepository });
  const nodeCredentialInit = await nodeCredentialStore.initialize();
  if (!nodeCredentialInit.ok) {
    context.warn(warningMessage(
      "node credential store initialization failed; every node credential token resolves to null until restart",
      nodeCredentialInit.error,
    ));
  }
  nodeCredentialStore.onRevoked((principal) => {
    pageYjsService?.closeConnectionsForCredential(principal.credential_id);
  });
  const runtimeServices = createOrchestratorRuntimeServices({
    config: appConfig,
    registry,
    nodeCredentials: nodeCredentialStore,
    eventIngress: eventIngressCommitter,
    onCommittedProviderEvent: (input) => usageSummaryService!.observeProviderExecution(input),
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
      (events) => { if (backgroundActive) turnSummaryPipeline?.accept(events); },
      (events) => { if (backgroundActive) recurringJobScheduler?.accept(events); },
      (events) => { if (backgroundActive) cardDispatcher?.accept(events); },
      async (events) => (await persistenceRepositoryProvider()).persistentReports!.acceptNodeEvents(events),
      (events) => childSessionCheckService?.acceptNodeEvents(events),
      (events) => { if (backgroundActive) outboundWebhookService?.accept(events); },
      (events) => { if (backgroundActive) claudeCentralService?.acceptNodeEvents(events); },
    ],
    flatFolderContentRoutes: { host: flatFolderContentHost, authBearerToken: config.auth_bearer_token, environment: config.environment, nodeCredentials: nodeCredentialStore },
    pageYjsRoutes: {
      authBearerToken: config.auth_bearer_token,
      nodeCredentials: nodeCredentialStore,
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
        await providers.authenticatedUserResolvers.resolveUserOrOAuthEmail(request),
      createService: (logger) => pageYjsService ??= guardMethods(new PageYjsService({
        repository: pageRepository,
        documentGate: overrides.pageGate,
        logger,
        onPageUpdated: createPageUpdatedEmitter(runtimeServices.sessionBroadcaster),
        mutateFolderIdentity: async (input) =>
          await folderProjectIdentityService?.mutateFromPage(input) ?? null,
        auth: {
          authBearerToken: config.auth_bearer_token,
          environment: config.environment,
          nodeCredentials: nodeCredentialStore,
          dashboardAuthEnabled: dashboardAuthEnabled(config),
          tailscaleAuthEnabled: resolveDashboardLoginMode(config) === "tailscale",
          resolveDashboardUserFromHeaders: (headers) =>
            providers.authenticatedUserResolvers.resolveUserFromHeaders(headers),
        },
      }), overrides.pageGate ?? unrestrictedPageGate(), ["createPage", "mutatePage", "transferBlocks", "getPage", "getBrowserPage", "findPage", "getDailyPage", "hydrateCommittedPage"]),
    },
  });
  appendReportTimeline = createReportTimelineAppender({
    resolveSql: () => sqlResolver.resolveSql(),
    eventHub: runtimeServices.sessionEventHub,
    warn: context.warn,
  });
  publishPersistentReports = updates => {
    for (const update of updates) {
      registry.sessionCache.patchPersistentReport(update.agent_session_id, update.persistent_report);
      runtimeServices.sessionBroadcaster.append({ type: "session_updated", agent_session_id: update.agent_session_id, persistent_report: update.persistent_report });
    }
  };
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
  const mcpCentralService = createMcpCentralService({ resolveSql: () => sqlResolver.resolveSql() });
  claudeCentralService = new ClaudeCentralService({
    repository: createSqlClaudeCentralAccountRepository({
      resolveSql: () => sqlResolver.resolveSql(),
    }),
    settingsRepository: createSqlClaudeCentralSettingsRepository({
      resolveSql: () => sqlResolver.resolveSql(),
    }),
    registry,
    bridge: runtimeServices.sessionBridge,
    clientId: () => config.claude_oauth_client_id,
    notifyRelogin: (alert) => {
      // 중앙 계정은 노드 하나에 매이지 않으므로 오케스트레이터 소유자에게 알린다.
      void pushNotifier.notifyCentralClaudeAccountRelogin({
        ownerEmail: config.allowed_email,
        accountId: alert.accountId,
        accountEmail: alert.accountEmail,
      });
    },
    onWarning: (message, error) => context.warn(warningMessage(message, error)),
  });
  const memoryStats = createOrchestratorMemoryStatsCollector({
    sessionBroadcaster: runtimeServices.sessionBroadcaster,
    sessionCache: registry.sessionCache,
    registry,
    pushNotifier,
    foregroundObservers,
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
  usageSummaryService = new UsageSummaryService({
    registry: runtimeServices.registry,
    bridge: runtimeServices.sessionBridge,
    pollIntervalMs: config.usage_summary_poll_interval_seconds * 1_000,
    sharedAccountGroups: config.usage_summary_shared_accounts,
    onCollected: (snapshot) => {
      try {
        claudeAccountReloginNotifier.observe(snapshot);
      } catch (error) {
        context.warn(warningMessage("Claude account relogin notification failed", error));
      }
      void cardDispatcher?.dispatch();
    },
    onWarning: (message, error) => context.warn(warningMessage(message, error)),
  });
  runtimeServices.routeOptions.nodeWsRoute.onRegistered = (nodeId) => usageSummaryService!.refreshNode(nodeId);
  try {
    const attachmentStorageResolver = createR2StorageResolver(
      async () => await sqlResolver.resolveSql() as unknown as SqlClient,
    );
    const resolveAttachmentBinding = () =>
      attachmentStorageResolver.resolveBinding("attachment");
    providers = createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
      modelCatalog: overrides.modelCatalog,
      nodeCredentials: nodeCredentialStore,
      uiEventRepository,
      usageSummaryRoutes: {
        service: usageSummaryService,
        statisticsUpdates: sessionStatisticsUpdates,
      },
      sessionStatisticsRepositoryProvider: async () =>
        (await persistenceRepositoryProvider()).sessionStatistics,
      findSessionNode: dbCatalogRepository.findSessionOwnerNodeId,
      dbSqlResolver: sqlResolver,
      agentAttachmentRegistration: {
        authBearerToken: config.auth_bearer_token,
        environment: config.environment,
        sql: await sqlResolver.resolveSql() as unknown as RepositorySql,
        resolveAttachmentBinding,
      },
      resolveAttachmentStorage: resolveAttachmentBinding,
      onAttachmentStorageFailure: (failure) => context.warn(
        `첨부 저장을 쓸 수 없습니다: 코드=${failure.code}, 상태=${failure.statusCode}, 작업=${failure.operation}`,
      ),
      resolveReadStorage: resolveAttachmentBinding,
      readPageAttachmentEvidence: async (pageId, attachmentId) => {
        if (!pageYjsService) throw new Error("Page Yjs service is not initialized");
        const page = await pageYjsService.getBrowserPage(pageId);
        const hasStoredRef = page.blocks.some((block) => {
          const properties = block.properties;
          if (
            properties.attachment_id === attachmentId ||
            properties.assetId === attachmentId
          ) return true;
          return Array.isArray(properties.attachment_refs) &&
            properties.attachment_refs.some((reference) =>
              typeof reference === "object" && reference !== null &&
              !Array.isArray(reference) &&
              (reference as Record<string, unknown>).attachment_id === attachmentId
            );
        });
        return {
          scope: { type: "page", id: pageId },
          folderId: null,
          hasStoredRef,
        };
      },
    });
  } catch (error) {
    await dbCatalogRepository.close();
    throw error;
  }
  const outboundSessionAccess = providers.sessionCatalogRoutes.accessProvider;
  const outboundAuthorizeUser = providers.authRoutes.authorizeUser;
  if (outboundSessionAccess === undefined || outboundAuthorizeUser === undefined) {
    throw new Error("session access provider and user authorizer are required for outbound webhooks");
  }
  outboundWebhookService = createProductionOutboundWebhook({
    resolveSql: async () => await sqlResolver.resolveSql() as unknown as SqlClient,
    authorizeUser: outboundAuthorizeUser,
    sessionAccess: outboundSessionAccess,
    warn: context.warn,
  });
  const nodePairingService = new NodePairingService({
    store: nodeCredentialStore,
    isNodeConnected: (nodeId) =>
      providers.runtime.nodeSnapshotRoutes.snapshotService.getNode(nodeId) !== undefined,
    hasStoredNode: async (nodeId) => {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql<readonly Record<string, unknown>[]>`
        SELECT 1 AS present
        FROM soulstream_node_heartbeats
        WHERE node_id = ${nodeId}
        LIMIT 1
      `;
      return rows.length > 0;
    },
  });
  folderProjectIdentityService = guardMethods(new FolderProjectIdentityService({
    repository: folderProjectIdentityRepository,
    hydratePage: async (pageId) => {
      if (!pageYjsService) throw new Error("Page Yjs service is not initialized");
      await pageYjsService.hydrateCommittedPage(`page:${pageId}`);
    },
    onCommitted: async () => {
      await broadcastCatalogSnapshot(providers.folderRoutes.provider, runtimeServices.sessionBroadcaster);
    },
    onPageUpdated: createPageUpdatedEmitter(runtimeServices.sessionBroadcaster),
  }), overrides.pageGate ?? unrestrictedPageGate(), ["create", "mutateFromFolder", "mutateFromPage"]);
  const ephemeralProcessEnv = overrides.turnSummaryProcessEnv ?? process.env;
  const ephemeralCodexPath = overrides.turnSummaryCodexPath ??
    resolveCodexCliPath(config.codex_cli_path, ephemeralProcessEnv)?.path;
  const ephemeralAntigravityPath = resolveAntigravityCliPath(config.antigravity_cli_path, ephemeralProcessEnv)?.path;
  const ephemeralLlmRoutes: EphemeralLlmRouteOptions = {
    authBearerToken: appConfig.authBearerToken,
    nodeCredentials: nodeCredentialStore,
    generator: new CodexEphemeralExecutor({
      ...(ephemeralCodexPath === undefined ? {} : { codexPath: ephemeralCodexPath }),
      processEnv: ephemeralProcessEnv,
    }),
    antigravityGenerator: new AntigravityEphemeralExecutor({
      ...(ephemeralAntigravityPath === undefined ? {} : { agyPath: ephemeralAntigravityPath }),
      processEnv: ephemeralProcessEnv,
    }),
  };
  const ownedAgentRepository = new SqlOwnedAgentRepository(sqlResolver);
  const ownedAgentService = new OwnedAgentService(ownedAgentRepository,
    dbCatalogRepository.adminUsersRepository.findUserByEmail, config.mcp_external_ingress_bearer_token);
  const cardExecutionOwnerResolver = new FolderContentSqlResolver(sqlResolver);
  const cardExecutionOwnerRepository = new CardDispatchRepository(() => cardExecutionOwnerResolver.resolveSql());
  const resolveSessionOwner = createSessionOwnerResolver({
    getSession: async id => (await persistenceRepositoryProvider()).sessionReads.getSession(id),
    findUserByEmail: dbCatalogRepository.adminUsersRepository.findUserByEmail,
    findExternalAgent: ownedAgentService.findAgent,
    findCardExecutionUser: id => cardExecutionOwnerRepository.cardExecutionActorUser(id),
  });
  notifyPersistentReportPosted = async ({ sessionId, entry }) => {
    try {
      const owner = await resolveSessionOwner(sessionId);
      if (!owner?.ownerEmail) {
        context.warn(`지금의 보고 알림 생략(${sessionId}/${entry.key}): 소유자를 찾지 못했습니다`);
        return;
      }
      await pushNotifier.notifyPersistentReport({ ownerEmail: owner.ownerEmail, sessionId, entry });
    } catch (error) {
      context.warn(warningMessage(`지금의 보고 알림 발송 실패(${sessionId}/${entry.key})`, error));
    }
  };
  const orchestrationAccess = createCardOrchestrationAccess({
    getSession: async id => (await persistenceRepositoryProvider()).sessionReads.getSession(id),
    listFolders: async () => providers.folderRoutes.provider.listFolders(),
    findUserByEmail: dbCatalogRepository.adminUsersRepository.findUserByEmail,
  });
  cardDispatchRuntime=await createCardDispatchRuntime({sqlResolver,router:runtimeServices.sessionRouter,bridge:runtimeServices.sessionBridge,
    availability:providers.modelPresetAvailability,notifier:pushNotifier,admin:providers.adminUsersRoutes.provider,
    broadcaster:runtimeServices.sessionBroadcaster,defaultExecutionNodeId:config.default_execution_node_id,warn:context.warn,
    corsAllowedOrigins: config.cors_allowed_origins,
    onReportsChanged: updates => publishPersistentReports(updates),
    appendTimeline: (sessionId, event) => appendReportTimeline(sessionId, event),
    onQuestionAsked: async ({cardId,questionId}) => {
      const ownerEmail = await resolveCardOwnerEmail(cardId, {
        cardCreatorActor: id => cardExecutionOwnerRepository.cardCreatorActor(id),
        findUserByEmail: dbCatalogRepository.adminUsersRepository.findUserByEmail,
        resolveSessionOwner,
      });
      const outcome = await (await persistenceRepositoryProvider()).persistentReports!.placeQuestion(cardId, questionId);
      if (ownerEmail) {
        const cardService = await cardDispatchRuntime?.serviceProvider();
        const cardDetail = await cardService?.getCard(cardId);
        if (cardDetail) {
          const question = cardDetail.questions.find(item => String(item.id) === questionId);
          await pushNotifier.notifyCardQuestion({
            ownerEmail,
            cardId,
            questionId,
            folderId: cardDetail.card.folder_id,
            cardTitle: cardDetail.card.title,
            question: typeof question?.text === "string" ? question.text : "",
            questionTitle: typeof question?.title === "string" ? question.title : null,
            questionKind: question?.kind === "request" ? "request" : question?.kind === "choice" ? "choice" : null,
          });
        }
      }
      if (outcome.failed.length > 0)
        context.warn(`카드 질문 ${questionId} 판 게시: 성공 ${outcome.placed.length}, 실패 ${outcome.failed.length}`);
    },
    usageSnapshot: () => usageSummaryService.getSummary(),
    validateFolder: orchestrationAccess.validateFolder,
    resolveSessionOwner,
    findUserByEmail: dbCatalogRepository.adminUsersRepository.findUserByEmail,
    attachmentImport: providers.attachmentRoutes.assetUpload === undefined ? undefined : {
      readSource: providers.attachmentSourceRead,
      commits: providers.attachmentRoutes.assetUpload.commits,
      repository: providers.attachmentRoutes.assetUpload.repository,
    },
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
      nodeConnectedAtMs: (nodeId) => registry.getConnectedNode(nodeId)?.connectedAtMs,
      createRecurringSession: async ({ job, run }) => await createRecurringSession({
        router: runtimeServices.sessionRouter,
        bridge: runtimeServices.sessionBridge,
        modelPresetAvailability: providers.modelPresetAvailability,
      }, recurringSessionCreateInput(job, run)),
      findDurableSession: async (sessionId) => {
        const row = await (await persistenceRepositoryProvider()).sessionReads.getSession(sessionId);
        if (!row) return null;
        const rawStatus = row.status;
        return {
          status: isTerminalSessionStatus(rawStatus)
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
    nodeCredentials: nodeCredentialStore,
    onError: (error, operation) => context.warn(warningMessage(`recurring jobs ${operation}`, error)),
    onTick:()=>cardDispatchRuntime.dispatcher.tick(),
  });
  recurringJobScheduler = recurringJobWiring.scheduler;
  let externalEventsTarget: ExternalEventsService | undefined;
  const loadExternalEvents = async () => {
    if (config.mcp_external_events_state_file) externalEventsTarget = await ExternalEventsService.open({
      path: config.mcp_external_events_state_file, owner: credentialOwner(config.mcp_external_ingress_path!, config.mcp_external_ingress_bearer_token!),
    });
  };
  if (!overrides.pageGate) await loadExternalEvents();
  const externalEvents = config.mcp_external_events_state_file ? new Proxy({} as ExternalEventsService, {
    get(_target, key) {
      if (!externalEventsTarget) throw new Error("External events have not been loaded");
      const value = Reflect.get(externalEventsTarget, key, externalEventsTarget);
      return typeof value === "function" ? value.bind(externalEventsTarget) : value;
    },
  }) : undefined;
  const lifecycle=new OrchestratorLifecycle(buildInfo,runtimeServices.sessionBroadcaster);
  const productionSql = await sqlResolver.resolveSql() as unknown as SqlClient;
  // Shared with the future /x surface: one grant repository for the production pool.
  // Fail closed: without the user authorizer, the session access provider, or the
  // public origin, neither the store nor the management routes are created.
  const accessLinkSessionAccess = providers.sessionCatalogRoutes.accessProvider;
  const accessLinkAuthorizeUser = providers.authRoutes.authorizeUser;
  const accessLinkPublicUrl = config.soulstream_public_url?.trim() ?? "";
  const externalAccessGrants =
    accessLinkSessionAccess !== undefined
    && accessLinkAuthorizeUser !== undefined
    && accessLinkPublicUrl.length > 0
      ? new ExternalAccessGrantRepository({
          sql: productionSql,
          authorizeUser: accessLinkAuthorizeUser,
          requireSessionAccess: accessLinkSessionAccess.requireSessionAccess,
        })
      : undefined;
  // Shared with the #1457 /x surface: one token bucket and one admission
  // service for every external sender. Inbound webhook routes are registered
  // only when both the grant store and the intervention commands exist.
  const externalAccessTokenBucket = externalAccessGrants === undefined
    ? undefined
    : new ExternalAccessTokenBucket();
  const externalInputService = externalAccessGrants !== undefined
    && externalAccessTokenBucket !== undefined
    && providers.runtime.sessionActionCommandRoutes !== undefined
    ? new ExternalInputService({
        sql: productionSql,
        grants: externalAccessGrants,
        dispatch: createExternalInterventionDispatch(
          providers.runtime.sessionActionCommandRoutes,
        ),
        tokenBucket: externalAccessTokenBucket,
        logger: {
          warn: (fields, message) => context.warn(`${message}: ${JSON.stringify(fields)}`),
        },
      })
    : undefined;
  // The public access link surface wakes held status reads through this
  // in-process signal. It exists only when the admission service does, and
  // the /x routes are not registered without it (fail closed).
  const externalAccessReplySignal = externalInputService === undefined
    ? undefined
    : new ExternalReplySignal();
  // One management layer per direction, shared by the settings-screen routes
  // and the MCP webhook tools: the same store, services and access judgment.
  const inboundWebhookManagement = externalAccessGrants === undefined
    || externalInputService === undefined
    || accessLinkSessionAccess === undefined
    ? undefined
    : {
        grants: externalAccessGrants,
        requests: externalInputService,
        requireSessionAccess: accessLinkSessionAccess.requireSessionAccess,
        publicUrl: accessLinkPublicUrl,
      };
  const outboundWebhookManagement = {
    service: outboundWebhookService,
    authorizeUser: outboundAuthorizeUser,
    sessionAccess: outboundSessionAccess,
  };
  const app = createApp({
    oauthRoutes: {
      issuer: config.soulstream_public_url,
      sql: productionSql,
      dashboardAuth: {
        configProvider: providers.authRoutes.configProvider,
        jwt: providers.authRoutes.jwt,
        authorizeUser: providers.authRoutes.authorizeUser,
      },
    },
    externalEvents,
    ownedAgentRoutes: { currentEmail: providers.adminUsersRoutes.provider.currentEmail, service: ownedAgentService },
    ...(externalAccessGrants === undefined || accessLinkSessionAccess === undefined ? {} : {
      accessLinkRoutes: {
        currentEmail: providers.adminUsersRoutes.provider.currentEmail,
        grants: externalAccessGrants,
        requireSessionAccess: accessLinkSessionAccess.requireSessionAccess,
        publicUrl: accessLinkPublicUrl,
      },
    }),
    outboundWebhookRoutes: {
      currentEmail: providers.adminUsersRoutes.provider.currentEmail,
      ...outboundWebhookManagement,
    },
    ...(externalAccessGrants === undefined || externalInputService === undefined ? {} : {
      inboundHookRoutes: {
        grants: externalAccessGrants,
        service: externalInputService,
      },
    }),
    // Same store, service and login identity as the receive routes; the
    // management surface adds no new grant store, service or bucket instance.
    ...(inboundWebhookManagement === undefined ? {} : {
      inboundWebhookRoutes: {
        currentEmail: providers.adminUsersRoutes.provider.currentEmail,
        ...inboundWebhookManagement,
      },
    }),
    ...(externalAccessGrants === undefined
      || externalInputService === undefined
      || externalAccessTokenBucket === undefined
      || externalAccessReplySignal === undefined
      || accessLinkPublicUrl.length === 0
      ? {}
      : {
          externalAccessPublicRoutes: {
            sql: productionSql,
            publicUrl: accessLinkPublicUrl,
            grants: externalAccessGrants,
            inputService: externalInputService,
            history: new ConversationHistory(productionSql),
            stopSession: async (targetSessionId: string) =>
              (await executeInterruptCommand(
                providers.runtime.sessionActionCommandRoutes,
                targetSessionId,
              )).outcome,
            tokenBucket: externalAccessTokenBucket,
            eventHub: runtimeServices.sessionEventHub,
            replySignal: externalAccessReplySignal,
          },
        }),
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
      usageSummaryService!,
      nodeCredentialStore,
      config.cors_allowed_origins,
      folderProjectIdentityService,
      memoryStats,
      ephemeralLlmRoutes,
      cardDispatchRuntime.serviceProvider,
      createScheduleRepositoryProvider(sqlResolver),
      createFolderControlPlaneServiceProvider(sqlResolver),
      new LiveDatabaseSchemaProvider(sqlResolver),
      { enabled: config.atom_enabled, serverUrl: config.atom_server_url, apiKey: config.atom_api_key,
        nodeId: config.skill_catalog_node_id, catalogsNodeId: config.domain_catalog_node_id,
        typesafeApiKey: config.typesafe_api_key, httpClient: providers.atomRoutes.httpClient },
      cardDispatchRuntime.executionServiceProvider,
      lifecycle,
      cardDispatchRuntime.workDispatchServiceProvider,
      nodePairingService,
      productionSql,
      deadLetterStore,
      externalAccessReplySignal,
      config.default_execution_node_id,
      {
        ...(inboundWebhookManagement === undefined ? {} : { inbound: inboundWebhookManagement }),
        outbound: outboundWebhookManagement,
      },
      claudeCentralService,
      config.default_pas_agent_id,
      mcpCentralService,
    ),
    nodeReleaseRoutes: {
      authBearerToken: config.auth_bearer_token,
      environment: config.environment,
      nodeCredentials: nodeCredentialStore,
      releasesDir: config.portable_node_releases_dir,
      currentSourceCommit: () => buildInfo.currentBuildId(),
    },
    persistentContextRoutes: {
      authBearerToken: config.auth_bearer_token,
      nodeCredentials: nodeCredentialStore,
      logNullReason: (reason, sessionId, elapsedMs) => context.warn(
        `Persistent context evaluation skipped: reason ${reason}, session ${sessionId}, elapsed_ms ${elapsedMs}`,
      ),
      service: createPersistentContextService({
        candidates: createPersistentContextCandidateRepositories({
          searchDbConnectionFactory,
          storyReads: new SessionStoryReadRepository(
            await sqlResolver.resolveSql() as unknown as SqlClient,
            searchDbConnectionFactory,
            reportSearchCancelError,
          ),
          onCancelError: reportSearchCancelError,
        }),
        searchProvider: dbCatalogRepository.cogitoSearchProvider,
        typesafeApiKey: config.typesafe_api_key,
        logMissingInput: (sessionId, elapsedMs) => context.warn(
          `Persistent context evaluation skipped: reason input_event_not_found, session ${sessionId}, elapsed_ms ${elapsedMs}`,
        ),
        logNullReason: (reason, sessionId, elapsedMs) => context.warn(
          `Persistent context evaluation skipped: reason ${reason}, session ${sessionId}, elapsed_ms ${elapsedMs}`,
        ),
        logFinished: (sessionId, elapsedMs, searchMs, jevMs, selectedCount) => context.warn(
          `Persistent context evaluation finished: session ${sessionId}, elapsed_ms ${elapsedMs}, search_ms ${searchMs}, jev_ms ${jevMs}, selected ${selectedCount}`,
        ),
      }),
    },
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
      authBearerToken: config.auth_bearer_token,environment:config.environment,nodeCredentials: nodeCredentialStore,
    },
    cardOrchestrationDecisionRoutes: {
      authBearerToken:config.auth_bearer_token,environment:config.environment,nodeCredentials: nodeCredentialStore,
      authorizeDecision:cardDispatchRuntime.authorizeDecision,
      authorizeWorker:cardDispatchRuntime.authorizeWorker,
    },
  });
  if (overrides.pageGate) app.addHook("preHandler", async request => {
    const params = request.params as Record<string, unknown> | undefined;
    const nodeId = params?.node_id ?? params?.nodeId;
    if (typeof nodeId === "string" && request.url.startsWith("/api/nodes/")) await registry.waitForNode(nodeId);
  });
  turnSummaryPipeline = createLiveTurnSummaryPipeline({
    config,
    configPath: overrides.turnSummaryConfigPath ??
      fileURLToPath(new URL("../config/turn-summary.yaml", import.meta.url)),
    sqlResolver,
    registry,
    agentProfiles: dbCatalogRepository.agentProfileRepository.snapshot,
    eventHub: runtimeServices.sessionEventHub,
    commands: providers.runtime.sessionActionCommandRoutes,
    sessionBroadcaster: runtimeServices.sessionBroadcaster,
    logger: app.log,
    warn: context.warn,
    overrides,
  });
  const childSessionCheck = new ChildSessionCheckService({
    store: new ChildSessionCheckRepository(
      async () => (await sqlResolver.resolveSql()) as unknown as SqlClient,
    ),
    deliver: async (delivery) => {
      const response = await executeSessionIntervention(
        {
          ...providers.runtime.sessionActionCommandRoutes,
          deliveryRepositoryProvider: async () =>
            (await persistenceRepositoryProvider()).deliveries,
        },
        SERVICE_CALLER,
        delivery.callerSessionId,
        {
          text: delivery.text,
          delivery_id: delivery.deliveryId,
          delivery_intent: "human_live_steer",
          relation_key: delivery.deliveryId,
          completion_id: delivery.deliveryId,
          source: CHILD_SESSION_CHECK_SOURCE,
          caller_info: { source: "system" },
        },
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `child session check delivery failed with status ${response.status}: ${JSON.stringify(response.body)}`,
        );
      }
    },
    nodeState: (nodeId) => {
      if (registry.getConnectedNode(nodeId) === undefined) return { connected: false };
      return {
        connected: true,
        runningSessionIds: registry.getReportedRunningSessionIds(nodeId),
      };
    },
    warn: (message) => context.warn(message),
  });
  childSessionCheckService = childSessionCheck;
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
        try {
          await cardDispatchRuntime?.kickPendingWorkForNode(node.nodeId);
        } catch (error) {
          context.warn(warningMessage(`pending card work recovery failed for ${node.nodeId}`, error));
        }
      }
    },
    onDeliveryRecoveryError: (error) => {
      context.warn(warningMessage("pending immediate delivery recovery failed", error));
    },
    runChildSessionCheck: async () => await childSessionCheck.checkOnce(),
    onChildSessionCheckError: (error) => {
      context.warn(warningMessage("child session check failed", error));
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
  let resourcesClosed = false;
  let documentIndexWarmupTimer: ReturnType<typeof setTimeout> | undefined;
  let backgroundStart: Promise<void> | undefined;
  let backgroundStop: Promise<void> | undefined;
  let currentStopStep: string | undefined;
  const runStopStep = async (step: string, run: () => Promise<void> | void): Promise<void> => {
    currentStopStep = step;
    const startedAt = Date.now();
    try {
      await run();
    } finally {
      currentStopStep = undefined;
      app.log.info(
        {
          event: "orchestrator.stop_background_step",
          step,
          elapsed_ms: Math.max(0, Date.now() - startedAt),
        },
        "orchestrator stop background step",
      );
    }
  };
  const startBackground = async () => {
    backgroundStop = undefined;
    if (!externalEventsTarget) await loadExternalEvents();
    externalEventsTarget?.resumeWrites();
    deadLetterStore.resumeWrites();
    cardDispatchRuntime.dispatcher.resume();
    backgroundActive = true;
    outboundWebhookService?.start();
    await sessionReconciliation.start();
    const startRemaining = async () => {
      if (!backgroundActive) return;
      providers.sessionStatisticsRoutes.startBackground?.();
      await recurringJobScheduler?.start();
      await dbCatalogRepository.agentProfileRepository.list();
      try { await (await persistenceRepositoryProvider()).persistentReports!.syncActiveBoards(context.warn); }
      catch(error){context.warn(`PAS board boot refresh failed: ${String(error)}`);}
      await cardDispatchRuntime.dispatcher.dispatch();
      if (!backgroundActive) return;
      usageSummaryService.start(); maintenanceService.start(); turnSummaryPipeline?.start?.();
      claudeCentralService?.start();
      lifecycle.markReady();
      documentIndexWarmupTimer = setTimeout(() => {
        documentIndexWarmupTimer = undefined;
        const startedAt = Date.now();
        context.warn("session document index warmup started");
        void (dbCatalogRepository.cogitoSearchProvider.warmup?.() ?? Promise.resolve(0))
          .then((count) => context.warn(`session document index warmup finished: count=${count} elapsed_ms=${Date.now() - startedAt}`))
          .catch((error: unknown) => context.warn(`session document index warmup failed: elapsed_ms=${Date.now() - startedAt} error=${String(error)}`));
      }, SESSION_DOCUMENT_INDEX_WARMUP_DELAY_MS);
      documentIndexWarmupTimer.unref();
    };
    if (overrides.pageGate) {
      backgroundStart = overrides.pageGate.run(startRemaining).catch(error => context.warn(`background startup failed: ${String(error)}`));
    } else await startRemaining();
  };
  const stopBackground = (): Promise<void> => {
    if (backgroundStop !== undefined) return backgroundStop;
    backgroundStop = (async () => {
      backgroundActive = false;
      await runStopStep("outboundWebhook", () => outboundWebhookService?.stop());
      await runStopStep("sessionReconciliation", () => sessionReconciliation.close());
      await runStopStep("nodeRecoveryTasks", async () => { await Promise.allSettled([...nodeRecoveryTasks]); });
      await runStopStep("backgroundStart", async () => {
        await backgroundStart;
        if (documentIndexWarmupTimer !== undefined) { clearTimeout(documentIndexWarmupTimer); documentIndexWarmupTimer = undefined; }
      });
      await runStopStep("maintenance", () => maintenanceService.stop());
      await runStopStep("sessionStatistics", () => providers.sessionStatisticsRoutes.stopBackground?.());
      await runStopStep("recurringJobScheduler", () => recurringJobScheduler?.stop());
      await runStopStep("usageSummary", () => usageSummaryService.stop());
      await runStopStep("claudeCentral", () => claudeCentralService?.stop());
      await runStopStep("dispatcher.pause", () => cardDispatchRuntime.dispatcher.pause());
      await runStopStep("turnSummary.drain", () => turnSummaryPipeline?.drain());
      await runStopStep("externalEvents.pauseWrites", () => externalEventsTarget?.pauseWrites());
      await runStopStep("deadLetter.pauseWrites", () => deadLetterStore.pauseWrites());
    })();
    return backgroundStop;
  };
  /** Closes new writes and new card work without waiting for the stop steps still running. */
  const fenceWrites = async (): Promise<void> => {
    cardDispatchRuntime.dispatcher.fence();
    await Promise.all([externalEventsTarget?.pauseWrites(), deadLetterStore.pauseWrites()]);
  };
  const closeResources = async (handover: boolean) => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    const runShutdownStep = async (
      step: string,
      action: () => Promise<void> | void,
    ): Promise<void> => {
      context.onShutdownStage?.(step);
      const startedAt = Date.now();
      try {
        await action();
      } finally {
        app.log.info(
          {
            event: "orchestrator.shutdown_step",
            step,
            elapsed_ms: Math.max(0, Date.now() - startedAt),
          },
          "orchestrator shutdown step",
        );
      }
    };
    if (handover) {
      await runShutdownStep("background_stop", async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finished = await Promise.race([
          stopBackground().then(() => true),
          new Promise<false>(resolve => {
            timer = setTimeout(() => resolve(false), HANDOVER_BACKGROUND_STOP_WAIT_MS);
            timer.unref();
          }),
        ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
        if (!finished) {
          app.log.warn(
            {
              event: "orchestrator.handover.background_stop_over_budget",
              budget_ms: HANDOVER_BACKGROUND_STOP_WAIT_MS,
              ...(currentStopStep === undefined ? {} : { step: currentStopStep }),
            },
            "orchestrator handover exit: background stop is still running",
          );
        }
      });
    } else {
      backgroundActive = false;
      if (documentIndexWarmupTimer !== undefined) {
        clearTimeout(documentIndexWarmupTimer);
        documentIndexWarmupTimer = undefined;
      }
      await runShutdownStep("maintenance_stop", () => maintenanceService.stop());
      await runShutdownStep("session_reconciliation_close", () => sessionReconciliation.close());
      await runShutdownStep("recurring_scheduler_stop", () => recurringJobScheduler?.stop());
      await runShutdownStep("usage_summary_stop", () => usageSummaryService.stop());
      await runShutdownStep("claude_central_stop", () => claudeCentralService?.stop());
      await runShutdownStep("card_dispatch_drain", () => cardDispatchRuntime.dispatcher.drain());
      await runShutdownStep("turn_summary_drain", () => turnSummaryPipeline?.drain());
    }
    await runShutdownStep("push_notifier_close", () => pushNotifier.close());
    await runShutdownStep("db_catalog_close", () => dbCatalogRepository.close());
  };
  return {
    app,
    beginShutdown:()=>lifecycle.beginShutdown(),
    startBackground,
    stopBackground,
    fenceWrites,
    resumeBackground: startBackground,
    markOwner: () => registry.beginHandoverNodeWait(),
    waitForPendingCommands: async () => {
      const deadline = Date.now() + 3_000;
      while (registry.pendingCommandCount() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    },
    closePages: async () => {
      const timer = setTimeout(() => app.log.warn("page handover save exceeds 3 seconds"), 3_000);
      try { await pageYjsService?.closeForHandover(); } finally { clearTimeout(timer); }
    },
    closeResources: async () => await closeResources(false),
    closeHandoverResources: async () => await closeResources(true),
  };
}

/** 한 번의 재생에서 처리하는 배달 수 상한. 예전 100건 일괄 claim과 같은 값이다. */
const REPLAY_PENDING_DELIVERY_LIMIT = 100;

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
  // Send-time claims (card #1653): claiming 100 rows up front made every row after
  // the first 30-second node wait expire before it was even sent. Claim one row
  // right before sending it, in enqueue order, up to the same 100-row budget.
  // Rows already attempted in this pass are excluded so a row released with a
  // zero delay cannot be re-claimed and burn the retry budget in one pass.
  const attemptedDeliveryIds: string[] = [];
  while (attemptedDeliveryIds.length < REPLAY_PENDING_DELIVERY_LIMIT) {
    const claimed = await input.deliveries.recovery.claimPendingImmediateIntentsForNode(
      input.nodeId,
      attemptToken,
      1,
      DELIVERY_CLAIM_TTL_MS,
      [...attemptedDeliveryIds],
    );
    const row = claimed[0];
    if (!row) return;
    attemptedDeliveryIds.push(row.delivery_id);
    if (row.target_worktree_id !== null
      && (row.target_worktree_state === null || row.target_worktree_state === "removed")) {
      const failure = `target session worktree removed: ${row.target_worktree_id}`;
      await input.deliveries.markUncertain(row.delivery_id, attemptToken, failure);
      input.warn(failure);
      continue;
    }
    try {
      const parsed = sessionDeliveryInterventionPayload(row, attemptToken);
      if (!parsed.ok) throw new Error(parsed.message);
      const routed = await input.sessionRouter
        .routeExistingSessionPendingCommand(parsed.value);
      const response = await input.sessionBridge.sendPendingCommand(routed);
      if (response.status === "error" || response.type === "error") {
        throw new PendingNodeCommandRejectedError({
          commandType: routed.command.commandType,
          requestId: routed.command.requestId,
          message: String(response.message ?? response.code ?? "intervene failed"),
          response,
        });
      }
    } catch (error) {
      const failure = warningMessage(
        `${attemptTokenPrefix} delivery ${row.delivery_id} dispatch failed`,
        error,
      ) + nodeRejectionDetailsSuffix(error);
      await releaseDeliveryAttemptAfterSendFailure({
        repository: input.deliveries,
        deliveryId: row.delivery_id,
        attemptToken,
        error,
        failure,
        attemptCount: row.attempt_count,
      });
      input.warn(failure);
    }
  }
}

/**
 * 반복 작업 발사 입력. 만든 사람의 caller_info를 보존한 사본에 이 실행이
 * 스케줄러에서 나왔다는 표시 세 개를 덧붙인다. source는 바꾸지 않는다.
 */
export function recurringSessionCreateInput(
  job: Pick<
    RecurringJob,
    "jobId" | "prompt" | "nodeId" | "agentId" | "modelPreset" | "modelPresetFallbacks" | "folderId" | "executionCaller"
  >,
  run: Pick<RecurringJobRun, "runId" | "sessionId">,
): CreateRecurringSessionInput {
  return {
    sessionId: run.sessionId,
    prompt: job.prompt,
    nodeId: job.nodeId,
    agentId: job.agentId,
    modelPreset: job.modelPreset,
    modelPresetFallbacks: job.modelPresetFallbacks,
    folderId: job.folderId,
    callerInfo: {
      ...job.executionCaller,
      scheduled_by: "recurring_job",
      recurring_job_id: job.jobId,
      recurring_run_id: run.runId,
    },
  };
}

export function createCardWorkErrorSessionEffectApplier(
  applyEffect: EventSessionEffectApplier = applyEventSessionEffect,
): EventSessionEffectApplier {
  return async (sql, input) => {
    const effect = input.effect;
    if (effect.kind !== "terminal_transition" || effect.status !== "error"
      || effect.termination_reason !== "error_aborted") return await applyEffect(sql, input);
    const owner = (await sql<Array<{
      execution_command_id: string | null;
      execution_registration_id: string | null;
    }>>`SELECT execution_command_id,execution_registration_id
      FROM sessions WHERE session_id=${input.envelope.session_id}`)[0];
    const application = await applyEffect(sql, input);
    const canonical = application.canonicalSession;
    if (application.applied && canonical?.status === "error"
      && canonical.termination_reason === "error_aborted"
      && canonical.termination_event_id === input.eventId) {
      await relayCanonicalErrorTx(sql as unknown as RepositorySql, {
        sessionId: input.envelope.session_id,
        eventId: input.eventId,
        executionCommandId: owner?.execution_command_id ?? "",
        registrationId: owner?.execution_registration_id ?? "",
        applied: application.applied,
        status: canonical.status,
        terminationReason: canonical.termination_reason,
        message: canonical.termination_detail ?? effect.termination_detail ?? "",
      });
    }
    return application;
  };
}

export function createCardWorkErrorIngressCommitter(
  repository: Pick<EventIngressRepository, "commitBatch">,
  kickCanonicalWorkError: (sessionId: string, eventId: number) => Promise<void>,
) {
  return {
    async commitBatch(nodeId: string, batch: import("./node/event_ingress_types.js").EventAppendBatch) {
      const results = await repository.commitBatch(nodeId, batch);
      for (const result of results) {
        if (result.outcome === "dead_lettered") continue;
        const effect = result.envelope.session_effect;
        const canonical = result.sessionEffectApplication?.canonicalSession;
        if (effect?.kind === "terminal_transition" && effect.status === "error"
          && effect.termination_reason === "error_aborted"
          && result.sessionEffectApplication?.applied === true
          && canonical?.status === "error" && canonical.termination_reason === "error_aborted"
          && canonical.termination_event_id === result.eventId) {
          void kickCanonicalWorkError(result.envelope.session_id, result.eventId);
        }
      }
      return results;
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
  persistenceRepositoryProvider: NonNullable<
    CreateAppOptions["persistenceHostRoutes"]
  >["repositoryProvider"],
  usageSummary: UsageSummaryService,
  nodeCredentials: NodeCredentialResolver | null,
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
  workDispatchServiceProvider?: NonNullable<McpHostOptions["cards"]["workDispatchServiceProvider"]>,
  nodePairing?: NodePairingService,
  conversationSql?: SqlClient,
  deadLetterStore?: Pick<FileEventIngressDeadLetterStore, "list">,
  externalAccessReplySignal?: ExternalReplySignal,
  defaultExecutionNodeId?: string,
  webhooks?: McpHostOptions["webhooks"],
  claudeCentral?: ClaudeCentralService,
  defaultPasAgentId?: string | null,
  mcpCentral?: McpCentralService,
): CreateAppOptions {
  if (defaultExecutionNodeId === undefined) {
    throw new Error("default execution node is required to build production routes");
  }
  const sessionAccessProvider = providers.sessionCatalogRoutes.accessProvider;
  if (scheduleRepositoryProvider !== undefined && sessionAccessProvider === undefined) {
    throw new Error("session access provider is required for resume-after-limit routes");
  }
  if (sessionAccessProvider === undefined) {
    throw new Error("session access provider is required for persistent session settings routes");
  }
  // Session HTTP routes run the folder ACL for user identities only. A shared
  // service token or node credential is a service caller even when the body
  // carries a user email (task completion notifications do this), and the
  // dashboard access provider would otherwise resolve that email to a user ACL.
  const sessionRequestAccess: SessionRequestAccessGuard = {
    async requireSessionAccess(input) {
      if (isServiceCaller(input.request)) return;
      const service = verifyServiceBearerAuthorization(
        input.request.headers.authorization,
        {
          configuredToken: config.authBearerToken,
          environment: config.environment,
          nodeCredentials,
        },
      );
      if (service.ok && !service.developmentBypass) return;
      await sessionAccessProvider.requireSessionAccess(input);
    },
  };
  const persistentSessionSettingsService = new PersistentSessionSettingsService({
    reads: async () => (await persistenceRepositoryProvider()).sessionReads,
    access: sessionAccessProvider,
    catalog: providers.sessionCatalogRoutes.provider,
    commands: providers.runtime.sessionActionCommandRoutes,
    createSession: (request, body, logger) =>
      executeCreateSessionRoute(providers.runtime.sessionCommandRoutes, request, body, logger),
    presets: providers.modelPresetAvailability,
    profiles: providers.nodeAgentProfileRoutes.provider,
    modelCatalog: providers.modelCatalog,
    defaultExecutionNodeId,
    ...(defaultPasAgentId === undefined ? {} : { defaultPasAgentId }),
  });
  const conversationService = conversationSql ? new ConversationService({
    sql: conversationSql, access: sessionAccessProvider, persistent: persistentSessionSettingsService,
    reads: async () => (await persistenceRepositoryProvider()).sessionReads,
    catalog: new ConversationCatalog({
      defaultNodeId: defaultExecutionNodeId,
      listNodes: () => runtime.registry.listAllNodes().map(node => ({ nodeId: node.nodeId, connected: node.connected })),
      listKnownForNode: nodeId => providers.modelPresetAvailability.listKnownForNode(nodeId),
      listAgentProfiles: nodeId => providers.nodeAgentProfileRoutes.provider.listAgentProfiles(nodeId),
    }),
    create: (request, body, id, logger) => executeCreateSessionRoute(providers.runtime.sessionCommandRoutes, request, body, logger, id),
    waitForCreatedSession: (id, nodeId) => providers.runtime.sessionCommandRoutes.router.waitForCreatedSession(id, nodeId),
    moveSessionToFolder: async (sessionId, folderId) => {
      await providers.sessionCatalogRoutes.provider.moveSessionsToFolder([sessionId], folderId);
    },
  }) : undefined;
  const conversationPorts = conversationSql ? createConversationMessagePorts(conversationSql, providers.attachmentRoutes, {
    ...providers.runtime.sessionActionCommandRoutes,
    deliveryRepositoryProvider: async () => (await persistenceRepositoryProvider()).deliveries,
  }) : undefined;
  const uploadInlineAttachment: SessionActionInlineAttachmentUpload | undefined = conversationPorts === undefined
    ? undefined
    : async (caller: FastifyRequest | ServiceCaller, sessionId, file, uploadId) => {
        if (!("headers" in caller)) {
          throw Object.assign(new Error("Fastify request required for inline attachment upload"), {
            code: "ATTACHMENT_INPUT_UNAVAILABLE",
            statusCode: 503,
          });
        }
        return await conversationPorts!.upload(caller, sessionId, file, uploadId);
      };
  return {
    config,
    corsAllowedOrigins,
    ...(conversationService ? { conversationRoutes: { service: conversationService,
      messages: new ConversationMessageService(conversationSql!, conversationPorts!), liveEvents: providers.runtime.sessionHistoryRoutes.liveEvents, closeAfterHistorySync: providers.runtime.sessionHistoryRoutes.closeAfterHistorySync, resolveAccount: async (request) => {
      const service = verifyServiceBearerAuthorization(request.headers.authorization, {
        configuredToken: config.authBearerToken,
        environment: config.environment,
        nodeCredentials,
      });
      if (service.ok && !service.developmentBypass) return "service-token";
      const email = await providers.authenticatedUserResolvers.resolveEmail(request);
      if (email) return email.trim().toLowerCase();
      return service.ok ? "service-token" : null;
    } } } : {}),
    productionAuth: {
      resolveTokenAccess: providers.authRoutes.resolveTokenAccess,
      resolveOAuthAccess: providers.authenticatedUserResolvers.resolveOAuthAccess,
      nodeCredentials,
    },
    adminUsersRoutes: providers.adminUsersRoutes,
    atomRoutes: providers.atomRoutes,
    authRoutes: providers.authRoutes,
    attachmentRoutes: providers.attachmentRoutes,
    ...(providers.agentAttachmentRoutes === undefined ? {} : { agentAttachmentRoutes: providers.agentAttachmentRoutes }),
    ...(providers.workerAttachmentRoutes === undefined ? {} : { workerAttachmentRoutes: providers.workerAttachmentRoutes }),
    boardAssetRoutes: providers.boardAssetRoutes,
    boardItemRoutes: {
      ...providers.boardItemRoutes,
      host: providers.runtime.flatFolderContentRoutes.host,
    },
    flatFolderContentRoutes: providers.runtime.flatFolderContentRoutes,
    pageYjsRoutes: runtime.routeOptions.pageYjsRoutes,
    cogitoRoutes: providers.cogitoRoutes,
    executeProxyRoutes: providers.executeProxyRoutes,
    ...(ephemeralLlmRoutes === undefined ? {} : { ephemeralLlmRoutes }),
    ...(folderControlPlaneServiceProvider ? {
      mcpHostRoutes: {
        ...(conversationSql === undefined ? {} : {
          externalAccess: {
            sql: conversationSql,
            ...(externalAccessReplySignal === undefined
              ? {}
              : { replySignal: externalAccessReplySignal }),
          },
        }),
        ...(webhooks === undefined ? {} : { webhooks }),
        sessionMessages: providers.runtime.sessionActionCommandRoutes,
        persistentSessionSettings: persistentSessionSettingsService,
        authBearerToken: config.authBearerToken,
        nodeCredentials,
        ...(nodePairing ? { nodePairing } : {}),
        ...(mcpSkills ? { skills: mcpSkills } : {}),
        cards: { cardServiceProvider, provider: providers.folderRoutes.provider, resolveAccess: serviceTokenAccessWithoutEmail,
          ...(cardExecutionServiceProvider ? { cardExecutionServiceProvider } : {}),
          ...(workDispatchServiceProvider ? { workDispatchServiceProvider } : {}) },
        cluster: {
          nodes: providers.runtime.nodeSnapshotRoutes,
          nodeAgentProfiles: providers.nodeAgentProfileRoutes,
          centralAgentProfiles: { ...providers.agentProfileRoutes, modelCatalog: providers.modelCatalog },
          cogito: providers.cogitoRoutes,
          sessions: providers.runtime.sessionCommandRoutes,
          readSession: async id => (await persistenceRepositoryProvider()).sessionReads.getSession(id),
          ...(deadLetterStore === undefined ? {} : {
            eventIngress: {
              listDeadLetters: (input) => deadLetterStore.list(input),
              ...(conversationSql === undefined ? {} : {
                deliveryLatency: (input) =>
                  queryEventIngressDeliveryLatency(conversationSql as unknown as DeliveryLatencySql, input),
              }),
            },
          }),
        },
        board: {
          host: providers.runtime.flatFolderContentRoutes.host,
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
          nodeCredentials,
        },
      },
    } : {}),
    folderRoutes: {
      ...providers.folderRoutes,
      nodeCredentials,
      ...(cardExecutionServiceProvider ? {cardExecutionServiceProvider} : {}),
      ...(cardServiceProvider ? { cardServiceProvider } : {}),
      ...(cardServiceProvider ? {
        uploadCardCommentAttachment: createCardCommentAttachmentUploader(
          providers.attachmentRoutes, { defaultNodeId: defaultExecutionNodeId }),
        sendCardSessionMessage: (request, sessionId, body) =>
          executeSessionIntervention({
            ...providers.runtime.sessionActionCommandRoutes,
            ...(uploadInlineAttachment === undefined ? {} : { uploadInlineAttachment }),
          }, request, sessionId, body),
      } : {}),
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
      serviceProvider: () => providers.runtime.flatFolderContentRoutes.host.documents,
    },
    nodeAgentProfileRoutes: providers.nodeAgentProfileRoutes,
    agentProfileRoutes: providers.agentProfileRoutes,
    contextBundleRoutes: providers.contextBundleRoutes,
    nodeClaudeAuthRoutes: {
      ...providers.nodeClaudeAuthRoutes,
      registry: runtime.registry,
      bridge: runtime.sessionBridge,
      usageSummary,
    },
    nodeSnapshotRoutes: providers.runtime.nodeSnapshotRoutes,
    ...(nodePairing ? { nodePairRoutes: { service: nodePairing } } : {}),
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
            nodeCredentials,
          },
        }
      : {}),
    persistenceHostRoutes: {
      repositoryProvider: persistenceRepositoryProvider,
      authBearerToken: config.authBearerToken,
      nodeCredentials,
      nodeConnectedAtMs: (nodeId) =>
        runtime.registry.getConnectedNode(nodeId)?.connectedAtMs,
      onSessionDeliveryFailed: (sessionId) => {
        runtime.sessionBroadcaster.append({
          type: "session_delivery_failed",
          agent_session_id: sessionId,
        });
      },
    },
    sessionActionCommandRoutes: {
      ...providers.runtime.sessionActionCommandRoutes,
      accessProvider: sessionRequestAccess,
      ...(uploadInlineAttachment === undefined ? {} : { uploadInlineAttachment }),
      onHumanSessionInput: async targetSessionId => {
        if (!cardServiceProvider) return;
        const cards=await cardServiceProvider();
        const assigned=await cards.getAssignedCardContext(targetSessionId);
        for (const summary of assigned.cards) {
          if (summary.status!=="blocked" && summary.status!=="awaiting_verification") continue;
          const detail=await cards.getCard(summary.id);
          if (!detail) continue;
          const card=detail.card;
          const resumable=card.status==="awaiting_verification" || (card.status==="blocked" && card.blocked_kind!=="limit");
          if (!resumable || card.archived!==false
            || card.assignee_kind!=="session" || card.assignee_session_id!==targetSessionId) continue;
          await cards.resumeBlockedCardOnHumanInput({cardId:card.id,expectedVersion:card.version});
          return;
        }
      },
      acceptPersistentReportReply: async (sessionId, contextItems, callerInfo, request) => {
        const decision = await (await persistenceRepositoryProvider()).persistentReports!.acceptReply(sessionId,contextItems,callerInfo);
        if (decision.action === "none") return { handled: false };
        // 카드 질문 접수는 로그인한 사용자 요청에서만 한다. ServiceCaller/agent를 사용자로 승격시키지 않는다.
        if (!("log" in request))
          return { handled: false, failure: { status: 403, body: { detail: { error: {
            code: "CARD_QUESTION_REPLY_FORBIDDEN", message: "카드 질문 답은 로그인한 사용자 요청에서만 접수됩니다",
          } } } } };
        if (!cardServiceProvider)
          return { handled: false, failure: { status: 503, body: { detail: { error: { code: "CARD_SERVICE_UNAVAILABLE" } } } } };
        try {
          const failure = await applyCardQuestionReply(decision, {
            sessionId, request,
            requireSessionAccess: input => sessionAccessProvider.requireSessionAccess(input),
            cardOptions: { cardServiceProvider, provider: providers.folderRoutes.provider },
            resolveAccess: () => providers.folderRoutes.accessProvider.resolveAccess(request),
            resolveActor: () => dashboardFolderActor(request, providers.folderRoutes),
          });
          if (failure) return { handled: false, failure };
        } catch (error) {
          return { handled: false, failure: cardRouteErrorResponse(error) };
        }
        return { handled: true };
      },
      deliveryRepositoryProvider: async () =>
        (await persistenceRepositoryProvider()).deliveries,
    },
    sessionBackgroundScheduleRoutes: {
      ...providers.runtime.sessionBackgroundScheduleRoutes,
      accessProvider: sessionRequestAccess,
    },
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
    persistentSessionRoutes: {
      service: persistentSessionSettingsService,
      reports: { remove: async (sessionId,key) => (await persistenceRepositoryProvider()).persistentReports!.remove(sessionId,key) },
      requireSessionAccess: sessionAccessProvider.requireSessionAccess,
    },
    sessionCommandRoutes: {
      ...providers.runtime.sessionCommandRoutes,
      accessProvider: sessionRequestAccess,
    },
    sessionHistoryRoutes: providers.runtime.sessionHistoryRoutes,
    ...(providers.sessionWorkspaceRoutes ? { sessionWorkspaceRoutes: providers.sessionWorkspaceRoutes } : {}),
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
    sessionStatisticsRoutes: providers.sessionStatisticsRoutes,
    uiEventRoutes: providers.uiEventRoutes,
    ...(mcpCentral === undefined ? {} : { mcpCentralRoutes: { service: mcpCentral, provider: providers.adminUsersRoutes.provider } }),
    ...(claudeCentral === undefined
      ? {}
      : { claudeCentralRoutes: { service: claudeCentral } }),
  };
}

async function closeApplication(
  application: ProductionApplication,
  onShutdownStage?: ShutdownStageReporter,
  handover = false,
): Promise<void> {
  const runShutdownStep = async (
    step: string,
    action: () => Promise<void> | void,
  ): Promise<void> => {
    onShutdownStage?.(step);
    const startedAt = Date.now();
    try {
      await action();
    } finally {
      application.app.log.info(
        {
          event: "orchestrator.shutdown_step",
          step,
          elapsed_ms: Math.max(0, Date.now() - startedAt),
        },
        "orchestrator shutdown step",
      );
    }
  };
  await runShutdownStep("shutdown_notice", () => application.beginShutdown?.());
  let appCloseError: unknown;
  try {
    await runShutdownStep("app_close", () => application.app.close());
  } catch (error) {
    appCloseError = error;
  }
  try {
    await runShutdownStep("resources_close", () => handover && application.closeHandoverResources
      ? application.closeHandoverResources() : application.closeResources());
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
