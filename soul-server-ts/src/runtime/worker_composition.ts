import type { Logger } from "pino";
import { AgentConfigService } from "../agent_config_service.js";
import type { AgentRegistry } from "../agent_registry.js";
import { FileAttachmentStore } from "../attachments/file_manager.js";
import { ClaudeAuthService, FileClaudeAuthTokenStore } from "../auth/claude_auth.js";
import { CatalogService } from "../catalog/catalog_service.js";
import { createBoardYjsRouting } from "../collaboration/board_yjs_routing.js";
import type { Env } from "../config.js";
import { DEFAULT_COGITO_CONTEXT_LIMITS } from "../context/cogito_context.js";
import { ExecutionContextBuilder } from "../context/context_builder.js";
import { DefaultPageContextAssembler } from "../context/page_context_assembler.js";
import { HostPageContextRepository } from "../context/page_context_repository.js";
import { AncestorPageContextResolver } from "../context/page_context_resolver.js";
import { CustomViewService } from "../custom_view/custom_view_service.js";
import { EventPersistence } from "../db/event_persistence.js";
import { SessionDB } from "../db/session_db.js";
import { ensureStableSessionOrderIndexInBackground } from "../db/session_index_ensure.js";
import { mapClaudeClientEvent } from "../engine/claude_event_mapper.js";
import {
  isPostResultDrainEvent,
  markPostResultDrainEvent,
} from "../engine/claude_event_phase.js";
import type { ClaudeSessionClientRegistry } from "../engine/claude_session_client_registry.js";
import { DbClaudeSessionStore } from "../engine/claude_session_store.js";
import type { CodexCliPathResolution } from "../engine/codex_cli_path.js";
import { AnthropicAdapter, OpenAIAdapter } from "../llm/adapters.js";
import { LlmExecutor } from "../llm/executor.js";
import { buildOrchProxyConfig } from "../mcp/orch_proxy.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { McpConfigService } from "../mcp_config_service.js";
import { ModelCatalog } from "../model_catalog.js";
import { RealtimeBroker } from "../realtime/realtime_broker.js";
import { TaskHandoffNotifier } from "../work-task/task_handoff_notifier.js";
import { TaskService } from "../work-task/task_service.js";
import { TaskIdentityHostClient } from "../work-task/task_identity_host_client.js";
import { FolderProjectIdentityHostClient } from "../folder/folder_project_identity_host_client.js";
import { PageYjsHostClient } from "../page/page_host_client.js";
import type { ChecklistTaskAdapter } from "../page/checklist_task_adapter.js";
import type { ChecklistTaskReconciler } from "../page/checklist_task_reconciler.js";
import {
  SessionLegacyProjection,
  SessionPageBindingService,
} from "../page/session_page_binding_service.js";
import { SoulstreamScheduleService } from "../schedule/schedule_service.js";
import { buildServer, type ServerInstance } from "../server.js";
import { sendMessageToSession } from "../task/session_message_sender.js";
import { TaskEngineEventPublisher } from "../task/task_engine_event_publisher.js";
import { TaskManager } from "../task/task_manager.js";
import { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import { UpstreamAdapter } from "../upstream/adapter.js";
import {
  composeSupervisorRuntime,
  type SupervisorComposition,
} from "./supervisor_composition.js";
import { composeChecklistTaskProjection } from "./checklist_task_composition.js";
import { composeClaudeRuntime } from "./claude_runtime_composition.js";
import { createEngineFactory } from "./engine_factory.js";
import { preflightPersistentRuntimeSchema } from "./worker_schema_preflight.js";
export interface WorkerCompositionParams {
  env: Env;
  logger: Logger;
  agentRegistry: AgentRegistry;
  mcpConfigService: McpConfigService;
  codexCliPath?: CodexCliPathResolution;
  modelCatalog?: ModelCatalog;
}
export interface WorkerComposition extends SupervisorComposition {
  db: SessionDB;
  server: ServerInstance;
  taskManager: TaskManager;
  agentRegistry: AgentRegistry;
  attachmentStore: FileAttachmentStore;
  claudeAuth: ClaudeAuthService;
  realtimeBroker: RealtimeBroker;
  agentConfigService: AgentConfigService;
  mcpRuntime: McpRuntime;
  scheduleService: SoulstreamScheduleService;
  sessionPageBindingService: SessionPageBindingService;
  checklistTaskAdapter: ChecklistTaskAdapter;
  checklistTaskReconciler: ChecklistTaskReconciler;
  claudeSessionClientRegistry?: ClaudeSessionClientRegistry;
  createUpstreamAdapter(): UpstreamAdapter;
}
/** Builds the complete worker object graph without starting HTTP or WebSocket loops. */
export async function composeWorkerRuntime(
  params: WorkerCompositionParams,
): Promise<WorkerComposition> {
  const { env, logger, agentRegistry, mcpConfigService, codexCliPath } = params;
  const modelCatalog = params.modelCatalog ?? new ModelCatalog(env.MODEL_CATALOG_PATH);
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
  const db = new SessionDB(env.DATABASE_URL);
  await preflightPersistentRuntimeSchema(db, env.CLAUDE_SESSION_RUNTIME_V2_ENABLED);
  ensureStableSessionOrderIndexInBackground(db, logger);
  const claudeSessionStore = new DbClaudeSessionStore(db);
  const interruptedOnStartup = await db.interruptRunningSessionsForNode(env.SOULSTREAM_NODE_ID);
  if (interruptedOnStartup > 0) {
    logger.warn(
      { count: interruptedOnStartup, nodeId: env.SOULSTREAM_NODE_ID },
      "Interrupted stale running sessions on startup",
    );
  }
  const send = async (data: unknown): Promise<void> => {
    if (!upstreamAdapter) {
      logger.warn({ data }, "broadcast send called before UpstreamAdapter ready");
      return;
    }
    await upstreamAdapter.sendBroadcast(data);
  };
  const broadcaster = new SessionBroadcaster(send, agentRegistry, env.SOULSTREAM_NODE_ID);
  const persistence = new EventPersistence(db, broadcaster, logger);
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
  const boardYjsAuth = {
    authBearerToken: env.AUTH_BEARER_TOKEN,
    environment: env.ENVIRONMENT,
    dashboardAuthEnabled: Boolean(env.GOOGLE_CLIENT_ID),
    jwtSecret: env.JWT_SECRET,
  };
  const {
    isBoardYjsHost,
    localService: localBoardYjsService,
    mutationPort: boardYjsService,
  } = createBoardYjsRouting({
    db,
    logger,
    auth: boardYjsAuth,
    orch: orchProxyConfig,
    nodeId: env.SOULSTREAM_NODE_ID,
    hostNodeId: env.BOARD_YJS_HOST_NODE_ID,
  });
  logger.info(
    {
      nodeId: env.SOULSTREAM_NODE_ID,
      boardYjsHostNodeId: env.BOARD_YJS_HOST_NODE_ID,
      isBoardYjsHost,
    },
    "Board Yjs host routing initialized",
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
        db,
        logger,
        persistence,
      })
    : undefined;
  let supervisor!: SupervisorComposition, taskManager!: TaskManager;
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
        detachedEventSink: async (sessionId, event) => {
          const task = taskManager.getTask(sessionId);
          if (!task || !detachedClaudeEventPublisher) {
            logger.warn(
              { sessionId, eventType: event.type },
              "Detached Claude runtime event has no in-memory task",
            );
            return;
          }
          for (const payload of mapClaudeClientEvent(event)) {
            if (isPostResultDrainEvent(event)) markPostResultDrainEvent(payload);
            await detachedClaudeEventPublisher.publishEngineEvent(task, payload);
            await supervisor.claudeRuntimeTaskFollowup.collectDetached(task, payload);
          }
        },
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
  );
  const scheduleService =
    new SoulstreamScheduleService(db.schedules(), broadcaster, persistence, logger);
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
  supervisor = composeSupervisorRuntime({
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
  });
  const catalogService = new CatalogService(
    db,
    broadcaster,
    boardYjsService,
    folderProjectIdentityHost,
  );
  const taskHandoffNotifier = new TaskHandoffNotifier(
    db.tasks(),
    {
      send: (message) =>
        sendMessageToSession(
          { taskManager, onResume: supervisor.onResume, logger, orch: orchProxyConfig },
          message,
        ),
    },
    logger,
  );
  const taskService = new TaskService(
    db,
    broadcaster,
    boardYjsService,
    taskHandoffNotifier,
    catalogService,
    logger,
  );
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
    boardYjsHostNodeId: env.BOARD_YJS_HOST_NODE_ID,
    agentsConfigPath: env.AGENTS_CONFIG_PATH,
    db,
    taskManager,
    taskExecutor: supervisor.taskExecutor,
    ...(claudeRuntime.childCompletionConsumption
      ? { childCompletionConsumption: claudeRuntime.childCompletionConsumption }
      : {}),
    agentRegistry,
    agentConfigService,
    mcpConfigService,
    catalogService,
    taskService,
    taskIdentityHostClient: taskIdentityHost,
    checklistTaskAdapter,
    customViewService,
    logger,
    mcpToolProfile: env.MCP_TOOL_PROFILE,
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
          path: env.MCP_PATH,
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
    boardYjs: { service: localBoardYjsService },
    boardYjsHost: { service: localBoardYjsService, auth: boardYjsAuth },
    task: {
      service: taskService,
      taskIdentityHost: taskIdentityHost,
      checklistAdapter: checklistTaskAdapter,
      auth: boardYjsAuth,
    },
    boardItem: { service: catalogService, auth: boardYjsAuth },
    markdownDocument: { service: catalogService, auth: boardYjsAuth },
  });

  const createUpstreamAdapter = (): UpstreamAdapter => {
    if (upstreamAdapter) throw new Error("UpstreamAdapter already composed");
    upstreamAdapter = new UpstreamAdapter(
      {
        url: env.SOULSTREAM_UPSTREAM_URL,
        nodeId: env.SOULSTREAM_NODE_ID,
        boardYjsHostNodeId: env.BOARD_YJS_HOST_NODE_ID,
        host: env.HOST,
        port: env.PORT,
        authBearerToken: env.AUTH_BEARER_TOKEN,
        userName: env.DASH_USER_NAME,
        userPortraitPath: env.DASH_USER_PORTRAIT,
        isProduction: env.ENVIRONMENT === "production",
      },
      logger,
      {
        agentRegistry,
        taskManager,
        taskExecutor: supervisor.taskExecutor,
        attachmentStore,
        claudeAuth,
        sessionDb: db,
        realtimeBroker,
        agentConfigService,
        reflectionRuntime: mcpRuntime,
        scheduleCommands: scheduleService,
        deliveryV2Enabled: env.CLAUDE_SESSION_RUNTIME_V2_ENABLED,
        modelCatalog,
      },
    );
    return upstreamAdapter;
  };

  return {
    ...supervisor,
    db,
    server,
    taskManager,
    agentRegistry,
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
    createUpstreamAdapter,
  };
}
