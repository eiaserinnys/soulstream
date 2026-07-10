import type { BoardYjsHostHttpClient } from "../board/board_yjs_host_proxy.js";
import type { BoardAccess } from "../board/board_access.js";
import type { BoardAssetRouteProvider } from "../board/board_asset_routes.js";
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
import type { LiveTaskMutationProvider } from "./live_task_mutation_provider.js";
import type { TaskReadRouteProvider } from "../tasks/task_read_routes.js";
import type { PushNotificationRepository } from "../push/push_notifier.js";
import type { UserBackgroundRepository } from "../user/user_background_routes.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";
import type { LiveTaskChangeListener } from "./live_task_change_listener.js";
import type { LiveSystemPortraitAssetBoundary } from "./live_system_config_route_provider.js";
import type { LiveAdminUsersRepository } from "./live_admin_users_route_provider.js";

export const liveProviderDependencyCategories = [
  "dbCatalogRepository",
  "nodeHttpClient",
  "pushRepository",
  "configProvider",
  "systemPortraitAssets",
] as const;

export type LiveProviderDependencyCategory =
  (typeof liveProviderDependencyCategories)[number];

export type LiveDbCatalogRepositoryBoundary = {
  readonly adminUsersRepository: LiveAdminUsersRepository;
  readonly folderRouteProvider: LiveFolderProvider;
  readonly folderCountsProvider: LiveFolderProvider;
  readonly boardAssetRouteProvider: BoardAssetRouteProvider;
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
  readonly taskMutationProvider: LiveTaskMutationProvider;
  readonly userPreferencesRepository: UserBackgroundRepository;
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

export type LivePushRepositoryBoundary = PushNotificationRepository;

export type LiveConfigProviderBoundary = {
  readonly getConfig: () =>
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  readonly requireConfig: (key: string) => unknown | Promise<unknown>;
};

export type LiveProviderDependencies = {
  readonly dbCatalogRepository: LiveDbCatalogRepositoryBoundary;
  readonly nodeHttpClient: LiveNodeHttpClientBoundary;
  readonly pushRepository: LivePushRepositoryBoundary;
  readonly configProvider: LiveConfigProviderBoundary;
  readonly systemPortraitAssets: LiveSystemPortraitAssetBoundary;
};
