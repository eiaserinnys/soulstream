import type {
  TaskMutationHttpClient,
  TaskMutationNode,
  TaskOverview,
  TaskRouteProvider,
  TaskRouteOptions,
} from "../tasks/task_route_types.js";
import { TaskRouteError } from "../tasks/task_route_types.js";
import type {
  InMemoryNodeRegistry,
  NodeConnectionSnapshot,
} from "../node/registry.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";
import type { LiveNodeHttpClientBoundary } from "./live_provider_dependencies.js";
import {
  createTaskUserStatusMutation,
} from "../tasks/task_user_status_mutation.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";

export type LiveTaskNodeHttpClient = Pick<
  LiveNodeHttpClientBoundary,
  "requestNode"
>;

export type CreateLiveTaskRouteProviderOptions = {
  readonly nodeHttpClient: LiveTaskNodeHttpClient;
};

export type CreateLiveTaskRouteProvidersOptions =
  CreateLiveTaskRouteProviderOptions & {
    readonly provider: TaskRouteProvider;
    readonly broadcaster?: InMemorySseReplayBroadcaster<SessionStreamEvent>;
  };

export type CreateLiveTaskDbRouteProviderOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
  readonly folderProvider: LiveFolderProvider;
  readonly registry?: InMemoryNodeRegistry;
};

export type LiveTaskRouteProviderBundle = {
  readonly taskRoutes: Pick<TaskRouteOptions, "httpClient" | "provider">;
};

export function createLiveTaskRouteProviders(
  options: CreateLiveTaskRouteProvidersOptions,
): LiveTaskRouteProviderBundle {
  const provider = options.broadcaster === undefined
    ? options.provider
    : withTaskMutationBroadcasts(options.provider, options.broadcaster);
  return {
    taskRoutes: {
      provider,
      httpClient: createLiveTaskMutationHttpClient(options),
    },
  };
}

export function createLiveTaskRouteProvider(
  options: CreateLiveTaskDbRouteProviderOptions,
): TaskRouteProvider {
  const provider: TaskRouteProvider = {
    listFolders: () => options.folderProvider.listFolders(),
    async getTaskOverview(input) {
      const sql = await options.sqlResolver.resolveSql();
      const userId = input.userId;
      const safeLimit = safeOverviewLimit(input.limit);
      const myTurnRows = await sql`
        SELECT
            r.id AS task_id,
            r.title AS task_title,
            r.status AS task_status,
            r.board_item_id,
            bi.folder_id,
            r.completed_kind AS task_completed_kind,
            r.completed_session_id AS task_completed_session_id,
            r.completed_event_id AS task_completed_event_id,
            r.completed_user_id AS task_completed_user_id,
            r.completed_at AS task_completed_at,
            s.id AS section_id,
            s.title AS section_title,
            i.id AS item_id,
            i.title AS item_title,
            i.how_to,
            i.status,
            i.version AS item_version,
            r.created_session_id AS task_created_session_id,
            s.created_session_id AS section_created_session_id,
            s.updated_session_id AS section_updated_session_id,
            i.created_session_id AS item_created_session_id,
            i.updated_session_id AS item_updated_session_id,
            COALESCE(i.assignee_kind, s.assignee_kind) AS effective_assignee_kind,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_agent_id ELSE i.assignee_agent_id END AS effective_assignee_agent_id,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_session_id ELSE i.assignee_session_id END AS effective_assignee_session_id,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END AS effective_assignee_user_id
        FROM task_items i
        JOIN task_sections s ON s.id = i.section_id
        JOIN tasks r ON r.id = s.task_id
        JOIN board_items bi ON bi.id = r.board_item_id
        WHERE r.archived = FALSE
          AND r.status <> 'completed'
          AND s.archived = FALSE
          AND i.archived = FALSE
          AND (
            i.status = 'review'
            OR (
              i.status NOT IN ('completed', 'cancelled')
              AND COALESCE(i.assignee_kind, s.assignee_kind) = 'human'
              AND (
                ${userId}::text IS NULL
                OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) IS NULL
                OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) = ${userId}
              )
            )
          )
        ORDER BY
            CASE
              WHEN i.status = 'review' THEN 0
              WHEN i.status = 'in_progress' THEN 1
              ELSE 2
            END,
            r.updated_at DESC,
            s.position_key ASC,
            i.position_key ASC
        LIMIT ${safeLimit}
      `;
      const groupRows = await sql`
        SELECT
            r.id AS task_id,
            r.title AS task_title,
            r.version AS task_version,
            r.status AS task_status,
            r.board_item_id,
            bi.folder_id,
            r.completed_kind AS task_completed_kind,
            r.completed_session_id AS task_completed_session_id,
            r.completed_event_id AS task_completed_event_id,
            r.completed_user_id AS task_completed_user_id,
            r.completed_at AS task_completed_at,
            r.updated_at,
            COUNT(*) FILTER (WHERE i.status = 'completed') AS completed_count,
            COUNT(*) AS total_count,
            COUNT(*) FILTER (
                WHERE r.status <> 'completed'
                  AND (
                    i.status = 'review'
                    OR (
                      i.status <> 'completed'
                      AND COALESCE(i.assignee_kind, s.assignee_kind) = 'human'
                      AND (
                        ${userId}::text IS NULL
                        OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) IS NULL
                        OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) = ${userId}
                      )
                    )
                  )
            ) AS my_turn_count,
            COUNT(*) FILTER (WHERE i.status = 'in_progress') AS in_progress_count
        FROM tasks r
        JOIN board_items bi ON bi.id = r.board_item_id
        JOIN task_sections s ON s.task_id = r.id
        JOIN task_items i ON i.section_id = s.id
        WHERE r.archived = FALSE
          AND s.archived = FALSE
          AND i.archived = FALSE
          AND i.status <> 'cancelled'
        GROUP BY
            r.id,
            r.title,
            r.version,
            r.status,
            r.board_item_id,
            bi.folder_id,
            r.completed_kind,
            r.completed_session_id,
            r.completed_event_id,
            r.completed_user_id,
            r.completed_at,
            r.updated_at
        ORDER BY my_turn_count DESC, in_progress_count DESC, r.updated_at DESC
      `;
      const itemRows = await sql`
        SELECT
            r.id AS task_id,
            r.title AS task_title,
            r.status AS task_status,
            r.board_item_id,
            bi.folder_id,
            r.completed_kind AS task_completed_kind,
            r.completed_session_id AS task_completed_session_id,
            r.completed_event_id AS task_completed_event_id,
            r.completed_user_id AS task_completed_user_id,
            r.completed_at AS task_completed_at,
            s.id AS section_id,
            s.title AS section_title,
            i.id AS item_id,
            i.title AS item_title,
            i.how_to,
            i.status,
            i.version AS item_version,
            r.created_session_id AS task_created_session_id,
            s.created_session_id AS section_created_session_id,
            s.updated_session_id AS section_updated_session_id,
            i.created_session_id AS item_created_session_id,
            i.updated_session_id AS item_updated_session_id,
            COALESCE(i.assignee_kind, s.assignee_kind) AS effective_assignee_kind,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_agent_id ELSE i.assignee_agent_id END AS effective_assignee_agent_id,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_session_id ELSE i.assignee_session_id END AS effective_assignee_session_id,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END AS effective_assignee_user_id
        FROM tasks r
        JOIN board_items bi ON bi.id = r.board_item_id
        JOIN task_sections s ON s.task_id = r.id
        JOIN task_items i ON i.section_id = s.id
        WHERE r.archived = FALSE
          AND s.archived = FALSE
          AND i.archived = FALSE
          AND i.status <> 'cancelled'
        ORDER BY
            r.updated_at DESC,
            CASE i.status
                WHEN 'review' THEN 0
                WHEN 'in_progress' THEN 1
                WHEN 'pending' THEN 2
                WHEN 'completed' THEN 3
                ELSE 4
            END,
            s.position_key ASC,
            i.position_key ASC
      `;
      return taskOverview(myTurnRows, groupRows, itemRows);
    },
    async getTaskSnapshot(taskId) {
      const sql = await options.sqlResolver.resolveSql();
      const taskRows = await sql`
        SELECT r.*, bi.folder_id
        FROM tasks r
        JOIN board_items bi ON bi.id = r.board_item_id
        WHERE r.id = ${taskId}
      `;
      const task = taskRows[0];
      if (task === undefined) return null;
      const sections = await sql`
        SELECT *
        FROM task_sections
        WHERE task_id = ${taskId}
        ORDER BY position_key ASC, created_at ASC
      `;
      const items = await sql`
        SELECT i.*
        FROM task_items i
        JOIN task_sections s ON s.id = i.section_id
        WHERE s.task_id = ${taskId}
        ORDER BY s.position_key ASC, i.position_key ASC, i.created_at ASC
      `;
      return {
        task: normalizeTaskRow(task),
        sections: sections.map(normalizeTaskRow),
        items: items.map(normalizeTaskRow),
      };
    },
    async findSessionNode(actorSessionId) {
      const sql = await options.sqlResolver.resolveSql();
      const rows = await sql`
        SELECT session_id, node_id FROM session_get(${actorSessionId}) LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new TaskRouteError(
          "SESSION_NOT_FOUND",
          "Session not found",
          404,
        );
      }
      const ownerNodeId = stringOrNull(row.node_id);
      if (ownerNodeId !== null) {
        const node = options.registry?.getConnectedNode(ownerNodeId);
        if (node === undefined) {
          throw new TaskRouteError(
            "SESSION_OWNER_NODE_UNAVAILABLE",
            `Session owner node unavailable: ${ownerNodeId}`,
            503,
          );
        }
        return mutationNode(node);
      }
      return options.registry?.listConnectedNodes().map(mutationNode)[0] ?? null;
    },
    listConnectedNodes() {
      return options.registry?.listConnectedNodes().map(mutationNode) ?? [];
    },
  };
  provider.setTaskStatusAsUser = createTaskUserStatusMutation({
    sqlResolver: options.sqlResolver,
    async loadSnapshot(taskId) {
      return await provider.getTaskSnapshot?.(taskId);
    },
  });
  return provider;
}

function withTaskMutationBroadcasts(
  provider: TaskRouteProvider,
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>,
): TaskRouteProvider {
  const setTaskStatusAsUser = provider.setTaskStatusAsUser;
  if (setTaskStatusAsUser === undefined) return provider;
  return {
    ...provider,
    async setTaskStatusAsUser(input) {
      const result = await setTaskStatusAsUser(input);
      if (!result.idempotent) {
        broadcaster.append({
          type: "task_updated",
          taskId: result.taskId,
          boardItemId: result.boardItemId,
        });
      }
      return result;
    },
  };
}

export function createLiveTaskMutationHttpClient(
  options: CreateLiveTaskRouteProviderOptions,
): TaskMutationHttpClient {
  return async (request) => {
    const response = await options.nodeHttpClient.requestNode({
      nodeId: request.target.nodeId,
      method: request.method,
      path: request.upstreamPath,
      headers: request.headers,
      body: request.body,
    });
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
    };
  };
}

function taskOverview(
  myTurnRows: readonly Record<string, unknown>[],
  groupRows: readonly Record<string, unknown>[],
  itemRows: readonly Record<string, unknown>[],
): TaskOverview {
  const itemsByTask = new Map<string, Record<string, unknown>[]>();
  for (const row of itemRows) {
    const item = normalizeTaskOverviewItem(row);
    const taskId = stringOrNull(item.task_id);
    if (taskId === null) continue;
    const items = itemsByTask.get(taskId) ?? [];
    items.push(item);
    itemsByTask.set(taskId, items);
  }
  return {
    my_turn_items: myTurnRows.map(normalizeTaskOverviewItem),
    tasks: groupRows.map((row) =>
      normalizeTaskOverviewGroup(
        row,
        itemsByTask.get(String(row.task_id ?? "")) ?? [],
      ),
    ),
  };
}

function normalizeTaskOverviewItem(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const result = normalizeTaskRow(row);
  if ("item_version" in result) {
    result.item_version = numberValue(result.item_version) ?? 0;
  }
  return result;
}

function normalizeTaskOverviewGroup(
  row: Record<string, unknown>,
  items: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const result = normalizeTaskRow(row);
  if ("task_version" in result) {
    result.task_version = numberValue(result.task_version) ?? 0;
  }
  result.completed_count = numberValue(result.completed_count) ?? 0;
  result.total_count = numberValue(result.total_count) ?? 0;
  result.items = items;
  return result;
}

function normalizeTaskRow(row: Record<string, unknown>): Record<string, unknown> {
  const result = { ...row };
  for (const key of ["created_at", "updated_at", "completed_at"]) {
    const value = result[key];
    if (value instanceof Date) result[key] = value.toISOString();
  }
  return result;
}

function mutationNode(node: NodeConnectionSnapshot): TaskMutationNode {
  return {
    nodeId: node.nodeId,
    host: node.host,
    port: node.port,
  };
}

function safeOverviewLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), 500);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
