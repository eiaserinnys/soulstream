import { antigravityEnvironment } from "../engine/antigravity_env.js";
import { AgentConfigService } from "../agent_config_service.js";
import { FileAttachmentStore } from "../attachments/file_manager.js";
import { ProviderUsageService } from "../auth/provider_usage.js";
import { CatalogService } from "../catalog/catalog_service.js";
import { FlatFolderContentHostClient } from "../catalog/flat_folder_content_host_client.js";
import { DEFAULT_COGITO_CONTEXT_LIMITS } from "../context/cogito_context.js";
import { ExecutionContextBuilder } from "../context/context_builder.js";
import { createAssignedCardSnapshotRecorder } from "../context/assigned_card_snapshot_recorder.js";
import { createPersistentJevObserver } from "../context/persistent_jev_observer.js";
import { DefaultPageContextAssembler } from "../context/page_context_assembler.js";
import { HostPageContextRepository } from "../context/page_context_repository.js";
import { AncestorPageContextResolver } from "../context/page_context_resolver.js";
import {
  ClaudeRuntimeHostClient,
  SessionDeliveryHostClient,
  SessionMutationHostClient,
  SessionPageBindingHostClient,
} from "../control_plane/persistence_host_clients.js";
import { SessionDataHostClient } from "../control_plane/session_data_host_client.js";
import { EventPersistence } from "../db/event_persistence.js";
import { SessionDB } from "../db/session_db.js";
import { PersistentReportHostClient } from "../control_plane/persistent_report_host_client.js";
import { DbClaudeSessionStore } from "../engine/claude_session_store.js";
import { AnthropicAdapter, OpenAIAdapter } from "../llm/adapters.js";
import { LlmExecutor } from "../llm/executor.js";
import { buildOrchProxyConfig } from "../mcp/orch_proxy.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { subscribeModelCatalogReannounce } from "../model_catalog.js";
import { RealtimeBroker } from "../realtime/realtime_broker.js";
import { FolderService } from "../folder/folder_service.js";
import { FolderHostClient } from "../folder/folder_host_client.js";
import { PageYjsHostClient } from "../page/page_host_client.js";
import { SessionLegacyProjection, SessionPageBindingService } from "../page/session_page_binding_service.js";
import { SoulstreamScheduleService } from "../schedule/schedule_service.js";
import { ScheduleHostClient } from "../schedule/schedule_host_client.js";
import { buildServer } from "../server.js";
import { TaskEngineEventPublisher } from "../task/task_engine_event_publisher.js";
import { redeliverStoredDeliveryContent } from "../task/delivery_row_intervention.js";
import { TransientEventLogAggregator } from "../task/transient_event_log_aggregator.js";
import { TaskManager } from "../task/task_manager.js";
import { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import { UpstreamAdapter } from "../upstream/adapter.js";
import { EventOutbox } from "../upstream/event_outbox.js";
import { EventOutboxPump } from "../upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";
import { composeTaskRuntime, createWorkerAttachmentRuntime, type TaskRuntimeComposition } from "./task_runtime_composition.js";
import type { SessionDeliveryRow } from "../db/session_db_types.js";
import { composeClaudeRuntime, composeClaudeAccountServices, composeQueuedDeliveryStartupRecovery, createClaudeAccountPoolRegistry } from "./claude_runtime_composition.js";
import { composeClaudeLoginService, seedLegacyClaudeAccount } from "./claude_login_runtime_composition.js";
import { createDetachedClaudeEventBridge } from "./detached_claude_event_bridge.js";
import { createEngineFactory } from "./engine_factory.js";
import { backgroundLifecycleObserver, composeRunnerOrphanReaper, composeRunnerProcessRuntime, composeRunnerRecoveryCoordinator } from "./runner_process_composition.js";
import { composeSessionIsolation } from "./session_isolation_composition.js"; import { composeCompletionSettlement } from "./completion_settlement_composition.js";
import { resolveNodeServicesObservation } from "../mcp/node_services_observation_config.js";
import type { WorkerComposition, WorkerCompositionParams } from "./worker_composition_types.js";
import { composeWorkerUpstreamAdapter, createBroadcasterSend } from "./worker_upstream_composition.js";
import { buildMcpServerOptions } from "./mcp_server_options.js";
import { composeWorktreeService, composeWorktreeSweeper, resolveWorktreeWorkspace } from "./worktree_runtime_composition.js";
import { listActiveTaskWorkspaceDirs } from "./task_active_workspace_dirs.js";
import { composePurposeDecisionRunner, composeWorkerAdmissionAuthorizer } from "../card-orchestration/runtime_composition.js";
export type { WorkerComposition, WorkerCompositionParams } from "./worker_composition_types.js";
export async function composeWorkerRuntime(params: WorkerCompositionParams): Promise<WorkerComposition> {
  const { env, logger, agentRegistry, mcpConfigService, codexCliPath, antigravityCliPath, agentProfileSource } = params;
  const modelCatalog = params.modelCatalog;
  let upstreamAdapter: UpstreamAdapter | null = null;
  if (params.modelCatalogStore) {
    subscribeModelCatalogReannounce({ store: params.modelCatalogStore, logger, currentAdapter: () => upstreamAdapter });
  }
  const agentConfigService = new AgentConfigService({
    configPath: env.AGENTS_CONFIG_PATH,
    agentRegistry,
    profileSource: agentProfileSource,
    profileResolver: (profiles) => mcpConfigService.resolveProfilesIsolated(profiles, logger),
    isDbIdentityOwnedProfile: agentProfileSource?.isDbIdentityOwnedProfile?.bind(agentProfileSource),
    onAfterRegistryReplace: async () => {
      if (!upstreamAdapter) {
        logger.warn({ nodeId: env.SOULSTREAM_NODE_ID }, "Agent catalog reannounce skipped — UpstreamAdapter not ready");
        return;
      }
      await upstreamAdapter.reannounceAgentCatalog();
    },
  });
  const { claudeAuth, claudeAccounts } = composeClaudeAccountServices(env, logger);
  if (claudeAccounts) await seedLegacyClaudeAccount({ env, accounts: claudeAccounts, claudeAuth, logger });
  const claudeLoginService = claudeAccounts ? composeClaudeLoginService({ accounts: claudeAccounts, claudeAuth, logger }) : undefined;
  const providerUsage = new ProviderUsageService({
    claudeAuth, claudeAccounts, modelCatalog, logger, opencodeGo: { apiKey: process.env.OPENCODE_GO_API_KEY },
    antigravity: {
      cliPath: antigravityCliPath?.path,
      environment: antigravityEnvironment(process.env),
      // Required by the existing process-runner startup configuration.
      stateDirectory: env.SOUL_RUNNER_STATE_DIR!,
    },
  });
  const eventOutbox = await EventOutbox.open(env.EVENT_OUTBOX_DIR);
  const eventOutboxPump = new EventOutboxPump(eventOutbox, (error) => {
    logger.error({ err: error }, "Durable event outbox pump failed");
  }, {
    onQuarantine: (result) => {
      logger.warn({
        path: result.path,
        sourceSeq: result.sourceSeq,
        sessionId: result.sessionId,
        code: result.code,
        attempts: result.attempts,
      }, "Durable event outbox head quarantined after repeated rejection");
    },
  });
  const eventOutboxPumpMux = new EventOutboxPumpMux(eventOutboxPump);
  const db = new SessionDB();
  const claudeSessionStore = new DbClaudeSessionStore(db);
  const broadcaster = new SessionBroadcaster(createBroadcasterSend(() => upstreamAdapter, logger), agentRegistry, env.SOULSTREAM_NODE_ID);
  const persistence = new EventPersistence(
    db,
    broadcaster,
    logger,
    eventOutbox,
    eventOutboxPump,
  );
  const transientEventLogAggregator = new TransientEventLogAggregator(logger);
  const realtimeBroker = new RealtimeBroker({
    agentRegistry,
    db,
    persistence,
    broadcaster,
    logger,
    processEnv: process.env,
    modelCatalog,
  });
  const orchProxyConfig = buildOrchProxyConfig(env), attachmentRuntime = createWorkerAttachmentRuntime(env, orchProxyConfig, persistence);
  const orchHostClientDeps = { orch: orchProxyConfig, logger };
  const observePersistentResume = createPersistentJevObserver({
    orch: orchProxyConfig,
    persistence,
    logger,
  });
  const sessionMutations = new SessionMutationHostClient(orchHostClientDeps);
  const claudeRuntimeHost = new ClaudeRuntimeHostClient(orchHostClientDeps);
  db.configurePersistenceHosts({
    deliveries: new SessionDeliveryHostClient(orchHostClientDeps),
    claudeRuntime: claudeRuntimeHost,
    sessionPageBindings: new SessionPageBindingHostClient(orchHostClientDeps),
    sessionData: new SessionDataHostClient(orchHostClientDeps),
  });
  const boardYjsAuth = {
    authBearerToken: env.AUTH_BEARER_TOKEN,
    environment: env.ENVIRONMENT,
    dashboardAuthEnabled: Boolean(env.GOOGLE_CLIENT_ID),
    jwtSecret: env.JWT_SECRET,
  };
  const folderContentHost = new FlatFolderContentHostClient(orchHostClientDeps);
  db.configureFolderContentHost(folderContentHost);
  logger.info(
    { nodeId: env.SOULSTREAM_NODE_ID },
    "Folder content delegated to orchestrator",
  );
  const sessionPageBindingRepository = db.sessionPageBindings();
  const pageHost = new PageYjsHostClient(orchHostClientDeps);
  db.configureFolderHost(new FolderHostClient(orchHostClientDeps));
  const sessionPageBindingService = new SessionPageBindingService({
    nodeId: env.SOULSTREAM_NODE_ID,
    repository: sessionPageBindingRepository,
    pageHost,
    legacyProjection: new SessionLegacyProjection(db, folderContentHost),
    logger,
  });
  sessionPageBindingService.start();
  const pageContextResolver = new AncestorPageContextResolver(
    new HostPageContextRepository(sessionPageBindingRepository, pageHost),
    new DefaultPageContextAssembler(),
    logger,
  );
  const nodeContextConfig = { baseUrl: orchProxyConfig.baseUrl, headers: orchProxyConfig.headers, ...DEFAULT_COGITO_CONTEXT_LIMITS };
  const contextBuilder = new ExecutionContextBuilder(
    db,
    agentRegistry,
    {
      nodeId: env.SOULSTREAM_NODE_ID,
      captureAssignedCardContext: createAssignedCardSnapshotRecorder(persistence, logger),
      atom: {
        enabled: Boolean(env.ATOM_ENABLED),
        serverUrl: env.ATOM_SERVER_URL ?? "",
        apiKey: env.ATOM_API_KEY ?? "",
      },
      cogito: nodeContextConfig,
      nodeResources: nodeContextConfig,
    },
    logger,
    pageContextResolver,
  );
  const detachedClaudeEventPublisher = env.CLAUDE_SESSION_RUNTIME_V2_ENABLED
    ? new TaskEngineEventPublisher({
        broadcaster, logger, persistence, transientEventLogAggregator,
      })
    : undefined;
  let taskRuntime!: TaskRuntimeComposition, taskManager!: TaskManager;
  let worktreeService: ReturnType<typeof composeWorktreeService>;
  const publishDetachedClaudeEvent = createDetachedClaudeEventBridge({
    logger,
    findTask: (sessionId) => taskManager.getTask(sessionId),
    loadTask: (sessionId) => taskManager.hydrateRunnerRecoveryTask(sessionId),
    getPublisher: () => detachedClaudeEventPublisher,
    collectDetached: (task, payload) => taskRuntime.claudeRuntimeTaskFollowup.collectDetached(task, payload),
    terminateAfterFatalEngineError: (task, message) => taskRuntime.taskExecutor.terminateAfterFatalEngineError(task, message).then(() => undefined),
  });
  const queuedRecoveryParams = {
    db, agentRegistry, modelCatalog,
    sessionStore: claudeSessionStore,
    sourceNode: env.SOULSTREAM_NODE_ID, logger,
    resolveWorktreeWorkspace: (worktreeId: string) => resolveWorktreeWorkspace(worktreeService, worktreeId),
    redeliverContent: (row: SessionDeliveryRow) => redeliverStoredDeliveryContent(row, taskManager, taskRuntime.onResume),
    getTask: (sessionId: string) => taskManager.getTask(sessionId),
  };
  const claudeRuntime = env.CLAUDE_SESSION_RUNTIME_V2_ENABLED
    ? await composeClaudeRuntime({
        enabled: true,
        ...queuedRecoveryParams,
        getModelCatalog: () => modelCatalog.snapshot(),
        idleTtlMs: env.CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS, maxEntries: env.CLAUDE_SESSION_RUNTIME_MAX_ENTRIES,
        turnInactivityTimeoutMs: env.CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS,
        ...(claudeAccounts ? { claudeAccountTurnPort: claudeAccounts } : {}),
        detachedEventSink: async (sessionId, event) => {
          const collectDetached = await publishDetachedClaudeEvent(sessionId, event);
          await collectDetached();
        },
      })
    : {};
  const claudeSessionClientRegistry = claudeRuntime.registry ?? (
    claudeAccounts
      ? createClaudeAccountPoolRegistry({
          claudeAccountTurnPort: claudeAccounts,
          idleTtlMs: env.CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS,
          maxEntries: env.CLAUDE_SESSION_RUNTIME_MAX_ENTRIES,
          logger,
          getModelCatalog: () => modelCatalog.snapshot(),
        })
      : undefined
  );
  taskManager = new TaskManager(
    env.SOULSTREAM_NODE_ID,
    db,
    broadcaster,
    logger,
    persistence,
    contextBuilder,
    agentRegistry,
    folderContentHost,
    sessionPageBindingService,
    env.CLAUDE_SESSION_RUNTIME_V2_ENABLED,
    claudeSessionClientRegistry,
    modelCatalog,
    sessionMutations,
    observePersistentResume, attachmentRuntime.taskRuntime.prepareAttachmentInput,
  );
  worktreeService = composeWorktreeService(env, orchHostClientDeps,
    () => listActiveTaskWorkspaceDirs(taskManager.listTasks(), (profileId) => agentRegistry.get(profileId)?.workspace_dir));
  const worktreeSweeper = composeWorktreeSweeper(worktreeService, logger);
  const sessionIsolation = composeSessionIsolation({ env, worktreeService, mcpConfigService, codexCliPath });
  const nodeServicesObservation = resolveNodeServicesObservation(env);
  db.configureScheduleHost(new ScheduleHostClient(orchHostClientDeps));
  const scheduleService = new SoulstreamScheduleService(db.schedules(), broadcaster, persistence, logger);
  const engineFactory = createEngineFactory({
    env,
    logger,
    codexCliPath,
    antigravityCliPath,
    antigravityProcessEnv: process.env,
    codexProcessEnv: process.env,
    buildClaudeProcessEnv: () => claudeAuth.buildProcessEnv(process.env),
    claudeSessionStore,
    ...(claudeAccounts ? { claudeAccountTurnPort: claudeAccounts } : {}),
    mcpConfigService,
    getModelCatalog: () => modelCatalog.snapshot(),
    ...(claudeSessionClientRegistry ? { claudeSessionClientRegistry } : {}),
  });
  const runnerProcess = await composeRunnerProcessRuntime(env.SOUL_RUNNER_PROCESS_ENABLED, {
    env, logger, mcpConfigService, codexCliPath, antigravityCliPath,
    ...(params.nodeStallMonitor ? { nodeStallMonitor: params.nodeStallMonitor } : {}),
    pumpMux: eventOutboxPumpMux, sessionStore: claudeSessionStore,
    claudeAccounts,
    producedAttachments: attachmentRuntime.mcpRuntime.producedAttachments,
    buildChildProcessEnv: () => claudeAuth.buildProcessEnv(process.env), publishDetachedClaudeEvent,
    reconcileClaudeTranscriptAppend: (task) => taskRuntime.claudeRuntimeTaskFollowup.reconcileTranscriptAppend(task),
    observeClaudeRuntime: backgroundLifecycleObserver(claudeRuntime.backgroundLifecycle),
    releaseManifest: params.releaseActivationState.manifest,
    modelCatalogPath: params.modelCatalogPath,
    isolationHost: sessionIsolation?.host,
  });
  params.releaseActivationState.markPrewarmed({
    host: "verified",
    runner: "verified",
    env: "verified",
    executable: "verified",
  });
  taskRuntime = composeTaskRuntime({
    env,
    db,
    logger,
    agentRegistry,
    taskManager,
    engineFactory,
    modelCatalog,
    contextBuilder,
    persistence,
    broadcaster,
    scheduleService,
    providerUsage, ...attachmentRuntime.taskRuntime,
    orchProxyConfig,
    transientEventLogAggregator,
    ...(claudeRuntime.transcriptReceipt
      ? { claudeTranscriptReceipt: claudeRuntime.transcriptReceipt }
      : {}),
    ...(runnerProcess ? { runnerProcessFactory: runnerProcess.runtimeFactory } : {}),
    ...(worktreeService ? { worktreeResolver: worktreeService } : {}),
    sessionMutations,
    sessionIsolation,
  });
  taskManager.setCompletionNotifier(taskRuntime.completionNotifier);
  const settlement = composeCompletionSettlement({ env, logger, db, eventOutbox, completionNotifier: taskRuntime.completionNotifier, scheduleService });
  const runnerRecoveryCoordinator = await composeRunnerRecoveryCoordinator({
    hasPendingRunnerSettlement: settlement.hasPendingRunnerSettlement,
    env,
    runnerProcessFactory: runnerProcess?.runtimeFactory,
    releaseGarbageCollector: runnerProcess?.releaseGarbageCollector,
    sessionGarbageCollector: runnerProcess?.sessionGarbageCollector,
    closedTailDrainer: runnerProcess?.closedTailDrainer,
    taskManager,
    taskExecutor: taskRuntime.taskExecutor,
    readCentralSession: (sessionId) => db.getSession(sessionId),
    logger,
    ...(params.nodeStallMonitor ? { nodeStallMonitor: params.nodeStallMonitor } : {}),
    ...(claudeRuntime.backgroundLifecycle
      ? {
        terminalizeClaudeBackgroundTasks: (sessionId, execution) =>
          claudeRuntime.backgroundLifecycle!.terminalizeDeadRunner(sessionId, execution),
        completionNotifier: taskRuntime.completionNotifier,
      }
      : {}),
    ...(runnerProcess ? { recoveryStorage: runnerProcess.recoveryStorage } : {}),
  });
  settlement.wireTerminationCleanup({ owners: [taskManager, taskRuntime.taskExecutor], retireRejectedRegistration: runnerRecoveryCoordinator && (async (task, id) => await runnerRecoveryCoordinator.retireRejectedTerminalRegistration(task, id)), forgetTask: (id) => taskManager.forgetRunnerRecoveryTask(id) });
  db.configureFolderReader(new FolderService(orchHostClientDeps));
  const catalogService = new CatalogService(
    db,
    broadcaster,
    folderContentHost,
  );
  const llmAdapters = {
    ...(env.LLM_OPENAI_API_KEY ? { openai: new OpenAIAdapter(env.LLM_OPENAI_API_KEY) } : {}),
    ...(env.LLM_ANTHROPIC_API_KEY
      ? { anthropic: new AnthropicAdapter(env.LLM_ANTHROPIC_API_KEY) }
      : {}),
  };
  const llmExecutor = Object.keys(llmAdapters).length > 0
    ? new LlmExecutor({
        adapters: llmAdapters,
        taskManager,
        persistence,
        broadcaster,
        nodeId: env.SOULSTREAM_NODE_ID,
        logger,
      })
    : undefined;
  if (llmExecutor) {
    logger.info({ providers: Object.keys(llmAdapters) }, "LLM proxy initialized");
  } else {
    logger.info("LLM proxy skipped: no provider API keys configured");
  }
  const mcpRuntime: McpRuntime = {
    ...attachmentRuntime.mcpRuntime,
    persistentReports: new PersistentReportHostClient(orchHostClientDeps),
    nodeId: env.SOULSTREAM_NODE_ID,
    agentsConfigPath: env.AGENTS_CONFIG_PATH,
    db,
    taskManager,
    taskExecutor: taskRuntime.taskExecutor,
    onResume: taskRuntime.onResume,
    ...(claudeRuntime.childCompletionConsumption
      ? { childCompletionConsumption: claudeRuntime.childCompletionConsumption }
      : {}),
    agentRegistry,
    ...(agentProfileSource ? { agentProfileSource } : {}),
    agentConfigService,
    mcpConfigService,
    catalogService,
    logger,
    orch: orchProxyConfig,
    chatUiPublisher: {
      publish: async (sessionId, event, registrationId) => {
        const { eventId } = await persistence.enqueueEventAndWaitForSessionAck(
          sessionId,
          event,
          undefined,
          registrationId,
        );
        return { eventId };
      },
    },
    ...(worktreeService ? { worktreeService } : {}),
    ...(nodeServicesObservation ? { nodeServicesObservation } : {}),
  };
  const attachmentStore = new FileAttachmentStore(env.INCOMING_FILE_DIR, logger);
  const server = await buildServer({
    host: env.HOST,
    port: env.PORT,
    nodeId: env.SOULSTREAM_NODE_ID,
    logger,
    releaseActivationState: params.releaseActivationState,
    mcp: buildMcpServerOptions(env, mcpRuntime),
    cogito: { runtime: mcpRuntime },
    llm: llmExecutor
      ? {
          executor: llmExecutor,
          authBearerToken: env.AUTH_BEARER_TOKEN,
          isProduction: env.ENVIRONMENT === "production",
          logger,
        }
      : undefined,
    boardItem: { service: catalogService, auth: boardYjsAuth },
    markdownDocument: { service: catalogService, auth: boardYjsAuth },
    contextPreview: {
      nodeId: env.SOULSTREAM_NODE_ID,
      atom: {
        enabled: Boolean(env.ATOM_ENABLED),
        serverUrl: env.ATOM_SERVER_URL ?? "",
        apiKey: env.ATOM_API_KEY ?? "",
      },
      auth: boardYjsAuth,
      logger,
    },
  });
  const createUpstreamAdapter = (): UpstreamAdapter => {
    if (upstreamAdapter) throw new Error("UpstreamAdapter already composed");
    upstreamAdapter = composeWorkerUpstreamAdapter({
      worker: params,
      taskManager,
      taskExecutor: taskRuntime.taskExecutor,
      providerUsage,
      attachmentStore,
      claudeAuth,
      claudeAccounts,
      claudeLoginService,
      sessionDb: db,
      realtimeBroker,
      agentConfigService,
      reflectionRuntime: mcpRuntime,
      scheduleCommands: scheduleService,
      modelCatalog,
      eventOutboxPump: eventOutboxPumpMux,
      runnerProcess,
      runnerRecoveryCoordinator,
      authorizeOrchestrationWorker: composeWorkerAdmissionAuthorizer(orchProxyConfig, env.SOULSTREAM_NODE_ID),
      decisionRunner: composePurposeDecisionRunner({
        nodeId: env.SOULSTREAM_NODE_ID, logger, taskManager, persistence, modelCatalog,
        sessionMutations, orch: orchProxyConfig, agentRegistry, agentProfileSource,
        atom: { enabled: Boolean(env.ATOM_ENABLED), serverUrl: env.ATOM_SERVER_URL ?? "", apiKey: env.ATOM_API_KEY ?? "" },
        settings: { claudeAuthTokenPath: env.CLAUDE_AUTH_TOKEN_PATH,
          claudeExecutable: env.CARD_DECISION_CLAUDE_EXECUTABLE_PATH,
          dockerImage: env.CARD_DECISION_DOCKER_IMAGE,
          codexBinaryPath: env.CARD_DECISION_CODEX_BINARY_PATH,
          timeoutMs: env.CARD_DECISION_TIMEOUT_MS },
      }),
    });
    // First poll waits for the adapter so reloads reannounce against a live registration.
    params.modelCatalogStore?.start();
    return upstreamAdapter;
  };
  return {
    ...taskRuntime,
    db,
    server,
    taskManager,
    agentRegistry,
    ...(agentProfileSource ? { agentProfileSource } : {}),
    attachmentStore,
    claudeAuth,
    ...(claudeAccounts ? { claudeAccounts } : {}),
    ...(claudeLoginService ? { claudeLoginService } : {}),
    realtimeBroker,
    agentConfigService,
    mcpRuntime,
    scheduleService,
    sessionPageBindingService,
    ...(worktreeSweeper ? { worktreeSweeper } : {}),
    ...(claudeSessionClientRegistry ? { claudeSessionClientRegistry } : {}),
    claudeRuntimeStartupRecovery: claudeRuntime.startupRecovery ?? composeQueuedDeliveryStartupRecovery(queuedRecoveryParams),
    eventOutbox,
    eventOutboxPump,
    eventOutboxPumpMux,
    ...(runnerRecoveryCoordinator ? { runnerRecoveryCoordinator } : {}),
    completionSettlementWorker: settlement.worker,
    ...composeRunnerOrphanReaper({ runnerProcess, logger, intervalMs: env.SOUL_RUNNER_REAPER_INTERVAL_MS }),
    ...(runnerProcess ? { runnerStateHostOwnership: runnerProcess.hostOwnership } : {}),
    ...(runnerProcess ? { runnerRecoveryStorage: runnerProcess.recoveryStorage } : {}),
    upstreamRegistrationReady: params.releaseActivationState.waitUntilReady(),
    createUpstreamAdapter,
  };
}
