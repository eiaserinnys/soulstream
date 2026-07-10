import type { InMemoryNodeRegistry } from "../node/registry.js";
import {
  normalizeBoardAccess,
  type BoardAccess,
  type BoardAccessFolderRecord,
} from "../board/board_access.js";
import type {
  SessionCatalogProvider,
} from "../session/session_catalog_routes.js";
import {
  firstAllowedSessionFolderId,
  type SessionResourceAccessRepository,
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
import type { LiveConfigProviderBoundary } from "./live_provider_dependencies.js";
import {
  createLiveDbSqlResolver,
  type LiveDbSqlResolver,
  type LivePostgresFactory,
  type LivePostgresSql,
} from "./live_db_sql.js";
import {
  createLiveFolderProvider,
  type LiveFolderProvider,
} from "./live_folder_route_provider.js";
import { createLiveBoardItemRouteProvider } from "./live_board_item_route_provider.js";
import type { BoardItemRouteProvider } from "../board/board_item_routes.js";
import {
  createLiveBoardAssetRouteProvider,
} from "./live_board_asset_route_provider.js";
import type { BoardAssetRouteProvider } from "../board/board_asset_routes.js";
import type { LiveBoardAssetStorage } from "./live_board_asset_storage.js";
import { createLiveMarkdownDocumentRouteProvider } from "./live_markdown_document_route_provider.js";
import type { MarkdownDocumentRouteProvider } from "../board/markdown_document_routes.js";
import { createLiveRunbookRouteProvider } from "./live_runbook_route_provider.js";
import type { RunbookRouteProvider } from "../runbooks/runbook_route_types.js";
import { createLiveSessionHistoryProvider } from "./live_session_history_provider.js";
import { serializeSessionRow } from "./live_session_serialization.js";
import {
  createLiveTaskChangeListener,
  type LiveTaskChangeListener,
} from "./live_task_change_listener.js";
import { createLiveTaskMutationProvider } from "./live_task_mutation_provider.js";
import { createLiveTaskReadProvider } from "./live_task_read_provider.js";
import { serializeTasksWithLinkedSessions } from "./live_task_serialization.js";

export type LiveDbCatalogRepository = {
  readonly folderRouteProvider: LiveFolderProvider;
  readonly folderCountsProvider: LiveFolderProvider;
  readonly boardAssetRouteProvider: BoardAssetRouteProvider;
  readonly boardItemRouteProvider: BoardItemRouteProvider;
  readonly markdownDocumentRouteProvider: MarkdownDocumentRouteProvider;
  readonly runbookRouteProvider: RunbookRouteProvider;
  readonly sessionCatalogProvider: SessionCatalogProvider;
  readonly sessionHistoryProvider: ReturnType<typeof createLiveSessionHistoryProvider>;
  readonly sessionResourceAccessRepository: SessionResourceAccessRepository;
  readonly taskReadProvider: TaskReadRouteProvider;
  readonly taskMutationProvider: TaskMutationRouteProvider;
  readonly createTaskChangeListener: (
    broadcaster: InMemorySseReplayBroadcaster<TaskStreamEvent>,
  ) => LiveTaskChangeListener;
  readonly loadSessionSnapshot: (
    input?: LoadSessionSnapshotInput,
  ) => Promise<SessionStreamSnapshot>;
  readonly loadTaskSnapshot: () => Promise<TaskStreamSnapshot>;
  readonly close: () => Promise<void>;
};

export type LoadSessionSnapshotInput = {
  readonly access?: BoardAccess;
  readonly feedOnly?: boolean;
};

export type CreateLiveDbCatalogRepositoryOptions = {
  readonly sql?: LivePostgresSql;
  readonly sqlResolver?: LiveDbSqlResolver;
  readonly postgresFactory?: LivePostgresFactory;
  readonly databaseUrl?: string;
  readonly configProvider?: LiveConfigProviderBoundary;
  readonly registry?: InMemoryNodeRegistry;
  readonly maxConnections?: number;
  readonly closeTimeoutSeconds?: number;
  readonly sessionSnapshotLimit?: number;
  readonly taskSnapshotLimit?: number;
  readonly boardAssetStorage?: LiveBoardAssetStorage | null;
};

const DEFAULT_SESSION_SNAPSHOT_LIMIT = 200;
const DEFAULT_TASK_SNAPSHOT_LIMIT = 1000;

export function createLiveDbCatalogRepository(
  options: CreateLiveDbCatalogRepositoryOptions = {},
): LiveDbCatalogRepository {
  const sqlResolver = options.sqlResolver ??
    createLiveDbSqlResolver({
      sql: options.sql,
      postgresFactory: options.postgresFactory,
      databaseUrl: options.databaseUrl,
      configProvider: options.configProvider,
      maxConnections: options.maxConnections,
      closeTimeoutSeconds: options.closeTimeoutSeconds,
    });
  const sessionHistoryProvider = createLiveSessionHistoryProvider({ sqlResolver });
  const folderProvider = createLiveFolderProvider(sqlResolver);
  const boardItemProvider = createLiveBoardItemRouteProvider(
    sqlResolver,
    folderProvider,
  );
  const boardAssetProvider = createLiveBoardAssetRouteProvider({
    sqlResolver,
    folderProvider,
    boardItemProvider,
    storage: options.boardAssetStorage,
    configProvider: options.configProvider,
  });
  const runbookProvider = createLiveRunbookRouteProvider({
    sqlResolver,
    folderProvider,
    registry: options.registry,
  });
  const sessionResourceAccessRepository =
    createSessionResourceAccessRepository(sqlResolver);
  const taskReadProvider = createLiveTaskReadProvider({
    sqlResolver,
    registry: options.registry,
  });
  const taskMutationProvider = createLiveTaskMutationProvider({
    sqlResolver,
    registry: options.registry,
  });
  const sessionSnapshotLimit =
    options.sessionSnapshotLimit ?? DEFAULT_SESSION_SNAPSHOT_LIMIT;
  const taskSnapshotLimit = options.taskSnapshotLimit ?? DEFAULT_TASK_SNAPSHOT_LIMIT;
  return {
    folderRouteProvider: folderProvider,
    folderCountsProvider: folderProvider,
    boardAssetRouteProvider: boardAssetProvider,
    boardItemRouteProvider: boardItemProvider,
    markdownDocumentRouteProvider: createLiveMarkdownDocumentRouteProvider(
      sqlResolver,
      folderProvider,
      boardItemProvider,
    ),
    runbookRouteProvider: runbookProvider,
    sessionCatalogProvider: createSessionCatalogProvider(sqlResolver),
    sessionHistoryProvider,
    sessionResourceAccessRepository,
    taskReadProvider,
    taskMutationProvider,
    createTaskChangeListener(broadcaster) {
      return createLiveTaskChangeListener({ sqlResolver, broadcaster });
    },
    async loadSessionSnapshot(input = {}) {
      const sql = await sqlResolver.resolveSql();
      const filters = await sessionSnapshotFilters(
        input,
        sessionResourceAccessRepository,
      );
      if (filters === null) return { sessions: [], total: 0 };
      const filtersJson = JSON.stringify(filters);
      const countRows = await sql`
        SELECT session_count(${filtersJson}::jsonb) AS count
      `;
      const sessionRows = await sql`
        SELECT * FROM session_get_all(${filtersJson}::jsonb, ${sessionSnapshotLimit}, ${null})
      `;
      return {
        sessions: sessionRows.map((row) =>
          serializeSessionRow(row, { registry: options.registry }),
        ),
        total: numberValue(countRows[0]?.count) ?? sessionRows.length,
      };
    },
    async loadTaskSnapshot() {
      const sql = await sqlResolver.resolveSql();
      const countRows = await sql`
        SELECT COUNT(*)::int
        FROM task_items
        WHERE archived = FALSE
      `;
      const taskRows = await sql`
        SELECT *
        FROM task_items
        WHERE archived = FALSE
        ORDER BY parent_id NULLS FIRST, position_key ASC, created_at ASC
        LIMIT ${taskSnapshotLimit}
      `;
      return {
        tasks: await serializeTasksWithLinkedSessions(sql, taskRows, {
          registry: options.registry,
        }),
        total: numberValue(countRows[0]?.count) ?? taskRows.length,
      };
    },
    async close() {
      await sqlResolver.close();
    },
  };
}

function createSessionResourceAccessRepository(
  sqlResolver: LiveDbSqlResolver,
): SessionResourceAccessRepository {
  return {
    async getSessionAccessRecord(sessionId) {
      const rows = await (await sqlResolver.resolveSql())`
        SELECT session_id, folder_id, session_type FROM session_get(${sessionId}) LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return null;
      return {
        sessionId: String(row.session_id ?? sessionId),
        folderId: stringOrNull(row.folder_id),
        sessionType: stringOrNull(row.session_type),
      };
    },
    async listFoldersForAccess() {
      const rows = await (await sqlResolver.resolveSql())`
        SELECT id, parent_folder_id, settings FROM folders
      `;
      return rows.flatMap(folderAccessRecord);
    },
  };
}

async function sessionSnapshotFilters(
  input: LoadSessionSnapshotInput,
  repository: SessionResourceAccessRepository,
): Promise<Record<string, unknown> | null> {
  const filters: Record<string, unknown> = {};
  if (input.feedOnly === true) filters.feed_only = true;
  if (input.access === undefined) return filters;

  const access = normalizeBoardAccess(input.access);
  if (!access.restricted) return filters;

  const folders = await repository.listFoldersForAccess();
  const folderId = firstAllowedSessionFolderId(access, folders);
  if (folderId === null) return null;
  filters.folder_id = folderId;
  return filters;
}

function createSessionCatalogProvider(
  sqlResolver: LiveDbSqlResolver,
): SessionCatalogProvider {
  return {
    async renameSession(sessionId, displayName) {
      const sql = await sqlResolver.resolveSql();
      await sql`
        SELECT session_rename(${sessionId}, ${displayName})
      `;
    },
    async moveSessionsToFolder(sessionIds, folderId) {
      const sql = await sqlResolver.resolveSql();
      for (const sessionId of sessionIds) {
        await sql`
          SELECT session_assign_folder(${sessionId}, ${folderId})
        `;
      }
      return { count: sessionIds.length };
    },
    async updateSessionCatalog(sessionId, update) {
      const sql = await sqlResolver.resolveSql();
      if (hasOwn(update, "folderId")) {
        await sql`
          SELECT session_assign_folder(${sessionId}, ${update.folderId ?? null})
        `;
      }
      if (hasOwn(update, "displayName")) {
        await sql`
          SELECT session_rename(${sessionId}, ${update.displayName ?? null})
        `;
      }
    },
    async deleteSession(sessionId) {
      const sql = await sqlResolver.resolveSql();
      await sql`
        SELECT session_delete(${sessionId})
      `;
    },
    async getSessionCards(sessionId) {
      const sql = await sqlResolver.resolveSql();
      const rows = await sql`
        SELECT * FROM event_read(${sessionId}, ${0}, ${null}, ${null})
      `;
      return [...rows];
    },
    async updateReadPosition(sessionId, lastReadEventId) {
      const sql = await sqlResolver.resolveSql();
      await sql`
        SELECT session_update_read_position(${sessionId}, ${lastReadEventId})
      `;
    },
  };
}

function folderAccessRecord(row: Record<string, unknown>): BoardAccessFolderRecord[] {
  const id = stringOrNull(row.id);
  if (id === null) return [];
  return [{
    id,
    parentFolderId: stringOrNull(row.parent_folder_id ?? row.parentFolderId),
    settings: row.settings,
  }];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
