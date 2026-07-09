import type {
  RunbookMutationHttpClient,
  RunbookMutationNode,
  RunbookOverview,
  RunbookRouteProvider,
  RunbookRouteOptions,
} from "../runbooks/runbook_route_types.js";
import { RunbookRouteError } from "../runbooks/runbook_route_types.js";
import type {
  InMemoryNodeRegistry,
  NodeConnectionSnapshot,
} from "../node/registry.js";
import type { LiveDbSqlResolver } from "./live_db_sql.js";
import type { LiveFolderProvider } from "./live_folder_route_provider.js";
import type { LiveNodeHttpClientBoundary } from "./live_provider_dependencies.js";

export type LiveRunbookNodeHttpClient = Pick<
  LiveNodeHttpClientBoundary,
  "requestNode"
>;

export type CreateLiveRunbookRouteProviderOptions = {
  readonly nodeHttpClient: LiveRunbookNodeHttpClient;
};

export type CreateLiveRunbookRouteProvidersOptions =
  CreateLiveRunbookRouteProviderOptions & {
    readonly provider: RunbookRouteProvider;
  };

export type CreateLiveRunbookDbRouteProviderOptions = {
  readonly sqlResolver: LiveDbSqlResolver;
  readonly folderProvider: LiveFolderProvider;
  readonly registry?: InMemoryNodeRegistry;
};

export type LiveRunbookRouteProviderBundle = {
  readonly runbookRoutes: Pick<RunbookRouteOptions, "httpClient" | "provider">;
};

export function createLiveRunbookRouteProviders(
  options: CreateLiveRunbookRouteProvidersOptions,
): LiveRunbookRouteProviderBundle {
  return {
    runbookRoutes: {
      provider: options.provider,
      httpClient: createLiveRunbookMutationHttpClient(options),
    },
  };
}

export function createLiveRunbookRouteProvider(
  options: CreateLiveRunbookDbRouteProviderOptions,
): RunbookRouteProvider {
  return {
    listFolders: () => options.folderProvider.listFolders(),
    async getRunbookOverview(input) {
      const sql = await options.sqlResolver.resolveSql();
      const userId = input.userId;
      const safeLimit = safeOverviewLimit(input.limit);
      const myTurnRows = await sql`
        SELECT
            r.id AS runbook_id,
            r.title AS runbook_title,
            r.status AS runbook_status,
            r.board_item_id,
            bi.folder_id,
            r.completed_kind AS runbook_completed_kind,
            r.completed_session_id AS runbook_completed_session_id,
            r.completed_event_id AS runbook_completed_event_id,
            r.completed_user_id AS runbook_completed_user_id,
            r.completed_at AS runbook_completed_at,
            s.id AS section_id,
            s.title AS section_title,
            i.id AS item_id,
            i.title AS item_title,
            i.how_to,
            i.status,
            i.version AS item_version,
            r.created_session_id AS runbook_created_session_id,
            s.created_session_id AS section_created_session_id,
            s.updated_session_id AS section_updated_session_id,
            i.created_session_id AS item_created_session_id,
            i.updated_session_id AS item_updated_session_id,
            COALESCE(i.assignee_kind, s.assignee_kind) AS effective_assignee_kind,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_agent_id ELSE i.assignee_agent_id END AS effective_assignee_agent_id,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_session_id ELSE i.assignee_session_id END AS effective_assignee_session_id,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END AS effective_assignee_user_id
        FROM runbook_items i
        JOIN runbook_sections s ON s.id = i.section_id
        JOIN runbooks r ON r.id = s.runbook_id
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
            r.id AS runbook_id,
            r.title AS runbook_title,
            r.version AS runbook_version,
            r.status AS runbook_status,
            r.board_item_id,
            bi.folder_id,
            r.completed_kind AS runbook_completed_kind,
            r.completed_session_id AS runbook_completed_session_id,
            r.completed_event_id AS runbook_completed_event_id,
            r.completed_user_id AS runbook_completed_user_id,
            r.completed_at AS runbook_completed_at,
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
        FROM runbooks r
        JOIN board_items bi ON bi.id = r.board_item_id
        JOIN runbook_sections s ON s.runbook_id = r.id
        JOIN runbook_items i ON i.section_id = s.id
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
            r.id AS runbook_id,
            r.title AS runbook_title,
            r.status AS runbook_status,
            r.board_item_id,
            bi.folder_id,
            r.completed_kind AS runbook_completed_kind,
            r.completed_session_id AS runbook_completed_session_id,
            r.completed_event_id AS runbook_completed_event_id,
            r.completed_user_id AS runbook_completed_user_id,
            r.completed_at AS runbook_completed_at,
            s.id AS section_id,
            s.title AS section_title,
            i.id AS item_id,
            i.title AS item_title,
            i.how_to,
            i.status,
            i.version AS item_version,
            r.created_session_id AS runbook_created_session_id,
            s.created_session_id AS section_created_session_id,
            s.updated_session_id AS section_updated_session_id,
            i.created_session_id AS item_created_session_id,
            i.updated_session_id AS item_updated_session_id,
            COALESCE(i.assignee_kind, s.assignee_kind) AS effective_assignee_kind,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_agent_id ELSE i.assignee_agent_id END AS effective_assignee_agent_id,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_session_id ELSE i.assignee_session_id END AS effective_assignee_session_id,
            CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END AS effective_assignee_user_id
        FROM runbooks r
        JOIN board_items bi ON bi.id = r.board_item_id
        JOIN runbook_sections s ON s.runbook_id = r.id
        JOIN runbook_items i ON i.section_id = s.id
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
      return runbookOverview(myTurnRows, groupRows, itemRows);
    },
    async getRunbookSnapshot(runbookId) {
      const sql = await options.sqlResolver.resolveSql();
      const runbookRows = await sql`
        SELECT r.*, bi.folder_id
        FROM runbooks r
        JOIN board_items bi ON bi.id = r.board_item_id
        WHERE r.id = ${runbookId}
      `;
      const runbook = runbookRows[0];
      if (runbook === undefined) return null;
      const sections = await sql`
        SELECT *
        FROM runbook_sections
        WHERE runbook_id = ${runbookId}
        ORDER BY position_key ASC, created_at ASC
      `;
      const items = await sql`
        SELECT i.*
        FROM runbook_items i
        JOIN runbook_sections s ON s.id = i.section_id
        WHERE s.runbook_id = ${runbookId}
        ORDER BY s.position_key ASC, i.position_key ASC, i.created_at ASC
      `;
      return {
        runbook: normalizeRunbookRow(runbook),
        sections: sections.map(normalizeRunbookRow),
        items: items.map(normalizeRunbookRow),
      };
    },
    async findSessionNode(actorSessionId) {
      const sql = await options.sqlResolver.resolveSql();
      const rows = await sql`
        SELECT session_id, node_id FROM session_get(${actorSessionId}) LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new RunbookRouteError(
          "SESSION_NOT_FOUND",
          "Session not found",
          404,
        );
      }
      const ownerNodeId = stringOrNull(row.node_id);
      if (ownerNodeId !== null) {
        const node = options.registry?.getConnectedNode(ownerNodeId);
        if (node === undefined) {
          throw new RunbookRouteError(
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
}

export function createLiveRunbookMutationHttpClient(
  options: CreateLiveRunbookRouteProviderOptions,
): RunbookMutationHttpClient {
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

function runbookOverview(
  myTurnRows: readonly Record<string, unknown>[],
  groupRows: readonly Record<string, unknown>[],
  itemRows: readonly Record<string, unknown>[],
): RunbookOverview {
  const itemsByRunbook = new Map<string, Record<string, unknown>[]>();
  for (const row of itemRows) {
    const item = normalizeRunbookOverviewItem(row);
    const runbookId = stringOrNull(item.runbook_id);
    if (runbookId === null) continue;
    const items = itemsByRunbook.get(runbookId) ?? [];
    items.push(item);
    itemsByRunbook.set(runbookId, items);
  }
  return {
    my_turn_items: myTurnRows.map(normalizeRunbookOverviewItem),
    runbooks: groupRows.map((row) =>
      normalizeRunbookOverviewGroup(
        row,
        itemsByRunbook.get(String(row.runbook_id ?? "")) ?? [],
      ),
    ),
  };
}

function normalizeRunbookOverviewItem(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const result = normalizeRunbookRow(row);
  if ("item_version" in result) {
    result.item_version = numberValue(result.item_version) ?? 0;
  }
  return result;
}

function normalizeRunbookOverviewGroup(
  row: Record<string, unknown>,
  items: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const result = normalizeRunbookRow(row);
  if ("runbook_version" in result) {
    result.runbook_version = numberValue(result.runbook_version) ?? 0;
  }
  result.completed_count = numberValue(result.completed_count) ?? 0;
  result.total_count = numberValue(result.total_count) ?? 0;
  result.items = items;
  return result;
}

function normalizeRunbookRow(row: Record<string, unknown>): Record<string, unknown> {
  const result = { ...row };
  for (const key of ["created_at", "updated_at", "completed_at"]) {
    const value = result[key];
    if (value instanceof Date) result[key] = value.toISOString();
  }
  return result;
}

function mutationNode(node: NodeConnectionSnapshot): RunbookMutationNode {
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
