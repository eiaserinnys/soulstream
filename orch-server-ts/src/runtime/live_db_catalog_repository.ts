import type { InMemoryNodeRegistry } from "../node/registry.js";
import type {
  SessionCatalogProvider,
  SessionCatalogUpdateInput,
} from "../session/session_catalog_routes.js";
import type {
  SessionStreamSnapshot,
  TaskStreamSnapshot,
} from "../sse/sse_replay_routes.js";
import type { LiveConfigProviderBoundary } from "./live_provider_dependencies.js";
import {
  createLiveDbSqlResolver,
  type LiveDbSqlResolver,
  type LivePostgresFactory,
  type LivePostgresSql,
} from "./live_db_sql.js";
import { createLiveSessionHistoryProvider } from "./live_session_history_provider.js";
import {
  serializeSessionRow,
  serializeTaskRow,
} from "./live_session_serialization.js";

export type LiveDbCatalogRepository = {
  readonly sessionCatalogProvider: SessionCatalogProvider;
  readonly sessionHistoryProvider: ReturnType<typeof createLiveSessionHistoryProvider>;
  readonly loadSessionSnapshot: () => Promise<SessionStreamSnapshot>;
  readonly loadTaskSnapshot: () => Promise<TaskStreamSnapshot>;
  readonly close: () => Promise<void>;
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
  const sessionSnapshotLimit =
    options.sessionSnapshotLimit ?? DEFAULT_SESSION_SNAPSHOT_LIMIT;
  const taskSnapshotLimit = options.taskSnapshotLimit ?? DEFAULT_TASK_SNAPSHOT_LIMIT;

  return {
    sessionCatalogProvider: createSessionCatalogProvider(sqlResolver),
    sessionHistoryProvider,
    async loadSessionSnapshot() {
      const sql = await sqlResolver.resolveSql();
      const filtersJson = JSON.stringify({});
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
      const linkedSessions = await linkedSessionsById(sql, taskRows);
      return {
        tasks: taskRows.map((row) =>
          serializeTaskRow(
            row,
            linkedSessions.get(String(row.linked_session_id)),
            { registry: options.registry },
          ),
        ),
        total: numberValue(countRows[0]?.count) ?? taskRows.length,
      };
    },
    close: sqlResolver.close,
  };
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

async function linkedSessionsById(
  sql: LivePostgresSql,
  taskRows: readonly Record<string, unknown>[],
): Promise<Map<string, Record<string, unknown>>> {
  const ids = [...new Set(taskRows.flatMap(linkedSessionId))].sort();
  if (ids.length === 0) return new Map();
  const rows = await sql`
    SELECT * FROM sessions WHERE session_id = ANY(${ids}::text[])
  `;
  return new Map(rows.map((row) => [String(row.session_id), row]));
}

function linkedSessionId(row: Record<string, unknown>): string[] {
  return typeof row.linked_session_id === "string" && row.linked_session_id
    ? [row.linked_session_id]
    : [];
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasOwn(
  object: SessionCatalogUpdateInput,
  key: keyof SessionCatalogUpdateInput,
): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}
