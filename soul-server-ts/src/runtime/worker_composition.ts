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
import { AgentsEngineAdapter } from "../engine/agents_adapter.js";
import { ClaudeEngineAdapter } from "../engine/claude_adapter.js";
import { DbClaudeSessionStore } from "../engine/claude_session_store.js";
import { CodexEngineAdapter } from "../engine/codex_adapter.js";
import { CodexAppServerEngineAdapter } from "../engine/codex_app_server/index.js";
import type { CodexCliPathResolution } from "../engine/codex_cli_path.js";
import { writeScratchAgentMarker } from "../engine/scratch_workspace_env.js";
import { AnthropicAdapter, OpenAIAdapter } from "../llm/adapters.js";
import { LlmExecutor } from "../llm/executor.js";
import { buildOrchProxyConfig } from "../mcp/orch_proxy.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { McpConfigService } from "../mcp_config_service.js";
import { RealtimeBroker } from "../realtime/realtime_broker.js";
import { RunbookHandoffNotifier } from "../runbook/runbook_handoff_notifier.js";
import { RunbookService } from "../runbook/runbook_service.js";
import { RunbookTaskIdentityHostClient } from "../runbook/runbook_task_identity_host_client.js";
import { FolderProjectIdentityHostClient } from "../folder/folder_project_identity_host_client.js";
import { PageYjsHostClient } from "../page/page_host_client.js";
import type { ChecklistRunbookAdapter } from "../page/checklist_runbook_adapter.js";
import type { ChecklistRunbookReconciler } from "../page/checklist_runbook_reconciler.js";
import {
  SessionLegacyProjection,
  SessionPageBindingService,
} from "../page/session_page_binding_service.js";
import { SoulstreamScheduleService } from "../schedule/schedule_service.js";
import { buildServer, type ServerInstance } from "../server.js";
import { sendMessageToSession } from "../task/session_message_sender.js";
import type { EngineFactory } from "../task/task_executor.js";
import { TaskManager } from "../task/task_manager.js";
import { SessionBroadcaster } from "../upstream/session_broadcaster.js";
import { UpstreamAdapter } from "../upstream/adapter.js";

import {
  composeSupervisorRuntime,
  type SupervisorComposition,
} from "./supervisor_composition.js";
import { composeChecklistRunbookProjection } from "./checklist_runbook_composition.js";

export interface WorkerCompositionParams {
  env: Env;
  logger: Logger;
  agentRegistry: AgentRegistry;
  mcpConfigService: McpConfigService;
  codexCliPath?: CodexCliPathResolution;
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
  checklistRunbookAdapter: ChecklistRunbookAdapter;
  checklistRunbookReconciler: ChecklistRunbookReconciler;
  createUpstreamAdapter(): UpstreamAdapter;
}

/** Builds the complete worker object graph without starting HTTP or WebSocket loops. */
export async function composeWorkerRuntime(
  params: WorkerCompositionParams,
): Promise<WorkerComposition> {
  const { env, logger, agentRegistry, mcpConfigService, codexCliPath } = params;
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
  const runbookTaskIdentityHost = new RunbookTaskIdentityHostClient({
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
  const taskManager = new TaskManager(
    env.SOULSTREAM_NODE_ID,
    db,
    broadcaster,
    logger,
    persistence,
    contextBuilder,
    agentRegistry,
    boardYjsService,
    sessionPageBindingService,
  );
  const scheduleService = new SoulstreamScheduleService(
    db.schedules(),
    broadcaster,
    persistence,
    logger,
  );
  const engineFactory: EngineFactory = (agent) => {
    writeScratchAgentMarker({ workspaceDir: agent.workspace_dir, agentId: agent.id });
    if (agent.backend === "codex") {
      if (env.CODEX_ADAPTER_MODE === "app-server") {
        return new CodexAppServerEngineAdapter(
          {
            workspaceDir: agent.workspace_dir,
            agentId: agent.id,
            apiKey: env.CODEX_API_KEY,
            codexPathOverride: codexCliPath?.path,
            processEnv: process.env,
          },
          logger,
        );
      }
      return new CodexEngineAdapter(
        {
          workspaceDir: agent.workspace_dir,
          agentId: agent.id,
          apiKey: env.CODEX_API_KEY,
          processEnv: process.env,
          codexPathOverride: codexCliPath?.path,
        },
        logger,
      );
    }
    if (agent.backend === "claude") {
      return new ClaudeEngineAdapter(
        {
          workspaceDir: agent.workspace_dir,
          agentId: agent.id,
          processEnv: claudeAuth.buildProcessEnv(process.env),
          sessionStore: claudeSessionStore,
          sessionStoreFlush: "batched",
          loadTimeoutMs: 60_000,
        },
        logger,
      );
    }
    if (agent.backend === "openai-agents") {
      return new AgentsEngineAdapter(
        { workspaceDir: agent.workspace_dir, profile: agent },
        logger,
      );
    }
    throw new Error(
      `Unsupported backend "${agent.backend}" in soul-server-ts (agent=${agent.id})`,
    );
  };
  const supervisor = composeSupervisorRuntime({
    env,
    db,
    logger,
    agentRegistry,
    taskManager,
    engineFactory,
    contextBuilder,
    persistence,
    broadcaster,
    scheduleService,
    orchProxyConfig,
  });

  const catalogService = new CatalogService(
    db,
    broadcaster,
    boardYjsService,
    folderProjectIdentityHost,
  );
  const runbookHandoffNotifier = new RunbookHandoffNotifier(
    db.runbooks(),
    {
      send: (message) =>
        sendMessageToSession(
          { taskManager, onResume: supervisor.onResume, logger, orch: orchProxyConfig },
          message,
        ),
    },
    logger,
  );
  const runbookService = new RunbookService(
    db,
    broadcaster,
    boardYjsService,
    runbookHandoffNotifier,
    catalogService,
    logger,
  );
  const {
    checklistRunbookAdapter,
    checklistRunbookReconciler,
  } = composeChecklistRunbookProjection({
    nodeId: env.SOULSTREAM_NODE_ID,
    db,
    runbookService,
    runbookTaskIdentityHost,
    pageHost,
    logger,
  });
  checklistRunbookReconciler.start();
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
    agentRegistry,
    agentConfigService,
    mcpConfigService,
    catalogService,
    runbookService,
    runbookTaskIdentityHostClient: runbookTaskIdentityHost,
    checklistRunbookAdapter,
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
    runbook: {
      service: runbookService,
      taskIdentityHost: runbookTaskIdentityHost,
      checklistAdapter: checklistRunbookAdapter,
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
    checklistRunbookAdapter,
    checklistRunbookReconciler,
    createUpstreamAdapter,
  };
}
