import type { BoardYjsHostHttpClient } from "../board/board_yjs_host_proxy.js";
import type { BoardAccess } from "../board/board_access.js";
import type { BoardItemRouteProvider } from "../board/board_item_routes.js";
import type { MarkdownDocumentRouteProvider } from "../board/markdown_document_routes.js";
import type { RunbookRouteProvider } from "../runbooks/runbook_route_types.js";
import type { SessionCatalogProvider } from "../session/session_catalog_routes.js";
import type { SessionHistoryProvider } from "../session/session_history_service.js";
import type {
  SessionResourceAccessRepository,
} from "../session/session_resource_access.js";
import type {
  SessionStreamSnapshot,
  TaskStreamSnapshot,
} from "../sse/sse_replay_routes.js";
import type {
  InMemorySseReplayBroadcaster,
  TaskStreamEvent,
} from "../sse/replay_broadcaster.js";
import type { TaskMutationRouteProvider } from "../tasks/task_mutation_routes.js";
import type { TaskReadRouteProvider } from "../tasks/task_read_routes.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";
import type { LiveTaskChangeListener } from "./live_task_change_listener.js";
import type { LiveSystemPortraitAssetBoundary } from "./live_system_config_route_provider.js";

export const liveProviderDependencyCategories = [
  "authSessionIdentity",
  "dbCatalogRepository",
  "nodeHttpClient",
  "fileBlobR2Storage",
  "jwtToken",
  "claudeOAuth",
  "pushRepository",
  "configProvider",
  "systemPortraitAssets",
] as const;

export type LiveProviderDependencyCategory =
  (typeof liveProviderDependencyCategories)[number];

export type LiveAuthSessionIdentityBoundary = {
  readonly resolveCallerIdentity: (input: unknown) => unknown | Promise<unknown>;
  readonly resolveSessionIdentity: (input: unknown) => unknown | Promise<unknown>;
};

export type LiveDbCatalogRepositoryBoundary = {
  readonly folderRouteProvider: LiveFolderProvider;
  readonly folderCountsProvider: LiveFolderProvider;
  readonly boardItemRouteProvider: BoardItemRouteProvider;
  readonly markdownDocumentRouteProvider: MarkdownDocumentRouteProvider;
  readonly runbookRouteProvider: RunbookRouteProvider;
  readonly sessionCatalogProvider: SessionCatalogProvider;
  readonly loadSessionSnapshot: (
    input?: { readonly access?: BoardAccess; readonly feedOnly?: boolean },
  ) => Promise<SessionStreamSnapshot>;
  readonly loadTaskSnapshot: () => Promise<TaskStreamSnapshot>;
  readonly sessionHistoryProvider: SessionHistoryProvider;
  readonly sessionResourceAccessRepository: SessionResourceAccessRepository;
  readonly taskReadProvider: TaskReadRouteProvider;
  readonly taskMutationProvider: TaskMutationRouteProvider;
  readonly createTaskChangeListener: (
    broadcaster: InMemorySseReplayBroadcaster<TaskStreamEvent>,
  ) => LiveTaskChangeListener;
};

export type LiveNodeHttpResponse = {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
};

export type LiveNodeHttpRequest = {
  readonly nodeId: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly responseType?: "arrayBuffer";
};

export type LiveNodeHttpClientBoundary = {
  readonly boardYjsHostHttpClient: BoardYjsHostHttpClient;
  readonly requestNode: (
    request: LiveNodeHttpRequest,
  ) => Promise<LiveNodeHttpResponse>;
};

export type LiveFileBlobStorageBoundary = {
  readonly readObject: (key: string) => Promise<Uint8Array>;
  readonly writeObject: (key: string, body: Uint8Array) => Promise<void>;
  readonly deleteObject: (key: string) => Promise<void>;
};

export type LiveJwtTokenBoundary = {
  readonly sign: (payload: unknown) => string | Promise<string>;
  readonly verify: (token: string) => unknown | Promise<unknown>;
};

export type LiveClaudeOAuthBoundary = {
  readonly buildAuthorizeUrl: (input: unknown) => string | Promise<string>;
  readonly exchangeCode: (input: unknown) => unknown | Promise<unknown>;
  readonly fetchProfile: (input: unknown) => unknown | Promise<unknown>;
};

export type LivePushRepositoryBoundary = {
  readonly register: (input: unknown) => void | Promise<void>;
  readonly remove: (input: unknown) => void | Promise<void>;
};

export type LiveConfigProviderBoundary = {
  readonly getConfig: () =>
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  readonly requireConfig: (key: string) => unknown | Promise<unknown>;
};

export type LiveProviderDependencies = {
  readonly authSessionIdentity: LiveAuthSessionIdentityBoundary;
  readonly dbCatalogRepository: LiveDbCatalogRepositoryBoundary;
  readonly nodeHttpClient: LiveNodeHttpClientBoundary;
  readonly fileBlobR2Storage: LiveFileBlobStorageBoundary;
  readonly jwtToken: LiveJwtTokenBoundary;
  readonly claudeOAuth: LiveClaudeOAuthBoundary;
  readonly pushRepository: LivePushRepositoryBoundary;
  readonly configProvider: LiveConfigProviderBoundary;
  readonly systemPortraitAssets: LiveSystemPortraitAssetBoundary;
};
