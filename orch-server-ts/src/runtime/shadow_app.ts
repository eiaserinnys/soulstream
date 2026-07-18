import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AdminUsersRouteOptions } from "../admin/admin_users_routes.js";
import type { CreateAppOptions } from "../app.js";
import { createApp } from "../app.js";
import type { AtomRouteOptions } from "../atom/atom_routes.js";
import type { AttachmentRouteOptions } from "../attachments/attachment_routes.js";
import type { AuthRouteOptions } from "../auth/auth_routes.js";
import type { BoardAssetRouteOptions } from "../board/board_asset_routes.js";
import type { BoardItemRouteOptions } from "../board/board_item_routes.js";
import type {
  BoardYjsHostHttpClient,
  BoardYjsHostProxyRouteOptions,
} from "../board/board_yjs_host_proxy.js";
import type { MarkdownDocumentRouteOptions } from "../board/markdown_document_routes.js";
import type { CogitoRouteOptions } from "../cogito/cogito_routes.js";
import type { OrchServerTsConfig } from "../config.js";
import type { RouteOwnerManifest } from "../contract/route_owner_manifest.js";
import type { ExecuteProxyRouteOptions } from "../execute/execute_proxy_routes.js";
import type { FolderRouteOptions } from "../folders/folder_routes.js";
import type { NodeAgentProfileRouteOptions } from "../node/node_agent_profile_routes.js";
import type { NodeClaudeAuthRouteOptions } from "../node/node_claude_auth_routes.js";
import type {
  NodeCommandClock,
  NodeCommandRequestIdGenerator,
} from "../node/pending_commands.js";
import type { PublicStatusRouteOptions } from "../public/public_status_routes.js";
import type { PageYjsRouteOptions } from "../page/page_yjs_route.js";
import type { PushRouteOptions } from "../push/push_routes.js";
import type { RunbookRouteOptions } from "../runbooks/runbook_route_types.js";
import type { SessionCatalogRouteOptions } from "../session/session_catalog_routes.js";
import type { SessionHistoryProvider } from "../session/session_history_service.js";
import type { SessionStreamSnapshot } from "../sse/sse_replay_routes.js";
import type { SystemConfigRouteOptions } from "../system/system_config_routes.js";
import type { UserBackgroundRouteOptions } from "../user/user_background_routes.js";
import type { UserPreferencesRouteOptions } from "../user/user_preferences_routes.js";
import {
  createOrchestratorRuntimeServices,
  type OrchestratorRuntimeServices,
} from "./composition.js";

export type ShadowOrchestratorRuntimeProviders = {
  nowMs?: NodeCommandClock;
  requestIdGenerator?: NodeCommandRequestIdGenerator;
  commandTimeoutMs?: number;
  sessionSseInstanceId?: string;
  sseRingMaxlen?: number;
  sseKeepaliveMs?: number;
  sseReplayOnlyForTests?: boolean;
  nodeStreamKeepaliveMs?: number;
  nodeStreamCloseAfterInitialSnapshot?: boolean;
  loadSessionSnapshot?: (request: FastifyRequest) => Promise<SessionStreamSnapshot>;
  sessionHistoryProvider: SessionHistoryProvider;
  sessionHistoryKeepaliveMs?: number;
  sessionHistoryCloseAfterHistorySync?: boolean;
  boardYjsHostHttpClient: BoardYjsHostHttpClient;
  pageYjsRoutes: PageYjsRouteOptions;
};

export type ShadowNodeClaudeAuthRouteProviders = Omit<
  NodeClaudeAuthRouteOptions,
  "registry" | "bridge"
>;

export type ShadowBoardItemRouteProviders = Omit<
  BoardItemRouteOptions,
  "hostProxy"
>;

export type ShadowMarkdownDocumentRouteProviders = Omit<
  MarkdownDocumentRouteOptions,
  "hostProxy"
>;

export type ShadowOrchestratorProviderBundle = {
  runtime: ShadowOrchestratorRuntimeProviders;
  adminUsersRoutes: AdminUsersRouteOptions;
  atomRoutes: AtomRouteOptions;
  authRoutes: AuthRouteOptions;
  attachmentRoutes: AttachmentRouteOptions;
  boardAssetRoutes: BoardAssetRouteOptions;
  boardItemRoutes: ShadowBoardItemRouteProviders;
  cogitoRoutes: CogitoRouteOptions;
  executeProxyRoutes: ExecuteProxyRouteOptions;
  folderRoutes: FolderRouteOptions;
  markdownDocumentRoutes: ShadowMarkdownDocumentRouteProviders;
  nodeAgentProfileRoutes: NodeAgentProfileRouteOptions;
  nodeClaudeAuthRoutes: ShadowNodeClaudeAuthRouteProviders;
  publicStatusRoutes: PublicStatusRouteOptions;
  pushRoutes: PushRouteOptions;
  runbookRoutes: RunbookRouteOptions;
  sessionCatalogRoutes: SessionCatalogRouteOptions;
  systemConfigRoutes: SystemConfigRouteOptions;
  userBackgroundRoutes: UserBackgroundRouteOptions;
  userPreferencesRoutes: UserPreferencesRouteOptions;
};

export type CreateShadowOrchestratorAppOptions = {
  config: OrchServerTsConfig;
  routeOwners?: RouteOwnerManifest;
  exposeLocalHealthRoute?: boolean;
  providers: ShadowOrchestratorProviderBundle;
};

export type ShadowOrchestratorRouteOptions = Required<
  Pick<
    CreateAppOptions,
    | "adminUsersRoutes"
    | "atomRoutes"
    | "authRoutes"
    | "attachmentRoutes"
    | "boardAssetRoutes"
    | "boardItemRoutes"
    | "boardYjsHostProxyRoutes"
    | "cogitoRoutes"
    | "executeProxyRoutes"
    | "folderRoutes"
    | "markdownDocumentRoutes"
    | "nodeAgentProfileRoutes"
    | "nodeClaudeAuthRoutes"
    | "nodeSnapshotRoutes"
    | "nodeWsRoute"
    | "pageYjsRoutes"
    | "publicStatusRoutes"
    | "pushRoutes"
    | "runbookRoutes"
    | "sessionActionCommandRoutes"
    | "sessionBackgroundScheduleRoutes"
    | "sessionCatalogRoutes"
    | "sessionCommandRoutes"
    | "sessionHistoryRoutes"
    | "sessionSnapshotRoutes"
    | "sseReplayRoutes"
    | "systemConfigRoutes"
    | "userBackgroundRoutes"
    | "userPreferencesRoutes"
  >
>;

export type ShadowOrchestratorAppComposition = OrchestratorRuntimeServices & {
  app: FastifyInstance;
  shadowRouteOptions: ShadowOrchestratorRouteOptions;
};

type ShadowRouteProviderRequirement = {
  readonly owner: string;
  readonly paths: readonly string[];
};

export const shadowRouteCompositionRequirements = [
  { owner: "admin.users", paths: ["adminUsersRoutes.provider"] },
  { owner: "atom", paths: ["atomRoutes.configProvider", "atomRoutes.httpClient"] },
  {
    owner: "attachments",
    paths: [
      "attachmentRoutes.provider",
      "attachmentRoutes.accessProvider",
      "attachmentRoutes.transport",
    ],
  },
  {
    owner: "auth",
    paths: [
      "authRoutes.configProvider",
      "authRoutes.resolveTokenAccess",
      "authRoutes.nativeVerifier",
      "authRoutes.jwt",
      "authRoutes.httpClient",
      "authRoutes.userPayloadExtra",
    ],
  },
  {
    owner: "board.assets",
    paths: ["boardAssetRoutes.provider", "boardAssetRoutes.accessProvider"],
  },
  {
    owner: "board.items",
    paths: ["boardItemRoutes.provider", "boardItemRoutes.accessProvider"],
  },
  { owner: "board.yjs-host", paths: ["runtime.boardYjsHostHttpClient"] },
  {
    owner: "cogito",
    paths: [
      "cogitoRoutes.provider",
      "cogitoRoutes.httpClient",
      "cogitoRoutes.briefCollector",
    ],
  },
  { owner: "execute", paths: ["executeProxyRoutes.provider"] },
  {
    owner: "folders",
    paths: ["folderRoutes.provider", "folderRoutes.accessProvider"],
  },
  {
    owner: "markdown.documents",
    paths: ["markdownDocumentRoutes.provider", "markdownDocumentRoutes.accessProvider"],
  },
  {
    owner: "page.yjs",
    paths: ["runtime"],
  },
  {
    owner: "page.browser",
    paths: ["runtime.pageYjsRoutes.resolveBrowserUser"],
  },
  {
    owner: "planner",
    paths: ["runtime.pageYjsRoutes.plannerReads"],
  },
  { owner: "node.agent-profiles", paths: ["nodeAgentProfileRoutes.provider"] },
  {
    owner: "node.claude-auth",
    paths: [
      "nodeClaudeAuthRoutes.provider",
      "nodeClaudeAuthRoutes.pkce",
      "nodeClaudeAuthRoutes.sessionStore",
      "nodeClaudeAuthRoutes.tokenExchange",
      "nodeClaudeAuthRoutes.profileHttpClient",
    ],
  },
  { owner: "node.snapshot", paths: ["runtime"] },
  { owner: "node.ws", paths: ["runtime"] },
  {
    owner: "public.status",
    paths: [
      "publicStatusRoutes.configProvider",
      "publicStatusRoutes.folderCountsProvider",
    ],
  },
  {
    owner: "push",
    paths: ["pushRoutes.repository", "pushRoutes.resolveJwtUser"],
  },
  {
    owner: "runbooks",
    paths: [
      "runbookRoutes.provider",
      "runbookRoutes.accessProvider",
      "runbookRoutes.httpClient",
    ],
  },
  { owner: "session.actions", paths: ["runtime"] },
  { owner: "session.background-schedule", paths: ["runtime"] },
  {
    owner: "session.catalog",
    paths: ["sessionCatalogRoutes.provider", "sessionCatalogRoutes.accessProvider"],
  },
  { owner: "session.command", paths: ["runtime"] },
  { owner: "session.history", paths: ["runtime.sessionHistoryProvider"] },
  { owner: "session.snapshot", paths: ["runtime"] },
  {
    owner: "sse.replay",
    paths: ["runtime.loadSessionSnapshot"],
  },
  {
    owner: "system.config",
    paths: ["systemConfigRoutes.provider", "systemConfigRoutes.httpClient"],
  },
  {
    owner: "user.background",
    paths: [
      "userBackgroundRoutes.repository",
      "userBackgroundRoutes.resolveAuthenticatedEmail",
    ],
  },
  {
    owner: "user.preferences",
    paths: [
      "userPreferencesRoutes.repository",
      "userPreferencesRoutes.resolveAuthenticatedEmail",
    ],
  },
] as const satisfies readonly ShadowRouteProviderRequirement[];

export const shadowRouteCompositionOwners =
  shadowRouteCompositionRequirements.map((requirement) => requirement.owner);

export class ShadowOrchestratorProviderError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Missing shadow orchestrator route providers: ${missing.join("; ")}`);
    this.name = "ShadowOrchestratorProviderError";
    this.missing = missing;
  }
}

export function createShadowOrchestratorApp(
  options: CreateShadowOrchestratorAppOptions,
): ShadowOrchestratorAppComposition {
  assertShadowProviderBundle(options.providers);
  const { pageYjsRoutes: _pageYjsRoutes, ...runtimeProviders } =
    options.providers.runtime;
  const runtime = createOrchestratorRuntimeServices({
    config: options.config,
    routeOwners: options.routeOwners,
    exposeLocalHealthRoute: options.exposeLocalHealthRoute,
    ...runtimeProviders,
    enableSessionActionCommandRoutes: true,
    enableSessionBackgroundScheduleRoutes: true,
    sessionHistoryProvider: options.providers.runtime.sessionHistoryProvider,
  });
  const shadowRouteOptions = buildShadowRouteOptions(
    options.providers,
    runtime,
  );
  const app = createApp({
    config: options.config,
    routeOwners: options.routeOwners,
    exposeLocalHealthRoute: options.exposeLocalHealthRoute,
    ...shadowRouteOptions,
  });

  return {
    app,
    ...runtime,
    shadowRouteOptions,
  };
}

export function assertShadowProviderBundle(
  providers: unknown,
): asserts providers is ShadowOrchestratorProviderBundle {
  const missing = collectMissingShadowProviderRequirements(providers);
  if (missing.length > 0) {
    throw new ShadowOrchestratorProviderError(missing);
  }
}

export function collectMissingShadowProviderRequirements(
  providers: unknown,
): string[] {
  return shadowRouteCompositionRequirements.flatMap((requirement) =>
    requirement.paths
      .filter((path) => readPath(providers, path) == null)
      .map((path) => `${requirement.owner}: ${path}`),
  );
}

function buildShadowRouteOptions(
  providers: ShadowOrchestratorProviderBundle,
  runtime: OrchestratorRuntimeServices,
): ShadowOrchestratorRouteOptions {
  const boardYjsHostProxyRoutes = runtime.routeOptions.boardYjsHostProxyRoutes;
  return {
    adminUsersRoutes: providers.adminUsersRoutes,
    atomRoutes: providers.atomRoutes,
    authRoutes: providers.authRoutes,
    attachmentRoutes: providers.attachmentRoutes,
    boardAssetRoutes: providers.boardAssetRoutes,
    boardItemRoutes: {
      provider: providers.boardItemRoutes.provider,
      accessProvider: providers.boardItemRoutes.accessProvider,
      hostProxy: boardYjsHostProxyRoutes,
    },
    boardYjsHostProxyRoutes,
    cogitoRoutes: providers.cogitoRoutes,
    executeProxyRoutes: providers.executeProxyRoutes,
    folderRoutes: providers.folderRoutes,
    markdownDocumentRoutes: {
      provider: providers.markdownDocumentRoutes.provider,
      accessProvider: providers.markdownDocumentRoutes.accessProvider,
      hostProxy: boardYjsHostProxyRoutes,
    },
    pageYjsRoutes: providers.runtime.pageYjsRoutes,
    nodeAgentProfileRoutes: providers.nodeAgentProfileRoutes,
    nodeClaudeAuthRoutes: {
      provider: providers.nodeClaudeAuthRoutes.provider,
      pkce: providers.nodeClaudeAuthRoutes.pkce,
      sessionStore: providers.nodeClaudeAuthRoutes.sessionStore,
      tokenExchange: providers.nodeClaudeAuthRoutes.tokenExchange,
      profileHttpClient: providers.nodeClaudeAuthRoutes.profileHttpClient,
      timeoutMs: providers.nodeClaudeAuthRoutes.timeoutMs,
      registry: runtime.registry,
      bridge: runtime.sessionBridge,
    },
    nodeSnapshotRoutes: runtime.routeOptions.nodeSnapshotRoutes,
    nodeWsRoute: runtime.routeOptions.nodeWsRoute,
    publicStatusRoutes: providers.publicStatusRoutes,
    pushRoutes: providers.pushRoutes,
    runbookRoutes: providers.runbookRoutes,
    sessionActionCommandRoutes: requireRuntimeRouteOption(
      runtime.routeOptions.sessionActionCommandRoutes,
      "session.actions",
    ),
    sessionBackgroundScheduleRoutes:
      requireRuntimeRouteOption(
        runtime.routeOptions.sessionBackgroundScheduleRoutes,
        "session.background-schedule",
      ),
    sessionCatalogRoutes: providers.sessionCatalogRoutes,
    sessionCommandRoutes: runtime.routeOptions.sessionCommandRoutes,
    sessionHistoryRoutes: {
      ...requireRuntimeRouteOption(
        runtime.routeOptions.sessionHistoryRoutes,
        "session.history",
      ),
      accessProvider: providers.sessionCatalogRoutes.accessProvider,
    },
    sessionSnapshotRoutes: runtime.routeOptions.sessionSnapshotRoutes,
    sseReplayRoutes: runtime.routeOptions.sseReplayRoutes,
    systemConfigRoutes: providers.systemConfigRoutes,
    userBackgroundRoutes: providers.userBackgroundRoutes,
    userPreferencesRoutes: providers.userPreferencesRoutes,
  };
}

function readPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function requireRuntimeRouteOption<T>(value: T | undefined, owner: string): T {
  if (value === undefined) {
    throw new ShadowOrchestratorProviderError([`${owner}: runtime`]);
  }
  return value;
}
