import Fastify, { type FastifyInstance } from "fastify";

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
  registerBoardYjsHostProxyRoutes,
  type BoardYjsHostProxyRouteOptions,
} from "./board/board_yjs_host_proxy.js";
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
  registerRunbookRoutes,
  type RunbookRouteOptions,
} from "./runbooks/runbook_routes.js";
import {
  registerNodeAgentProfileRoutes,
  type NodeAgentProfileRouteOptions,
} from "./node/node_agent_profile_routes.js";
import {
  registerFolderRoutes,
  type FolderRouteOptions,
} from "./folders/folder_routes.js";
import {
  registerNodeClaudeAuthRoutes,
  type NodeClaudeAuthRouteOptions,
} from "./node/node_claude_auth_routes.js";
import {
  registerNodeSnapshotRoutes,
  type NodeSnapshotRouteOptions,
} from "./node/node_snapshot_routes.js";
import { registerNodeWsRoute, type NodeWsRouteOptions } from "./node/ws_route.js";
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
import {
  registerSessionSnapshotRoutes,
  type SessionSnapshotRouteOptions,
} from "./session/session_snapshot_routes.js";
import {
  registerSseReplayRoutes,
  type SseReplayRouteOptions,
} from "./sse/sse_replay_routes.js";
import {
  registerSystemConfigRoutes,
  type SystemConfigRouteOptions,
} from "./system/system_config_routes.js";
import {
  registerTaskReadRoutes,
  type TaskReadRouteOptions,
} from "./tasks/task_read_routes.js";
import {
  registerTaskMutationRoutes,
  type TaskMutationRouteOptions,
} from "./tasks/task_mutation_routes.js";
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

export type CreateAppOptions = {
  config: OrchServerTsConfig;
  logDestination?: ProductionLogDestination;
  corsAllowedOrigins?: readonly string[];
  productionAuth?: ProductionAuthGuardOptions;
  routeOwners?: RouteOwnerManifest;
  exposeLocalHealthRoute?: boolean;
  adminUsersRoutes?: AdminUsersRouteOptions;
  atomRoutes?: AtomRouteOptions;
  authRoutes?: AuthRouteOptions;
  attachmentRoutes?: AttachmentRouteOptions;
  folderRoutes?: FolderRouteOptions;
  nodeClaudeAuthRoutes?: NodeClaudeAuthRouteOptions;
  nodeAgentProfileRoutes?: NodeAgentProfileRouteOptions;
  nodeWsRoute?: NodeWsRouteOptions;
  nodeSnapshotRoutes?: NodeSnapshotRouteOptions;
  sessionActionCommandRoutes?: SessionActionCommandRouteOptions;
  sessionBackgroundScheduleRoutes?: SessionBackgroundScheduleRouteOptions;
  sessionCatalogRoutes?: SessionCatalogRouteOptions;
  sessionCommandRoutes?: SessionCommandRouteOptions;
  sessionHistoryRoutes?: SessionHistoryRouteOptions;
  sessionSnapshotRoutes?: SessionSnapshotRouteOptions;
  sseReplayRoutes?: SseReplayRouteOptions;
  systemConfigRoutes?: SystemConfigRouteOptions;
  taskReadRoutes?: TaskReadRouteOptions;
  taskMutationRoutes?: TaskMutationRouteOptions;
  executeProxyRoutes?: ExecuteProxyRouteOptions;
  pushRoutes?: PushRouteOptions;
  publicStatusRoutes?: PublicStatusRouteOptions;
  userBackgroundRoutes?: UserBackgroundRouteOptions;
  userPreferencesRoutes?: UserPreferencesRouteOptions;
  boardYjsHostProxyRoutes?: BoardYjsHostProxyRouteOptions;
  boardAssetRoutes?: BoardAssetRouteOptions;
  boardItemRoutes?: BoardItemRouteOptions;
  cogitoRoutes?: CogitoRouteOptions;
  markdownDocumentRoutes?: MarkdownDocumentRouteOptions;
  runbookRoutes?: RunbookRouteOptions;
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
    registerProductionAuthGuard(app, options.productionAuth);
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
  if (options.nodeAgentProfileRoutes !== undefined) {
    registerNodeAgentProfileRoutes(app, options.nodeAgentProfileRoutes);
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
  if (options.sessionCommandRoutes !== undefined) {
    registerSessionCommandRoutes(app, options.sessionCommandRoutes);
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
  if (options.sessionCatalogRoutes !== undefined) {
    registerSessionCatalogRoutes(app, options.sessionCatalogRoutes);
  }
  if (options.sessionHistoryRoutes !== undefined) {
    registerSessionHistoryRoutes(app, options.sessionHistoryRoutes);
  }
  if (options.sessionSnapshotRoutes !== undefined) {
    registerSessionSnapshotRoutes(app, options.sessionSnapshotRoutes);
  }
  if (options.sseReplayRoutes !== undefined) {
    registerSseReplayRoutes(app, options.sseReplayRoutes);
  }
  if (options.systemConfigRoutes !== undefined) {
    registerSystemConfigRoutes(app, options.systemConfigRoutes);
  }
  if (options.taskReadRoutes !== undefined) {
    registerTaskReadRoutes(app, options.taskReadRoutes);
  }
  if (options.taskMutationRoutes !== undefined) {
    registerTaskMutationRoutes(app, options.taskMutationRoutes);
  }
  if (options.executeProxyRoutes !== undefined) {
    registerExecuteProxyRoutes(app, options.executeProxyRoutes);
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
  if (options.adminUsersRoutes !== undefined) {
    registerAdminUsersRoutes(app, options.adminUsersRoutes);
  }
  if (options.atomRoutes !== undefined) {
    registerAtomRoutes(app, options.atomRoutes);
  }
  if (options.attachmentRoutes !== undefined) {
    registerAttachmentRoutes(app, options.attachmentRoutes);
  }
  if (options.userBackgroundRoutes !== undefined) {
    registerUserBackgroundRoutes(app, options.userBackgroundRoutes);
  }
  if (options.userPreferencesRoutes !== undefined) {
    registerUserPreferencesRoutes(app, options.userPreferencesRoutes);
  }
  if (options.folderRoutes !== undefined) {
    registerFolderRoutes(app, options.folderRoutes);
  }
  if (options.boardYjsHostProxyRoutes !== undefined) {
    registerBoardYjsHostProxyRoutes(app, options.boardYjsHostProxyRoutes);
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
  if (options.runbookRoutes !== undefined) {
    registerRunbookRoutes(app, options.runbookRoutes);
  }

  return app;
}

function registerCorsBoundary(
  app: FastifyInstance,
  allowedOrigins: readonly string[],
): void {
  const allowed = new Set(allowedOrigins);
  app.addHook("onRequest", async (request, reply) => {
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
