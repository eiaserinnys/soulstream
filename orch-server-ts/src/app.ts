import { registerNodeGitSetupRoutes, type NodeGitSetupRouteOptions } from "./node/node_git_setup_routes.js";
import { registerAgentContextOverviewRoutes, type AgentContextOverviewRouteOptions } from "./node/agent_context_overview_routes.js";
import { registerSkillGuidesRoutes, type SkillGuidesRouteOptions } from "./skills/skill_guides_routes.js";
import { registerPersistentDefaultsRoutes, type PersistentDefaultsRoutes } from "./admin/persistent_defaults_routes.js";
import { registerAntigravityBackendRoutes, type AntigravityBackendRoutes } from "./admin/antigravity_backend_routes.js";
import { registerSummarySettingsRoutes, type SummarySettingsRoutes } from "./admin/summary_settings_routes.js";
import { registerMcpCentralRoutes, type McpCentralRouteOptions } from "./mcp_central/routes.js";
import { registerConversationRoutes, type ConversationRouteOptions } from "./conversation/conversation_routes.js";
import { registerOwnedAgentRoutes, type OwnedAgentRouteOptions } from "./owned-agents/routes.js";
import { registerAccessLinkRoutes, type AccessLinkRouteOptions } from "./external_access/access_link_routes.js";
import { registerOutboundWebhookRoutes, type OutboundWebhookRouteOptions } from "./webhooks/outbound_routes.js";
import { registerInboundHookRoutes, type InboundHookRouteOptions } from "./webhooks/inbound_hook_routes.js";
import { registerInboundWebhookRoutes, type InboundWebhookRouteOptions } from "./webhooks/inbound_webhook_routes.js";
import {
  registerExternalAccessPublicRoutes,
  type ExternalAccessPublicRouteOptions,
} from "./external_access/public_link_routes.js";
import { isExternalAccessRequestPath } from "./external_access/external_access_paths.js";
import { registerExternalEventsRoutes, type ExternalIngressConfig } from "./mcp/external_events_transport.js";
import { registerMcpHostRoutes } from "./mcp/mcp_host_routes.js";
import type { McpHostOptions } from "./mcp/types.js";
import { registerCardOrchestrationRoutes, type CardOrchestrationRouteOptions } from "./cards/card_orchestration_routes.js";
import { registerCardOrchestrationDecisionRoutes, type CardOrchestrationDecisionRouteOptions } from "./cards/card_orchestration_decision_routes.js";
import { registerR2SettingsRoutes, type R2SettingsProvider } from "./admin/r2_settings_routes.js";
import Fastify, { type FastifyInstance } from "fastify";
import { registerCardDispatchSettingsRoutes, type CardDispatchSettingsRouteOptions } from "./cards/card_dispatch_settings_routes.js";
import { registerPersistentContextHostRoutes, type PersistentContextHostRouteOptions } from "./persistent-context/persistent_context_host_routes.js";

import {
  registerAdminUsersRoutes,
  type AdminUsersRouteOptions,
} from "./admin/admin_users_routes.js";
import {
  registerAtomRoutes,
  type AtomRouteOptions,
} from "./atom/atom_routes.js";
import {
  registerAuthRoutes,
  type AuthRouteOptions,
} from "./auth/auth_routes.js";
import {
  registerAttachmentRoutes,
  type AttachmentRouteOptions,
} from "./attachments/attachment_routes.js";
import {
  registerAgentAttachmentRoutes,
  type AgentAttachmentRouteOptions,
} from "./attachments/agent_attachment_routes.js";
import {
  registerWorkerAttachmentRoutes,
  type WorkerAttachmentRouteOptions,
} from "./attachments/worker_attachment_routes.js";
import { registerFlatFolderContentRoutes, type FlatFolderContentRouteOptions } from "./board/flat_folder_content_routes.js";
import {
  registerPageYjsRoutes,
  type PageYjsRouteOptions,
} from "./page/page_yjs_route.js";
import {
  registerBoardAssetRoutes,
  type BoardAssetRouteOptions,
} from "./board/board_asset_routes.js";
import {
  registerBoardItemRoutes,
  type BoardItemRouteOptions,
} from "./board/board_item_routes.js";
import {
  registerMarkdownDocumentRoutes,
  type MarkdownDocumentRouteOptions,
} from "./board/markdown_document_routes.js";
import type { OrchServerTsConfig } from "./config.js";
import { registerOAuthRoutes, type OAuthRouteOptions } from "./oauth/oauth_routes.js";
import {
  registerCogitoRoutes,
  type CogitoRouteOptions,
} from "./cogito/cogito_routes.js";
import { routeOwnerManifest, type RouteOwnerManifest } from "./contract/route_owner_manifest.js";
import {
  registerExecuteProxyRoutes,
  type ExecuteProxyRouteOptions,
} from "./execute/execute_proxy_routes.js";
import {
  registerEphemeralLlmRoutes,
  type EphemeralLlmRouteOptions,
} from "./llm/ephemeral_llm_routes.js";
import {
  registerScheduleHostRoute,
  type ScheduleHostRouteOptions,
} from "./schedule/schedule_host_route.js";
import {
  registerRecurringJobRoutes,
  type RecurringJobRouteOptions,
} from "./recurring-jobs/recurring_job_routes.js";
import {
  registerRecurringJobHostRoutes,
  type RecurringJobHostRouteOptions,
} from "./recurring-jobs/recurring_job_host_routes.js";
import {
  registerPersistenceHostRoutes,
  type PersistenceHostRouteOptions,
} from "./control_plane/persistence_host_routes.js";
import {
  registerNodeAgentProfileRoutes,
  type NodeAgentProfileRouteOptions,
} from "./node/node_agent_profile_routes.js";
import {
  registerAgentPortraitRoutes,
  type AgentPortraitRouteOptions,
} from "./node/agent_portrait_routes.js";
import {
  registerAgentProfileRoutes,
  type AgentProfileRouteOptions,
} from "./node/agent_profile_routes.js";
import {
  registerContextBundleRoutes,
  type ContextBundleRouteOptions,
} from "./node/context_bundle_routes.js";
import {
  registerFolderRoutes,
  type FolderRouteOptions,
} from "./folders/folder_routes.js";
import {
  registerNodeClaudeAuthRoutes,
  type NodeClaudeAuthRouteOptions,
} from "./node/node_claude_auth_routes.js";
import {
  registerClaudeCentralRoutes,
  type ClaudeCentralRouteOptions,
} from "./claude_central/routes.js";
import {
  registerNodeSnapshotRoutes,
  type NodeSnapshotRouteOptions,
} from "./node/node_snapshot_routes.js";
import { registerNodeWsRoute, type NodeWsRouteOptions } from "./node/ws_route.js";
import {
  registerNodePairingRoutes,
  type NodePairingRouteOptions,
} from "./node_credentials/pairing_routes.js";
import {
  registerNodeReleaseRoutes,
  type NodeReleaseRouteOptions,
} from "./node_releases/node_release_routes.js";
import {
  registerPushRoutes,
  type PushRouteOptions,
} from "./push/push_routes.js";
import {
  registerPublicStatusRoutes,
  type PublicStatusRouteOptions,
} from "./public/public_status_routes.js";
import {
  registerSessionActionCommandRoutes,
  type SessionActionCommandRouteOptions,
} from "./session/session_action_command_routes.js";
import {
  registerSessionBackgroundScheduleRoutes,
  type SessionBackgroundScheduleRouteOptions,
} from "./session/session_background_schedule_routes.js";
import {
  registerSessionCatalogRoutes,
  type SessionCatalogRouteOptions,
} from "./session/session_catalog_routes.js";
import {
  registerSessionCommandRoutes,
  type SessionCommandRouteOptions,
} from "./session/session_command_routes.js";
import {
  registerSessionHistoryRoutes,
  type SessionHistoryRouteOptions,
} from "./session/session_history_routes.js";
import { registerSessionWorkspaceRoutes, type SessionWorkspaceRouteOptions } from "./session/session_workspace_routes.js";
import { registerSessionEventAttachmentRoutes } from
  "./session/session_event_attachment_routes.js";
import {
  registerPersistentSessionSettingsRoutes,
  type PersistentSessionSettingsRouteOptions,
} from "./session/persistent_session_settings_routes.js";
import {
  registerSessionSnapshotRoutes,
  type SessionSnapshotRouteOptions,
} from "./session/session_snapshot_routes.js";
import {
  registerSessionResumeAfterLimitRoutes,
  type SessionResumeAfterLimitRouteOptions,
} from "./session/session_resume_after_limit_routes.js";
import {
  registerSseReplayRoutes,
  type SseReplayRouteOptions,
} from "./sse/sse_replay_routes.js";
import {
  registerSystemConfigRoutes,
  type SystemConfigRouteOptions,
} from "./system/system_config_routes.js";
import {
  registerRuntimeMemoryRoutes,
  type RuntimeMemoryRouteOptions,
} from "./system/runtime_memory_routes.js";
import {
  registerUserBackgroundRoutes,
  type UserBackgroundRouteOptions,
} from "./user/user_background_routes.js";
import {
  registerUserPreferencesRoutes,
  type UserPreferencesRouteOptions,
} from "./user/user_preferences_routes.js";
import {
  registerProductionAuthGuard,
  type ProductionAuthGuardOptions,
} from "./runtime/production_auth_guard.js";
import {
  createOperationalFastifyOptions,
  registerProductionLogging,
  type ProductionLogDestination,
} from "./runtime/production_logging.js";
import {
  registerUsageSummaryRoutes,
  type UsageSummaryRouteOptions,
} from "./usage/usage_summary_routes.js";
import {
  registerSessionStatisticsRoutes,
  type SessionStatisticsRouteOptions,
} from "./usage/session_statistics_routes.js";
import {
  registerUiEventRoutes,
  type UiEventRouteOptions,
} from "./ui-events/ui_event_routes.js";

export type CreateAppOptions = {
  r2SettingsRoutes?: R2SettingsProvider;
  config: OrchServerTsConfig;
  logDestination?: ProductionLogDestination;
  corsAllowedOrigins?: readonly string[];
  productionAuth?: ProductionAuthGuardOptions;
  routeOwners?: RouteOwnerManifest;
  exposeLocalHealthRoute?: boolean;
  adminUsersRoutes?: AdminUsersRouteOptions;
  atomRoutes?: AtomRouteOptions;
  authRoutes?: AuthRouteOptions;
  oauthRoutes?: OAuthRouteOptions;
  attachmentRoutes?: AttachmentRouteOptions;
  agentAttachmentRoutes?: AgentAttachmentRouteOptions;
  workerAttachmentRoutes?: WorkerAttachmentRouteOptions;
  folderRoutes?: FolderRouteOptions;
  persistentDefaultsRoutes?: PersistentDefaultsRoutes;
  antigravityBackendRoutes?: AntigravityBackendRoutes;
  summarySettingsRoutes?: SummarySettingsRoutes;
  cardDispatchSettingsRoutes?:CardDispatchSettingsRouteOptions;
  cardOrchestrationRoutes?:CardOrchestrationRouteOptions;
  cardOrchestrationDecisionRoutes?:CardOrchestrationDecisionRouteOptions;
  nodeClaudeAuthRoutes?: NodeClaudeAuthRouteOptions;
  nodeGitSetupRoutes?: NodeGitSetupRouteOptions;
  claudeCentralRoutes?: ClaudeCentralRouteOptions;
  mcpCentralRoutes?: McpCentralRouteOptions;
  nodeAgentProfileRoutes?: NodeAgentProfileRouteOptions;
  agentContextOverviewRoutes?: AgentContextOverviewRouteOptions;
  skillGuidesRoutes?: SkillGuidesRouteOptions;
  agentProfileRoutes?: AgentProfileRouteOptions;
  agentPortraitRoutes?: AgentPortraitRouteOptions;
  contextBundleRoutes?: ContextBundleRouteOptions;
  nodeWsRoute?: NodeWsRouteOptions;
  nodeSnapshotRoutes?: NodeSnapshotRouteOptions;
  nodePairRoutes?: NodePairingRouteOptions;
  nodeReleaseRoutes?: NodeReleaseRouteOptions;
  sessionActionCommandRoutes?: SessionActionCommandRouteOptions;
  sessionBackgroundScheduleRoutes?: SessionBackgroundScheduleRouteOptions;
  sessionResumeAfterLimitRoutes?: SessionResumeAfterLimitRouteOptions;
  sessionCatalogRoutes?: SessionCatalogRouteOptions;
  persistentSessionRoutes?: PersistentSessionSettingsRouteOptions;
  conversationRoutes?: ConversationRouteOptions;
  sessionCommandRoutes?: SessionCommandRouteOptions;
  sessionHistoryRoutes?: SessionHistoryRouteOptions;
  sessionWorkspaceRoutes?: SessionWorkspaceRouteOptions;
  sessionSnapshotRoutes?: SessionSnapshotRouteOptions;
  sseReplayRoutes?: SseReplayRouteOptions;
  systemConfigRoutes?: SystemConfigRouteOptions;
  runtimeMemoryRoutes?: RuntimeMemoryRouteOptions;
  executeProxyRoutes?: ExecuteProxyRouteOptions;
  ephemeralLlmRoutes?: EphemeralLlmRouteOptions;
  pushRoutes?: PushRouteOptions;
  publicStatusRoutes?: PublicStatusRouteOptions;
  userBackgroundRoutes?: UserBackgroundRouteOptions;
  userPreferencesRoutes?: UserPreferencesRouteOptions;
  flatFolderContentRoutes?: FlatFolderContentRouteOptions;
  pageYjsRoutes?: PageYjsRouteOptions;
  boardAssetRoutes?: BoardAssetRouteOptions;
  boardItemRoutes?: BoardItemRouteOptions;
  cogitoRoutes?: CogitoRouteOptions;
  markdownDocumentRoutes?: MarkdownDocumentRouteOptions;
  scheduleHostRoutes?: ScheduleHostRouteOptions;
  recurringJobRoutes?: RecurringJobRouteOptions;
  recurringJobHostRoutes?: RecurringJobHostRouteOptions;
  externalIngress?: ExternalIngressConfig;
  ownedAgentRoutes?: OwnedAgentRouteOptions;
  accessLinkRoutes?: AccessLinkRouteOptions;
  outboundWebhookRoutes?: OutboundWebhookRouteOptions;
  inboundHookRoutes?: InboundHookRouteOptions;
  inboundWebhookRoutes?: InboundWebhookRouteOptions;
  externalAccessPublicRoutes?: ExternalAccessPublicRouteOptions;
  resolveSessionOwner?: McpHostOptions["resolveSessionOwner"];
  externalEvents?: import("./external_events/service.js").ExternalEventsService;
  mcpHostRoutes?: Omit<McpHostOptions, "recurringJobs" | "cardOrchestration" | "cluster"> & { cluster: Omit<McpHostOptions["cluster"], "logger"> } & Partial<Pick<McpHostOptions, "recurringJobs" | "cardOrchestration">>;
  persistenceHostRoutes?: PersistenceHostRouteOptions;
  persistentContextRoutes?: PersistentContextHostRouteOptions;
  usageSummaryRoutes?: UsageSummaryRouteOptions;
  sessionStatisticsRoutes?: SessionStatisticsRouteOptions;
  uiEventRoutes?: UiEventRouteOptions;
};

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({
    ...createOperationalFastifyOptions(options.config, options.logDestination),
    forceCloseConnections: true,
  });
  const owners = options.routeOwners ?? routeOwnerManifest;
  registerProductionLogging(app, options.config.environment);
  if (options.corsAllowedOrigins !== undefined) {
    registerCorsBoundary(app, options.corsAllowedOrigins);
  }
  if (options.productionAuth !== undefined) {
    registerProductionAuthGuard(app, { ...options.productionAuth, externalMcpPath: options.externalIngress?.path });
  }

  if (options.exposeLocalHealthRoute) {
    app.get("/__orch_server_ts/health", async () => ({
      ok: true,
      package: "@soulstream/orch-server-ts",
      environment: options.config.environment,
      routeOwnersArtifactOnly: owners.artifactOnly,
    }));
  }
  if (options.nodeClaudeAuthRoutes !== undefined) {
    registerNodeClaudeAuthRoutes(app, options.nodeClaudeAuthRoutes);
  }
  if (options.nodeGitSetupRoutes !== undefined) {
    registerNodeGitSetupRoutes(app, options.nodeGitSetupRoutes);
  }
  if (options.claudeCentralRoutes !== undefined) {
    registerClaudeCentralRoutes(app, options.claudeCentralRoutes);
  }
  if (options.mcpCentralRoutes !== undefined) {
    registerMcpCentralRoutes(app, options.mcpCentralRoutes);
  }
  if (options.nodeAgentProfileRoutes !== undefined) {
    registerNodeAgentProfileRoutes(app, options.nodeAgentProfileRoutes);
  }
  if (options.agentContextOverviewRoutes !== undefined) {
    registerAgentContextOverviewRoutes(app, options.agentContextOverviewRoutes);
  }
  if (options.skillGuidesRoutes !== undefined) {
    registerSkillGuidesRoutes(app, options.skillGuidesRoutes);
  }
  if (options.agentProfileRoutes !== undefined) {
    registerAgentProfileRoutes(app, options.agentProfileRoutes);
  }
  if (options.agentPortraitRoutes !== undefined) {
    registerAgentPortraitRoutes(app, options.agentPortraitRoutes);
  }
  if (options.contextBundleRoutes !== undefined) {
    registerContextBundleRoutes(app, options.contextBundleRoutes);
  }
  if (options.nodeWsRoute !== undefined) {
    registerNodeWsRoute(app, options.nodeWsRoute, {
      environment: options.config.environment,
      authBearerToken: options.config.authBearerToken,
    });
  }
  if (options.nodeSnapshotRoutes !== undefined) {
    registerNodeSnapshotRoutes(app, options.nodeSnapshotRoutes);
  }
  if (options.nodePairRoutes !== undefined) {
    registerNodePairingRoutes(app, options.nodePairRoutes);
  }
  if (options.nodeReleaseRoutes !== undefined) {
    registerNodeReleaseRoutes(app, options.nodeReleaseRoutes);
  }
  if (options.sessionCommandRoutes !== undefined) {
    registerSessionCommandRoutes(app, {
      ...options.sessionCommandRoutes,
      worktreeAuthBearerToken: options.config.authBearerToken,
      environment: options.config.environment,
    });
  }
  if (options.sessionActionCommandRoutes !== undefined) {
    registerSessionActionCommandRoutes(app, options.sessionActionCommandRoutes);
  }
  if (options.sessionBackgroundScheduleRoutes !== undefined) {
    registerSessionBackgroundScheduleRoutes(
      app,
      options.sessionBackgroundScheduleRoutes,
    );
  }
  if (options.sessionResumeAfterLimitRoutes !== undefined) {
    registerSessionResumeAfterLimitRoutes(app, options.sessionResumeAfterLimitRoutes);
  }
  if (options.recurringJobRoutes !== undefined) {
    registerRecurringJobRoutes(app, options.recurringJobRoutes);
  }
  if (options.mcpHostRoutes) {
    const mcpOptions: McpHostOptions = { ...options.mcpHostRoutes,
    ...(options.persistentDefaultsRoutes ? { persistentDefaults: options.persistentDefaultsRoutes } : {}),
    ownedAgents: options.ownedAgentRoutes?.service, resolveSessionOwner: options.resolveSessionOwner ?? options.mcpHostRoutes.resolveSessionOwner, environment: options.config.environment,
    sessionMessages: options.sessionActionCommandRoutes ?? options.mcpHostRoutes.sessionMessages,
    ...(options.mcpHostRoutes.cluster?.readSession ? { externalLlm: {
      service: options.externalEvents, getSession: options.mcpHostRoutes.cluster.readSession,
    } } : {}),
    cluster: { ...options.mcpHostRoutes.cluster, logger: app.log },
    recurringJobs: options.recurringJobHostRoutes ?? options.mcpHostRoutes.recurringJobs!,
    cardOrchestration: options.cardOrchestrationRoutes ?? options.mcpHostRoutes.cardOrchestration!,
    ...(options.pageYjsRoutes ? { pages: { service: options.pageYjsRoutes.createService(app.log), logger: app.log } } : {}),
    ...(options.skillGuidesRoutes ? { skillLintReport: options.skillGuidesRoutes.store } : {}),
    ...(options.mcpHostRoutes.skills ? { skills: { ...options.mcpHostRoutes.skills, logger: app.log } } : {}),
    };
    registerMcpHostRoutes(app, mcpOptions);
    if (options.externalIngress) {
      const close = registerExternalEventsRoutes(app, mcpOptions, options.externalIngress);
      app.addHook("onClose", async () => { await close(); });
    }
  }
  if (options.recurringJobHostRoutes !== undefined) {
    registerRecurringJobHostRoutes(app, {
      ...options.recurringJobHostRoutes,
      environment: options.config.environment,
    });
  }
  if (options.sessionCatalogRoutes !== undefined) {
    registerSessionCatalogRoutes(app, options.sessionCatalogRoutes);
  }
  if (options.conversationRoutes !== undefined) {
    registerConversationRoutes(app, options.conversationRoutes);
  }
  if (options.persistentSessionRoutes !== undefined) {
    registerPersistentSessionSettingsRoutes(app, options.persistentSessionRoutes);
  }
  if (options.sessionHistoryRoutes !== undefined) {
    registerSessionHistoryRoutes(app, options.sessionHistoryRoutes);
    registerSessionEventAttachmentRoutes(app, options.sessionHistoryRoutes);
  }
  if (options.sessionWorkspaceRoutes !== undefined) registerSessionWorkspaceRoutes(app, options.sessionWorkspaceRoutes);
  if (options.sessionSnapshotRoutes !== undefined) {
    registerSessionSnapshotRoutes(app, options.sessionSnapshotRoutes);
  }
  if (options.sseReplayRoutes !== undefined) {
    registerSseReplayRoutes(app, options.sseReplayRoutes);
  }
  if (options.systemConfigRoutes !== undefined) {
    registerSystemConfigRoutes(app, options.systemConfigRoutes);
  }
  if (options.runtimeMemoryRoutes !== undefined) {
    registerRuntimeMemoryRoutes(app, options.runtimeMemoryRoutes);
  }
  if (options.executeProxyRoutes !== undefined) {
    registerExecuteProxyRoutes(app, options.executeProxyRoutes);
  }
  if (options.ephemeralLlmRoutes !== undefined) {
    registerEphemeralLlmRoutes(app, {
      ...options.ephemeralLlmRoutes,
      environment: options.config.environment,
    });
  }
  if (options.pushRoutes !== undefined) {
    registerPushRoutes(app, options.pushRoutes);
  }
  if (options.publicStatusRoutes !== undefined) {
    registerPublicStatusRoutes(app, options.publicStatusRoutes);
  }
  if (options.authRoutes !== undefined) {
    registerAuthRoutes(app, options.authRoutes);
  }
  if (options.oauthRoutes !== undefined) {
    registerOAuthRoutes(app, options.oauthRoutes);
  }
  if (options.r2SettingsRoutes) registerR2SettingsRoutes(app, options.r2SettingsRoutes);
  if (options.ownedAgentRoutes) registerOwnedAgentRoutes(app, options.ownedAgentRoutes);
  if (options.accessLinkRoutes) registerAccessLinkRoutes(app, options.accessLinkRoutes);
  if (options.outboundWebhookRoutes) registerOutboundWebhookRoutes(app, options.outboundWebhookRoutes);
  if (options.inboundHookRoutes) registerInboundHookRoutes(app, options.inboundHookRoutes);
  if (options.inboundWebhookRoutes) registerInboundWebhookRoutes(app, options.inboundWebhookRoutes);
  if (options.externalAccessPublicRoutes) {
    registerExternalAccessPublicRoutes(app, options.externalAccessPublicRoutes);
  }
  if (options.adminUsersRoutes !== undefined) {
    registerAdminUsersRoutes(app, options.adminUsersRoutes);
  }
  if (options.atomRoutes !== undefined) {
    registerAtomRoutes(app, options.atomRoutes);
  }
  if (options.attachmentRoutes !== undefined) {
    registerAttachmentRoutes(app, options.attachmentRoutes);
  }
  if (options.agentAttachmentRoutes !== undefined) {
    registerAgentAttachmentRoutes(app, options.agentAttachmentRoutes);
  }
  if (options.workerAttachmentRoutes !== undefined) {
    registerWorkerAttachmentRoutes(app, options.workerAttachmentRoutes);
  }
  if (options.userBackgroundRoutes !== undefined) {
    registerUserBackgroundRoutes(app, options.userBackgroundRoutes);
  }
  if (options.userPreferencesRoutes !== undefined) {
    registerUserPreferencesRoutes(app, options.userPreferencesRoutes);
  }
  if (options.persistentDefaultsRoutes) registerPersistentDefaultsRoutes(app, options.persistentDefaultsRoutes);
  if (options.antigravityBackendRoutes) registerAntigravityBackendRoutes(app, options.antigravityBackendRoutes);
  if (options.summarySettingsRoutes) registerSummarySettingsRoutes(app, options.summarySettingsRoutes);
  if (options.cardDispatchSettingsRoutes) registerCardDispatchSettingsRoutes(app,options.cardDispatchSettingsRoutes);
  if (options.cardOrchestrationRoutes) registerCardOrchestrationRoutes(app,options.cardOrchestrationRoutes);
  if (options.cardOrchestrationDecisionRoutes) registerCardOrchestrationDecisionRoutes(app,options.cardOrchestrationDecisionRoutes);
  if (options.folderRoutes !== undefined) {
    registerFolderRoutes(app, {
      ...options.folderRoutes,
      environment: options.config.environment,
    });
  }
  if (options.flatFolderContentRoutes !== undefined) {
    registerFlatFolderContentRoutes(app, {
      ...options.flatFolderContentRoutes,
      environment: options.config.environment,
    });
  }
  if (options.pageYjsRoutes !== undefined) {
    registerPageYjsRoutes(app, {
      ...options.pageYjsRoutes,
      environment: options.config.environment,
    });
  }
  if (options.boardAssetRoutes !== undefined) {
    registerBoardAssetRoutes(app, options.boardAssetRoutes);
  }
  if (options.boardItemRoutes !== undefined) {
    registerBoardItemRoutes(app, options.boardItemRoutes);
  }
  if (options.cogitoRoutes !== undefined) {
    registerCogitoRoutes(app, options.cogitoRoutes);
  }
  if (options.markdownDocumentRoutes !== undefined) {
    registerMarkdownDocumentRoutes(app, options.markdownDocumentRoutes);
  }

  if (options.scheduleHostRoutes !== undefined) {
    registerScheduleHostRoute(app, {
      ...options.scheduleHostRoutes,
      environment: options.config.environment,
    });
  }
  if (options.persistenceHostRoutes !== undefined) {
    registerPersistenceHostRoutes(app, {
      ...options.persistenceHostRoutes,
      environment: options.config.environment,
    });
  }
  if (options.persistentContextRoutes !== undefined) {
    registerPersistentContextHostRoutes(app, {
      ...options.persistentContextRoutes,
      environment: options.config.environment,
    });
  }
  if (options.usageSummaryRoutes !== undefined) {
    registerUsageSummaryRoutes(app, options.usageSummaryRoutes);
  }
  if (options.sessionStatisticsRoutes !== undefined) {
    registerSessionStatisticsRoutes(app, options.sessionStatisticsRoutes);
  }
  if (options.uiEventRoutes !== undefined) {
    registerUiEventRoutes(app, options.uiEventRoutes);
  }

  return app;
}

function registerCorsBoundary(
  app: FastifyInstance,
  allowedOrigins: readonly string[],
): void {
  const allowed = new Set(allowedOrigins);
  app.addHook("onRequest", async (request, reply) => {
    // The public access link surface answers no CORS: no headers on its
    // responses and no preflight. Other paths keep the existing behavior.
    if (isExternalAccessRequestPath(request.url.split("?", 1)[0] || "/")) {
      return;
    }
    const origin = singleHeader(request.headers.origin);
    const originAllowed = origin !== undefined &&
      (allowed.has(origin) || allowed.has("*"));
    if (originAllowed) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    if (request.method !== "OPTIONS" || origin === undefined) return;
    if (!originAllowed) {
      return reply.code(400).send({ detail: "Disallowed CORS origin" });
    }
    reply.header(
      "access-control-allow-methods",
      "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT",
    );
    const requestedHeaders = singleHeader(
      request.headers["access-control-request-headers"],
    );
    if (requestedHeaders !== undefined) {
      reply.header("access-control-allow-headers", requestedHeaders);
    }
    return reply.code(200).send("OK");
  });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
