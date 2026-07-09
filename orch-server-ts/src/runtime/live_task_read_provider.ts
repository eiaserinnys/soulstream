import type { InMemoryNodeRegistry } from "../node/registry.js";
import type {
  TaskReadContext,
  TaskReadListQuery,
  TaskReadRouteProvider,
} from "../tasks/task_read_routes.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import { serializeTasksWithLinkedSessions } from "./live_task_serialization.js";

export type CreateLiveTaskReadProviderOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
  readonly registry?: InMemoryNodeRegistry;
};

export function createLiveTaskReadProvider(
  options: CreateLiveTaskReadProviderOptions,
): TaskReadRouteProvider {
  return {
    async listTasks(query) {
      const sql = await options.sqlResolver.resolveSql();
      const taskRows = await listTaskRows(sql, query);
      return serializeTasksWithLinkedSessions(sql, taskRows, {
        registry: options.registry,
      });
    },
    async getTaskContext(sessionId) {
      return loadTaskContext(options, sessionId);
    },
  };
}

async function loadTaskContext(
  options: CreateLiveTaskReadProviderOptions,
  sessionId: string,
): Promise<TaskReadContext> {
  const sql = await options.sqlResolver.resolveSql();
  const activeRows = await sql`
    SELECT * FROM task_items
    WHERE active_for_session_id = ${sessionId}
      AND archived = FALSE
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  const active = activeRows[0];
  const pathRows =
    active === undefined ? [] : await loadTaskPathRows(sql, String(active.id));
  const linkedRows = await listTaskRows(sql, {
    linkedSessionId: sessionId,
    includeArchived: false,
    limit: 100,
  });
  const [activeTask, activeTaskPath, linkedTasks] = await Promise.all([
    active === undefined
      ? Promise.resolve(null)
      : serializeTasksWithLinkedSessions(sql, [active], { registry: options.registry })
        .then((tasks) => tasks[0] ?? null),
    serializeTasksWithLinkedSessions(sql, pathRows, { registry: options.registry }),
    serializeTasksWithLinkedSessions(sql, linkedRows, { registry: options.registry }),
  ]);
  return { activeTask, activeTaskPath, linkedTasks };
}

export async function listTaskRows(
  sql: Awaited<ReturnType<LiveDbSqlResolver["resolveSql"]>>,
  query: Partial<TaskReadListQuery>,
): Promise<readonly Record<string, unknown>[]> {
  const like = query.query?.trim() ? `%${query.query.trim()}%` : null;
  if (query.rootTaskId !== undefined) {
    return sql`
      WITH RECURSIVE subtree AS (
        SELECT * FROM task_items WHERE id = ${query.rootTaskId}
        UNION ALL
        SELECT child.*
        FROM task_items child
        JOIN subtree parent ON child.parent_id = parent.id
      )
      SELECT * FROM subtree
      WHERE (${query.includeArchived ?? false}::boolean OR archived = FALSE)
        AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
        AND (${query.linkedSessionId ?? null}::text IS NULL OR linked_session_id = ${query.linkedSessionId ?? null})
        AND (
          ${like}::text IS NULL
          OR title ILIKE ${like}
          OR description ILIKE ${like}
          OR acceptance_criteria ILIKE ${like}
        )
      ORDER BY parent_id NULLS FIRST, position_key ASC, created_at ASC
      LIMIT ${query.limit ?? 500}
    `;
  }
  return sql`
    SELECT * FROM task_items
    WHERE (${query.includeArchived ?? false}::boolean OR archived = FALSE)
      AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      AND (${query.linkedSessionId ?? null}::text IS NULL OR linked_session_id = ${query.linkedSessionId ?? null})
      AND (
        ${like}::text IS NULL
        OR title ILIKE ${like}
        OR description ILIKE ${like}
        OR acceptance_criteria ILIKE ${like}
      )
    ORDER BY parent_id NULLS FIRST, position_key ASC, created_at ASC
    LIMIT ${query.limit ?? 500}
  `;
}

async function loadTaskPathRows(
  sql: Awaited<ReturnType<LiveDbSqlResolver["resolveSql"]>>,
  taskId: string,
): Promise<readonly Record<string, unknown>[]> {
  return sql`
    WITH RECURSIVE ancestors AS (
      SELECT *, 0 AS depth FROM task_items WHERE id = ${taskId}
      UNION ALL
      SELECT parent.*, child.depth + 1
      FROM task_items parent
      JOIN ancestors child ON child.parent_id = parent.id
    )
    SELECT id, parent_id, position_key, title, description,
           acceptance_criteria, verification_owner, status,
           linked_session_id, linked_node_id, active_for_session_id,
           created_from_session_id, created_from_event_id,
           navigation_session_id, navigation_node_id, navigation_event_id,
           archived, pinned, version, created_at, updated_at
    FROM ancestors
    ORDER BY depth DESC
  `;
}
