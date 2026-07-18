import type { InMemoryNodeRegistry } from "../node/registry.js";
import {
  projectSessionBindingWarnings,
  type SessionBindingWarning,
} from "@soulstream/page-model";
import {
  isBoardFolderAllowed,
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
import {
  buildSessionSnapshotListResponse,
  type SessionSnapshotListResponse,
} from "../session/session_snapshot_service.js";
import type { SessionStreamSnapshot } from "../sse/sse_replay_routes.js";
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
import { createLiveTaskRouteProvider } from "./live_task_route_provider.js";
import type { TaskRouteProvider } from "../tasks/task_route_types.js";
import { createLiveSessionHistoryProvider } from "./live_session_history_provider.js";
import { serializeSessionRow } from "./live_session_serialization.js";
import { createLiveUserPreferencesRepository } from "./live_user_preferences_repository.js";
import type { UserBackgroundRepository } from "../user/user_background_routes.js";
import {
  createLiveAdminUsersRepository,
  type LiveAdminUsersRepository,
} from "./live_admin_users_route_provider.js";
import { createLiveSessionReviewRepository } from "./live_session_review_repository.js";
import type { SessionReviewAcknowledgeRepository } from "../session/session_review_acknowledge_fallback.js";

export type LiveDbCatalogRepository = {
  readonly adminUsersRepository: LiveAdminUsersRepository;
  readonly folderRouteProvider: LiveFolderProvider;
  readonly folderCountsProvider: LiveFolderProvider;
  readonly boardAssetRouteProvider: BoardAssetRouteProvider;
  readonly boardItemRouteProvider: BoardItemRouteProvider;
  readonly markdownDocumentRouteProvider: MarkdownDocumentRouteProvider;
  readonly taskRouteProvider: TaskRouteProvider;
  readonly sessionCatalogProvider: SessionCatalogProvider;
  readonly sessionHistoryProvider: ReturnType<typeof createLiveSessionHistoryProvider>;
  readonly sessionResourceAccessRepository: SessionResourceAccessRepository;
  readonly sessionReviewRepository: SessionReviewAcknowledgeRepository;
  readonly userPreferencesRepository: UserBackgroundRepository;
  readonly loadSessionSnapshot: (
    input?: LoadSessionSnapshotInput,
  ) => Promise<SessionStreamSnapshot>;
  readonly listSessionSnapshots: (
    input: ListSessionSnapshotsInput,
  ) => Promise<SessionSnapshotListResponse>;
  readonly close: () => Promise<void>;
};

export type LoadSessionSnapshotInput = {
  readonly access?: BoardAccess;
  readonly feedOnly?: boolean;
};

export type ListSessionSnapshotsInput = LoadSessionSnapshotInput & {
  readonly sessionIds?: readonly string[];
  readonly folderId?: string;
  readonly sessionType?: string;
  readonly offset: number;
  readonly limit: number;
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
  readonly boardAssetStorage?: LiveBoardAssetStorage | null;
};

const DEFAULT_SESSION_SNAPSHOT_LIMIT = 200;

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
  const adminUsersRepository = createLiveAdminUsersRepository({ sqlResolver });
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
  const taskProvider = createLiveTaskRouteProvider({
    sqlResolver,
    folderProvider,
    registry: options.registry,
  });
  const sessionResourceAccessRepository =
    createSessionResourceAccessRepository(sqlResolver);
  const sessionReviewRepository = createLiveSessionReviewRepository({
    sqlResolver,
    registry: options.registry,
  });
  const sessionSnapshotLimit =
    options.sessionSnapshotLimit ?? DEFAULT_SESSION_SNAPSHOT_LIMIT;
  async function loadSessionPage(
    input: LoadSessionSnapshotInput & {
      readonly sessionIds?: readonly string[];
      readonly folderId?: string;
      readonly sessionType?: string;
    },
    limit: number | null,
    offset: number | null,
  ): Promise<{ sessions: Record<string, unknown>[]; total: number }> {
    const sql = await sqlResolver.resolveSql();
    if (input.sessionIds !== undefined) {
      const sessionIds = [...new Set(input.sessionIds)];
      if (sessionIds.length === 0) return { sessions: [], total: 0 };
      const folderId = input.folderId ?? null;
      const sessionType = input.sessionType ?? null;
      const feedOnly = input.feedOnly === true;
      const targetedRows = await sql`
        SELECT s.*
        FROM sessions s
        LEFT JOIN folders f ON s.folder_id = f.id
        WHERE s.session_id = ANY(${sessionIds}::text[])
          AND (${folderId}::text IS NULL OR s.folder_id = ${folderId})
          AND (${sessionType}::text IS NULL OR s.session_type = ${sessionType})
          AND (
            ${feedOnly}::boolean = FALSE
            OR (
              (s.folder_id IS NULL OR COALESCE(f.settings->>'excludeFromFeed', 'false') != 'true')
              AND COALESCE(s.session_type, 'claude') != 'llm'
            )
          )
        ORDER BY s.updated_at DESC, s.session_id DESC
      `;
      const access = normalizeBoardAccess(input.access ?? { restricted: false });
      const folders = access.restricted
        ? await sessionResourceAccessRepository.listFoldersForAccess()
        : [];
      const accessibleRows = access.restricted
        ? targetedRows.filter((row) =>
            isBoardFolderAllowed(access, folders, stringOrNull(row.folder_id))
          )
        : targetedRows;
      const start = offset ?? 0;
      const sessionRows = accessibleRows.slice(
        start,
        limit === null ? undefined : start + limit,
      );
      const bindingWarnings = await loadSessionBindingWarnings(sql, sessionRows);
      return {
        sessions: sessionRows.map((row) =>
          serializeSessionRow({
            ...row,
            binding_warnings: bindingWarnings.get(String(row.session_id ?? "")) ?? [],
          }, { registry: options.registry }),
        ),
        total: accessibleRows.length,
      };
    }
    const filters = await sessionSnapshotFilters(
      input,
      sessionResourceAccessRepository,
    );
    if (filters === null) return { sessions: [], total: 0 };
    const filtersJson = sql.json(filters);
    const countRows = await sql`
      SELECT session_count(${filtersJson}::jsonb) AS count
    `;
    const sessionRows = await sql`
      SELECT * FROM session_get_all(${filtersJson}::jsonb, ${limit}, ${offset})
    `;
    const bindingWarnings = await loadSessionBindingWarnings(sql, sessionRows);
    return {
      sessions: sessionRows.map((row) =>
        serializeSessionRow({
          ...row,
          binding_warnings: bindingWarnings.get(String(row.session_id ?? "")) ?? [],
        }, { registry: options.registry }),
      ),
      total: numberValue(countRows[0]?.count) ?? sessionRows.length,
    };
  }
  return {
    adminUsersRepository,
    folderRouteProvider: folderProvider,
    folderCountsProvider: folderProvider,
    boardAssetRouteProvider: boardAssetProvider,
    boardItemRouteProvider: boardItemProvider,
    markdownDocumentRouteProvider: createLiveMarkdownDocumentRouteProvider(
      sqlResolver,
      folderProvider,
      boardItemProvider,
    ),
    taskRouteProvider: taskProvider,
    sessionCatalogProvider: createSessionCatalogProvider(sqlResolver),
    sessionHistoryProvider,
    sessionResourceAccessRepository,
    sessionReviewRepository,
    userPreferencesRepository: createLiveUserPreferencesRepository({ sqlResolver }),
    async loadSessionSnapshot(input = {}) {
      return loadSessionPage(input, sessionSnapshotLimit, null);
    },
    async listSessionSnapshots(input) {
      const page = await loadSessionPage(
        input,
        input.limit > 0 ? input.limit : null,
        input.offset > 0 ? input.offset : null,
      );
      return buildSessionSnapshotListResponse(
        page.sessions,
        page.total,
        input.offset,
        input.limit,
      );
    },
    async close() {
      await sqlResolver.close();
    },
  };
}

async function loadSessionBindingWarnings(
  sql: LivePostgresSql,
  sessionRows: readonly Record<string, unknown>[],
): Promise<Map<string, SessionBindingWarning[]>> {
  const sessionIds = sessionRows.flatMap((row) =>
    typeof row.session_id === "string" && row.session_id.length > 0
      ? [row.session_id]
      : [],
  );
  if (sessionIds.length === 0) return new Map();
  const rows = await sql`
    SELECT session_id, page_state, legacy_state
    FROM session_page_bindings
    WHERE session_id = ANY(${sessionIds}::text[])
  `;
  return new Map(rows.flatMap((row) => {
    if (typeof row.session_id !== "string") return [];
    return [[row.session_id, projectSessionBindingWarnings({
      pageState: row.page_state as "pending" | "bound" | "manual_repair" | null,
      legacyState: row.legacy_state as "pending" | "completed" | "manual_repair" | null,
    })]];
  }));
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
  input: LoadSessionSnapshotInput & {
    readonly sessionIds?: readonly string[];
    readonly folderId?: string;
    readonly sessionType?: string;
  },
  repository: SessionResourceAccessRepository,
): Promise<Record<string, unknown> | null> {
  const filters: Record<string, unknown> = {};
  if (input.feedOnly === true) filters.feed_only = true;
  if (input.folderId !== undefined) filters.folder_id = input.folderId;
  if (input.sessionType !== undefined) filters.session_type = input.sessionType;
  if (input.access === undefined || input.folderId !== undefined) return filters;

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
