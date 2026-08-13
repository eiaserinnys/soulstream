import { AgentConfigService } from "../agent_config_service.js";
import { FileAttachmentStore } from "../attachments/file_manager.js";
import { ClaudeAuthService, FileClaudeAuthTokenStore } from "../auth/claude_auth.js";
import { CatalogService } from "../catalog/catalog_service.js";
import { BoardYjsHostClient } from "../collaboration/board_yjs_host_client.js";
import { DEFAULT_COGITO_CONTEXT_LIMITS } from "../context/cogito_context.js";
import { ExecutionContextBuilder } from "../context/context_builder.js";
import { DefaultPageContextAssembler } from "../context/page_context_assembler.js";
import { HostPageContextRepository } from "../context/page_context_repository.js";
import { AncestorPageContextResolver } from "../context/page_context_resolver.js";
import { CustomViewService } from "../custom_view/custom_view_service.js";
import {
  ClaudeRuntimeHostClient,
  SessionDeliveryHostClient,
  SessionMutationHostClient,
  SessionPageBindingHostClient,
} from "../control_plane/persistence_host_clients.js";
import { SessionDataHostClient } from "../control_plane/session_data_host_client.js";
import { EventPersistence } from "../db/event_persistence.js";
import { SessionDB } from "../db/session_db.js";
import { DbClaudeSessionStore } from "../engine/claude_session_store.js";
import { AnthropicAdapter, OpenAIAdapter } from "../llm/adapters.js";
import { LlmExecutor } from "../llm/executor.js";
import { buildOrchProxyConfig } from "../mcp/orch_proxy.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { ModelCatalog } from "../model_catalog.js";
import { RealtimeBroker } from "../realtime/realtime_broker.js";
import { TaskHandoffNotifier } from "../work-task/task_handoff_notifier.js";
import { TaskService } from "../work-task/task_service.js";
import { TaskIdentityHostClient } from "../work-task/task_identity_host_client.js";
import { FolderProjectIdentityHostClient } from "../folder/folder_project_identity_host_client.js";
import { FolderHostClient } from "../folder/folder_host_client.js";
import { PageYjsHostClient } from "../page/page_host_client.js";
import {
  SessionLegacyProjection,
  SessionPageBindingService,
} from "../page/session_page_binding_service.js";
import { SoulstreamScheduleService } from "../schedule/schedule_service.js";
import { ScheduleHostClient } from "../schedule/schedule_host_client.js";
import { buildServer } from "../server.js";
import { sendMessageToSession } from "../task/session_message_sender.js";
import { TaskEngineEventPublisher } from "../task/task_engine_event_publisher.js";
import { TaskManager } from "../task/task_manager.js";
import { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import { UpstreamAdapter } from "../upstream/adapter.js";
import { EventOutbox } from "../upstream/event_outbox.js";
import { EventOutboxPump } from "../upstream/event_outbox_pump.js";
import { EventOutboxPumpMux } from "../upstream/event_outbox_pump_mux.js";
import { summarizePayloadForLog } from "../upstream/log_payload_summary.js";
import { composeTaskRuntime, type TaskRuntimeComposition } from "./task_runtime_composition.js";
import { composeChecklistTaskProjection } from "./checklist_task_composition.js";
import { composeClaudeRuntime } from "./claude_runtime_composition.js";
import { createDetachedClaudeEventBridge } from "./detached_claude_event_bridge.js";
import { createEngineFactory } from "./engine_factory.js";
import { composeRunnerProcessRuntime, composeRunnerReconciliationReporter, startRunnerRecoveryCoordinator } from "./runner_process_composition.js";
import type { WorkerComposition, WorkerCompositionParams } from "./worker_composition_types.js";

export type { WorkerComposition, WorkerCompositionParams } from "./worker_composition_types.js";
export async function composeWorkerRuntime(
  params: WorkerCompositionParams,
): Promise<WorkerComposition> {
  const { env, logger, agentRegistry, mcpConfigService, codexCliPath, agentProfileSource } = params;
  const modelCatalog =
    params.modelCatalog ?? new ModelCatalog(env.MODEL_CATALOG_PATH, logger);
  let upstreamAdapter: UpstreamAdapter | null = null;
  const agentConfigService = new AgentConfigService({
    configPath: env.AGENTS_CONFIG_PATH,
    agentRegistry,
    profileResolver: (profiles) => mcpConfigService.resolveProfiles(profiles),
    onAfterRegistryReplace: async () => {
      if (!upstreamAdapter) {
        logger.warn(
          { nodeId: env.SOULSTREAM_NODE_ID },
          "Agent catalog reannounce skipped — UpstreamAdapter not ready",
        );
        return;
      }
      await upstreamAdapter.reannounceAgentCatalog();
    },
  });
  const claudeAuth = new ClaudeAuthService(
    { store: new FileClaudeAuthTokenStore(env.CLAUDE_AUTH_TOKEN_PATH) },
    logger,
  );
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
  const send = async (data: unknown): Promise<void> => {
    if (!upstreamAdapter) {
      logger.warn(
        summarizePayloadForLog(data),
        "broadcast send called before UpstreamAdapter ready",
      );
      return;
    }
    await upstreamAdapter.sendBroadcast(data);
  };
  const broadcaster = new SessionBroadcaster(send, agentRegistry, env.SOULSTREAM_NODE_ID);
  const persistence = new EventPersistence(
    db,
    broadcaster,
    logger,
    eventOutbox,
    eventOutboxPump,
  );
  const realtimeBroker = new RealtimeBroker({
    agentRegistry,
    db,
    persistence,
    broadcaster,
    logger,
    processEnv: process.env,
    modelCatalog,
  });
  const orchProxyConfig = buildOrchProxyConfig(env);
  const sessionMutations = new SessionMutationHostClient({ orch: orchProxyConfig, logger });
  const claudeRuntimeHost = new ClaudeRuntimeHostClient({ orch: orchProxyConfig, logger });
  db.configurePersistenceHosts({
    deliveries: new SessionDeliveryHostClient({ orch: orchProxyConfig, logger }),
    claudeRuntime: claudeRuntimeHost,
    sessionPageBindings: new SessionPageBindingHostClient({ orch: orchProxyConfig, logger }),
    sessionData: new SessionDataHostClient({ orch: orchProxyConfig, logger }),
  });
  const boardYjsAuth = {
    authBearerToken: env.AUTH_BEARER_TOKEN,
    environment: env.ENVIRONMENT,
    dashboardAuthEnabled: Boolean(env.GOOGLE_CLIENT_ID),
    jwtSecret: env.JWT_SECRET,
  };
  const boardYjsService = new BoardYjsHostClient({
    orch: orchProxyConfig,
    logger,
  });
  db.configureBoardProjectionHost(boardYjsService);
  logger.info(
    { nodeId: env.SOULSTREAM_NODE_ID },
    "Board Yjs mutations and projections delegated to orchestrator",
  );
  const sessionPageBindingRepository = db.sessionPageBindings();
  const pageHost = new PageYjsHostClient({ orch: orchProxyConfig, logger });
  const taskIdentityHost = new TaskIdentityHostClient({
    orch: orchProxyConfig,
    logger,
  });
  const folderProjectIdentityHost = new FolderProjectIdentityHostClient({
    orch: orchProxyConfig,
    logger,
  });
  db.configureFolderHost(new FolderHostClient({ orch: orchProxyConfig, logger }));
  const sessionPageBindingService = new SessionPageBindingService({
    nodeId: env.SOULSTREAM_NODE_ID,
    repository: sessionPageBindingRepository,
    pageHost,
    legacyProjection: new SessionLegacyProjection(db, boardYjsService),
    logger,
  });
  sessionPageBindingService.start();
  const pageContextResolver = new AncestorPageContextResolver(
    new HostPageContextRepository(sessionPageBindingRepository, pageHost),
    new DefaultPageContextAssembler(),
    logger,
  );
  const contextBuilder = new ExecutionContextBuilder(
    db,
    agentRegistry,
    {
      nodeId: env.SOULSTREAM_NODE_ID,
      atom: {
        enabled: Boolean(env.ATOM_ENABLED),
        serverUrl: env.ATOM_SERVER_URL ?? "",
        apiKey: env.ATOM_API_KEY ?? "",
      },
      cogito: {
        baseUrl: orchProxyConfig.baseUrl,
        headers: orchProxyConfig.headers,
        ...DEFAULT_COGITO_CONTEXT_LIMITS,
      },
    },
    logger,
    pageContextResolver,
  );
  const detachedClaudeEventPublisher = env.CLAUDE_SESSION_RUNTIME_V2_ENABLED
    ? new TaskEngineEventPublisher({
        broadcaster,
        logger,
        persistence,
      })
    : undefined;
  let taskRuntime!: TaskRuntimeComposition, taskManager!: TaskManager;
  const publishDetachedClaudeEvent = createDetachedClaudeEventBridge({
    logger,
    findTask: (sessionId) => taskManager.getTask(sessionId),
    getPublisher: () => detachedClaudeEventPublisher,
    collectDetached: async (task, payload) =>
      await taskRuntime.claudeRuntimeTaskFollowup.collectDetached(task, payload),
  });
  const claudeRuntime = env.CLAUDE_SESSION_RUNTIME_V2_ENABLED
    ? await composeClaudeRuntime({
        enabled: true,
        db,
        agentRegistry,
        modelCatalog,
        sessionStore: claudeSessionStore,
        sourceNode: env.SOULSTREAM_NODE_ID,
        idleTtlMs: env.CLAUDE_SESSION_RUNTIME_IDLE_TTL_MS,
        maxEntries: env.CLAUDE_SESSION_RUNTIME_MAX_ENTRIES,
        turnTimeoutMs: env.CLAUDE_SESSION_RUNTIME_TURN_TIMEOUT_MS,
        logger,
        detachedEventSink: publishDetachedClaudeEvent,
      })
    : {};
  const claudeSessionClientRegistry = claudeRuntime.registry;
  taskManager = new TaskManager(
    env.SOULSTREAM_NODE_ID,
    db,
    broadcaster,
    logger,
    persistence,
    contextBuilder,
    agentRegistry,
    boardYjsService,
    sessionPageBindingService,
    env.CLAUDE_SESSION_RUNTIME_V2_ENABLED,
    claudeSessionClientRegistry,
    modelCatalog,
    sessionMutations,
  );
  db.configureScheduleHost(new ScheduleHostClient({ orch: orchProxyConfig, logger }));
  const scheduleService = new SoulstreamScheduleService(db.schedules(), broadcaster, persistence, logger);
  const engineFactory = createEngineFactory({
    env,
    logger,
    codexCliPath,
    codexProcessEnv: process.env,
    buildClaudeProcessEnv: () => claudeAuth.buildProcessEnv(process.env),
    claudeSessionStore,
    mcpConfigService,
    ...(claudeSessionClientRegistry ? { claudeSessionClientRegistry } : {}),
  });
  const runnerProcess = await composeRunnerProcessRuntime(env.SOUL_RUNNER_PROCESS_ENABLED, {
    env, logger, mcpConfigService, codexCliPath,
    pumpMux: eventOutboxPumpMux, sessionStore: claudeSessionStore,
    buildChildProcessEnv: () => claudeAuth.buildProcessEnv(process.env), publishDetachedClaudeEvent,
    observeClaudeRuntime: claudeRuntime.backgroundLifecycle
      ? (sessionId, event, idempotencyKey) =>
        claudeRuntime.backgroundLifecycle!.observe(sessionId, event, idempotencyKey) : undefined,
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
    orchProxyConfig,
    queuedDeliveryRecovery: claudeRuntime.queuedDeliveryRecovery,
    ...(runnerProcess ? { runnerProcessFactory: runnerProcess.runtimeFactory } : {}),
  });
  const runnerRecoveryCoordinator = await startRunnerRecoveryCoordinator({
    env,
    runnerProcessFactory: runnerProcess?.runtimeFactory,
    releaseGarbageCollector: runnerProcess?.releaseGarbageCollector,
    sessionGarbageCollector: runnerProcess?.sessionGarbageCollector,
    closedTailDrainer: runnerProcess?.closedTailDrainer,
    taskManager,
    taskExecutor: taskRuntime.taskExecutor,
    logger,
  });
  const taskService = new TaskService({ orch: orchProxyConfig, logger });
  db.configureTaskReader(taskService);
  const catalogService = new CatalogService(
    db,
    broadcaster,
    boardYjsService,
    folderProjectIdentityHost,
    sessionMutations,
  );
  const taskHandoffNotifier = new TaskHandoffNotifier(
    taskService,
    {
      send: (message) =>
        sendMessageToSession(
          { taskManager, onResume: taskRuntime.onResume, logger, orch: orchProxyConfig },
          message,
        ),
    },
    logger,
  );
  taskService.setHandoffNotifier(taskHandoffNotifier);
  const {
    checklistTaskAdapter,
    checklistTaskReconciler,
  } = composeChecklistTaskProjection({
    nodeId: env.SOULSTREAM_NODE_ID,
    db,
    taskService,
    taskIdentityHost,
    pageHost,
    logger,
  });
  checklistTaskReconciler.start();
  const customViewService = new CustomViewService(db, boardYjsService, broadcaster);
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
    nodeId: env.SOULSTREAM_NODE_ID,
    agentsConfigPath: env.AGENTS_CONFIG_PATH,
    db,
    taskManager,
    taskExecutor: taskRuntime.taskExecutor,
    ...(claudeRuntime.childCompletionConsumption
      ? { childCompletionConsumption: claudeRuntime.childCompletionConsumption }
      : {}),
    agentRegistry,
    ...(agentProfileSource ? { agentProfileSource } : {}),
    agentConfigService,
    mcpConfigService,
    catalogService,
    taskService,
    taskIdentityHostClient: taskIdentityHost,
    checklistTaskAdapter,
    customViewService,
    logger,
    orch: orchProxyConfig,
  };
  const attachmentStore = new FileAttachmentStore(env.INCOMING_FILE_DIR, logger);
  const server = await buildServer({
    host: env.HOST,
    port: env.PORT,
    nodeId: env.SOULSTREAM_NODE_ID,
    logger,
    mcp: env.MCP_ENABLED
      ? {
          runtime: mcpRuntime,
          path: env.MCP_PATH, statelessTransport: env.MCP_STATELESS_TRANSPORT_ENABLED,
          auth: {
            requireAuth: env.MCP_REQUIRE_AUTH,
            bearerToken: env.AUTH_BEARER_TOKEN,
            allowedHosts: env.MCP_ALLOWED_HOSTS,
          },
        }
      : undefined,
    cogito: { runtime: mcpRuntime },
    llm: llmExecutor
      ? {
          executor: llmExecutor,
          authBearerToken: env.AUTH_BEARER_TOKEN,
          isProduction: env.ENVIRONMENT === "production",
          logger,
        }
      : undefined,
    task: {
      service: taskService,
      taskIdentityHost: taskIdentityHost,
      checklistAdapter: checklistTaskAdapter,
      auth: boardYjsAuth,
    },
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
    upstreamAdapter = new UpstreamAdapter(
      {
        url: env.SOULSTREAM_UPSTREAM_URL,
        nodeId: env.SOULSTREAM_NODE_ID,
        host: env.HOST,
        port: env.PORT,
        authBearerToken: env.AUTH_BEARER_TOKEN,
        userName: env.DASH_USER_NAME,
        userPortraitPath: env.DASH_USER_PORTRAIT,
        isProduction: env.ENVIRONMENT === "production", runnerProcessEnabled: env.SOUL_RUNNER_PROCESS_ENABLED, runnerLeaseTimeoutMs: env.SOUL_RUNNER_LEASE_TIMEOUT_MS,
      },
      logger,
      {
        agentRegistry,
        taskManager,
        taskExecutor: taskRuntime.taskExecutor,
        attachmentStore,
        claudeAuth,
        sessionDb: db,
        realtimeBroker,
        agentConfigService,
        reflectionRuntime: mcpRuntime,
        scheduleCommands: scheduleService,
        deliveryV2Enabled: env.CLAUDE_SESSION_RUNTIME_V2_ENABLED,
        modelCatalog,
        eventOutboxPump: eventOutboxPumpMux,
        ...composeRunnerReconciliationReporter(env, runnerProcess?.runtimeFactory, runnerRecoveryCoordinator),
        ...(agentProfileSource ? { agentProfileSource } : {}),
      },
    );
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
    realtimeBroker,
    agentConfigService,
    mcpRuntime,
    scheduleService,
    sessionPageBindingService,
    checklistTaskAdapter,
    checklistTaskReconciler,
    ...(claudeSessionClientRegistry ? { claudeSessionClientRegistry } : {}),
    ...(claudeRuntime.startupRecovery
      ? { claudeRuntimeStartupRecovery: claudeRuntime.startupRecovery }
      : {}),
    eventOutbox,
    eventOutboxPump,
    eventOutboxPumpMux,
    ...(runnerRecoveryCoordinator ? { runnerRecoveryCoordinator } : {}),
    ...(runnerProcess ? { runnerStateHostOwnership: runnerProcess.hostOwnership } : {}),
    createUpstreamAdapter,
  };
}
