import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { BoardYjsSqlResolver } from "./board_yjs_sql.js";
import type {
  BoardItemDbRow,
  ContainerItemDbRow,
  MarkdownDbRow,
} from "./board_projection_serialization.js";
import {
  toCatalogBoardItemRow,
  toContainerItemRecord,
  toMarkdownDocumentRow,
} from "./board_projection_serialization.js";
import type {
  ListContainerItemsParams,
  ListContainerItemsResult,
} from "./board_projection_types.js";
import type {
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "./board_yjs_types.js";

export class BoardProjectionReadRepository {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async getBoardItems(): Promise<CatalogBoardItemRow[]> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly BoardItemDbRow[]>`SELECT * FROM board_item_get_all()`;
    return rows.map(toCatalogBoardItemRow);
  }

  async getBoardItemById(boardItemId: string): Promise<CatalogBoardItemRow | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly BoardItemDbRow[]>`
      SELECT * FROM board_items WHERE id = ${boardItemId} LIMIT 1
    `;
    return rows[0] ? toCatalogBoardItemRow(rows[0]) : null;
  }

  async getPrimarySessionBoardItem(sessionId: string): Promise<CatalogBoardItemRow | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly BoardItemDbRow[]>`
      SELECT *
      FROM board_items
      WHERE item_type = 'session'
        AND item_id = ${sessionId}
        AND membership_kind = 'primary'
      LIMIT 1
    `;
    return rows[0] ? toCatalogBoardItemRow(rows[0]) : null;
  }

  async getMarkdownDocumentBoardItem(
    documentId: string,
  ): Promise<CatalogBoardItemRow | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly BoardItemDbRow[]>`
      SELECT *
      FROM board_items
      WHERE item_type = 'markdown' AND item_id = ${documentId}
      LIMIT 1
    `;
    return rows[0] ? toCatalogBoardItemRow(rows[0]) : null;
  }

  async getBoardItemIdsForSession(sessionId: string): Promise<string[]> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly { id: string }[]>`
      SELECT id
      FROM board_items
      WHERE item_type = 'session' AND item_id = ${sessionId}
      ORDER BY id
    `;
    return rows.map((row) => row.id);
  }

  async getMarkdownDocument(documentId: string): Promise<MarkdownDocumentRow | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly MarkdownDbRow[]>`
      SELECT * FROM markdown_documents WHERE id = ${documentId}
    `;
    return rows[0] ? toMarkdownDocumentRow(rows[0]) : null;
  }

  async listContainerItems(
    params: ListContainerItemsParams,
  ): Promise<ListContainerItemsResult> {
    const sql = await this.sqlResolver.resolveSql();
    const itemTypes = params.itemTypes ?? [];
    const scanLimit = params.scanLimit ?? null;
    const scanCandidateLimit = scanLimit == null ? 0 : scanLimit + 1;
    const rows = await sql<readonly ContainerItemDbRow[]>`
      WITH search_candidates AS MATERIALIZED (
        SELECT
          bi.id,
          COALESCE(s.updated_at, md.updated_at, bi.updated_at) AS content_updated_at
        FROM board_items bi
        LEFT JOIN sessions s
          ON bi.item_type = 'session' AND s.session_id = bi.item_id
        LEFT JOIN markdown_documents md
          ON bi.item_type = 'markdown' AND md.id = bi.item_id
        WHERE ${scanLimit}::INTEGER IS NOT NULL
          AND bi.container_kind = ${params.container.containerKind}
          AND bi.container_id = ${params.container.containerId}
          AND bi.item_type IN ('session', 'markdown')
        ORDER BY content_updated_at DESC NULLS LAST, bi.id ASC
        LIMIT ${scanCandidateLimit}
      ),
      search_window AS MATERIALIZED (
        SELECT id
        FROM search_candidates
        ORDER BY content_updated_at DESC NULLS LAST, id ASC
        LIMIT ${scanLimit ?? 0}
      ),
      search_scan AS (
        SELECT
          LEAST(COUNT(*), ${scanLimit ?? 0})::BIGINT AS scanned_items,
          (COUNT(*) > ${scanLimit ?? 0}) AS truncated
        FROM search_candidates
      ),
      scoped AS (
        SELECT
          bi.*,
          CASE
            WHEN bi.item_type = 'task' THEN COALESCE(r.archived, FALSE)
            WHEN bi.item_type = 'custom_view' THEN COALESCE(cv.archived, FALSE)
            WHEN bi.item_type = 'subfolder' THEN COALESCE(sf.archived, FALSE)
            ELSE FALSE
          END AS item_archived,
          COALESCE(
            s.updated_at,
            md.updated_at,
            r.updated_at,
            cv.updated_at,
            fa.updated_at,
            bi.updated_at
          ) AS content_updated_at,
          CASE
            WHEN bi.item_type = 'session' THEN COALESCE(
              NULLIF(BTRIM(s.display_name), ''),
              NULLIF(BTRIM(user_event.searchable_text), ''),
              '제목 없는 세션'
            )
            WHEN bi.item_type = 'markdown' THEN CONCAT_WS(' ', md.title, md.body)
            ELSE ''
          END AS search_text,
          s.display_name AS session_display_name,
          s.status AS session_status,
          s.session_type AS session_type,
          s.created_at AS session_created_at,
          s.updated_at AS session_updated_at,
          s.away_summary AS session_away_summary,
          s.caller_session_id AS session_caller_session_id,
          s.predecessor_session_id AS session_predecessor_session_id,
          s.node_id AS session_node_id,
          s.agent_id AS session_agent_id,
          s.last_event_id AS session_last_event_id,
          s.last_read_event_id AS session_last_read_event_id,
          user_event.searchable_text AS session_last_user_preview,
          md.id AS markdown_id,
          md.title AS markdown_title,
          md.body AS markdown_body,
          md.updated_at AS markdown_updated_at,
          r.id AS task_id,
          r.title AS task_title,
          r.updated_at AS task_updated_at,
          cv.id AS custom_view_id,
          cv.title AS custom_view_title,
          cv.updated_at AS custom_view_updated_at,
          fa.id AS asset_id,
          fa.original_name AS asset_title,
          fa.updated_at AS asset_updated_at,
          sf.id AS subfolder_id,
          sf.name AS subfolder_title
        FROM board_items bi
        LEFT JOIN sessions s
          ON bi.item_type = 'session' AND s.session_id = bi.item_id
        LEFT JOIN LATERAL (
          SELECT e.searchable_text
          FROM events e
          WHERE e.session_id = s.session_id
            AND e.event_type IN ('user_message', 'intervention_sent', 'realtime_transcript')
          ORDER BY e.id DESC
          LIMIT 1
        ) AS user_event ON TRUE
        LEFT JOIN markdown_documents md
          ON bi.item_type = 'markdown' AND md.id = bi.item_id
        LEFT JOIN tasks r
          ON bi.item_type = 'task' AND r.id = bi.item_id
        LEFT JOIN board_custom_views cv
          ON bi.item_type = 'custom_view' AND cv.id = bi.item_id
        LEFT JOIN file_assets fa
          ON bi.item_type = 'asset' AND fa.id = bi.item_id
        LEFT JOIN folders sf
          ON bi.item_type = 'subfolder' AND sf.id = bi.item_id
        WHERE bi.container_kind = ${params.container.containerKind}
          AND bi.container_id = ${params.container.containerId}
          AND (${itemTypes.length === 0} OR bi.item_type = ANY(${sql.array(itemTypes)}))
          AND (
            ${scanLimit}::INTEGER IS NULL
            OR EXISTS (SELECT 1 FROM search_window sw WHERE sw.id = bi.id)
          )
      ),
      filtered AS (
        SELECT *
        FROM scoped
        WHERE (${params.includeArchived} OR item_archived = FALSE)
          AND (
            ${params.query}::text IS NULL
            OR (
              item_type IN ('session', 'markdown')
              AND POSITION(LOWER(${params.query ?? ""}) IN LOWER(search_text)) > 0
            )
          )
      ),
      paged AS (
        SELECT *
        FROM filtered
        ORDER BY content_updated_at DESC NULLS LAST, id ASC
        LIMIT ${params.limit} OFFSET ${params.cursor}
      ),
      event_counts AS (
        SELECT e.session_id, COUNT(*)::BIGINT AS event_count
        FROM events e
        JOIN paged p ON p.item_type = 'session' AND p.item_id = e.session_id
        GROUP BY e.session_id
      ),
      summary AS (
        SELECT
          COUNT(*)::BIGINT AS total_count,
          COUNT(*) FILTER (WHERE item_type = 'session')::BIGINT AS session_count,
          COUNT(*) FILTER (WHERE item_type = 'markdown')::BIGINT AS markdown_count,
          COUNT(*) FILTER (WHERE item_type = 'subfolder')::BIGINT AS subfolder_count,
          COUNT(*) FILTER (WHERE item_type = 'asset')::BIGINT AS asset_count,
          COUNT(*) FILTER (WHERE item_type = 'frame')::BIGINT AS frame_count,
          COUNT(*) FILTER (WHERE item_type = 'task')::BIGINT AS task_count,
          COUNT(*) FILTER (WHERE item_type = 'custom_view')::BIGINT AS custom_view_count,
          (SELECT scanned_items FROM search_scan) AS scanned_items,
          (SELECT truncated FROM search_scan) AS search_truncated
        FROM filtered
      )
      SELECT
        p.id AS bi_id,
        p.folder_id AS bi_folder_id,
        p.container_kind AS bi_container_kind,
        p.container_id AS bi_container_id,
        p.membership_kind AS bi_membership_kind,
        p.source_task_item_id AS bi_source_task_item_id,
        p.item_type AS bi_item_type,
        p.item_id AS bi_item_id,
        p.x AS bi_x,
        p.y AS bi_y,
        p.metadata AS bi_metadata,
        p.created_at AS bi_created_at,
        p.updated_at AS bi_updated_at,
        p.item_archived,
        p.session_display_name,
        p.session_status,
        p.session_type,
        p.session_created_at,
        p.session_updated_at,
        COALESCE(ec.event_count, 0)::BIGINT AS session_event_count,
        p.session_away_summary,
        p.session_caller_session_id,
        p.session_predecessor_session_id,
        p.session_node_id,
        p.session_agent_id,
        p.session_last_event_id,
        p.session_last_read_event_id,
        p.session_last_user_preview,
        p.markdown_id,
        p.markdown_title,
        p.markdown_body,
        p.markdown_updated_at,
        p.task_id,
        p.task_title,
        p.task_updated_at,
        p.custom_view_id,
        p.custom_view_title,
        p.custom_view_updated_at,
        p.asset_id,
        p.asset_title,
        p.asset_updated_at,
        p.subfolder_id,
        p.subfolder_title,
        summary.*
      FROM summary
      LEFT JOIN paged p ON TRUE
      LEFT JOIN event_counts ec ON ec.session_id = p.item_id
      ORDER BY p.content_updated_at DESC NULLS LAST, p.id ASC
    `;
    const summary = rows[0];
    return {
      items: rows.flatMap((row) => row.bi_id ? [toContainerItemRecord(row)] : []),
      total: Number(summary?.total_count ?? 0),
      counts: {
        session: Number(summary?.session_count ?? 0),
        markdown: Number(summary?.markdown_count ?? 0),
        subfolder: Number(summary?.subfolder_count ?? 0),
        asset: Number(summary?.asset_count ?? 0),
        frame: Number(summary?.frame_count ?? 0),
        task: Number(summary?.task_count ?? 0),
        custom_view: Number(summary?.custom_view_count ?? 0),
      },
      scan: scanLimit == null
        ? null
        : {
            limit: scanLimit,
            scannedItems: Number(summary?.scanned_items ?? 0),
            truncated: Boolean(summary?.search_truncated),
          },
    };
  }
}
