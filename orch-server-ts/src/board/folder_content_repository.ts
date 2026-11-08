import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { FolderContentSqlResolver } from "./folder_content_sql.js";
import type {
  BoardItemDbRow,
  ContainerItemDbRow,
  MarkdownDbRow,
} from "./folder_content_serialization.js";
import {
  toCatalogBoardItemRow,
  toFolderItemRecord,
  toMarkdownDocumentRow,
} from "./folder_content_serialization.js";
import type {
  ListFolderItemsParams,
  ListFolderItemsResult,
} from "./folder_content_types.js";
import type {
  CatalogBoardItemRow,
  MarkdownDocumentRow,
} from "./folder_content_types.js";

export class FolderContentRepository {
  private readonly sqlResolver: FolderContentSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new FolderContentSqlResolver(resolver);
  }

  async getBoardItems(): Promise<CatalogBoardItemRow[]> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly BoardItemDbRow[]>`
      SELECT id, folder_id, membership_kind, item_type, item_id, x, y, metadata, created_at, updated_at
      FROM board_items WHERE item_type IN ('asset', 'custom_view')
      UNION ALL
      SELECT 'session:' || session_id, folder_id, 'primary', 'session', session_id, 0, 0,
        '{}'::jsonb, created_at, updated_at FROM sessions WHERE folder_id IS NOT NULL
      UNION ALL
      SELECT 'subfolder:' || id, parent_folder_id, 'primary', 'subfolder', id, 0, 0,
        '{}'::jsonb, created_at, updated_at FROM folders WHERE parent_folder_id IS NOT NULL
      UNION ALL
      SELECT COALESCE(b.id, 'markdown:' || md.id), md.folder_id, 'primary', 'markdown', md.id,
        COALESCE(b.x, 0), COALESCE(b.y, 0),
        COALESCE(b.metadata, '{}'::jsonb) || jsonb_build_object('title', md.title,
          'preview', LEFT(TRIM(REGEXP_REPLACE(md.body, '\\s+', ' ', 'g')), 180), 'version', md.version),
        COALESCE(b.created_at, md.created_at), md.updated_at
      FROM markdown_documents md LEFT JOIN board_items b ON b.item_type = 'markdown' AND b.item_id = md.id
        AND b.membership_kind = 'primary' AND b.folder_id = md.folder_id
      WHERE md.folder_id IS NOT NULL
    `;
    return rows.map(toCatalogBoardItemRow);
  }

  async getBoardItemsByFolder(
    folderId: string,
  ): Promise<CatalogBoardItemRow[]> {
    const result = await this.listFolderItems({ folderId, query: null, includeArchived: true,
      itemTypes: null, limit: 10000, cursor: 0 });
    return result.items.map(item => item.boardItem);
  }

  async getBoardItemById(boardItemId: string): Promise<CatalogBoardItemRow | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly BoardItemDbRow[]>`
      SELECT bi.id, bi.folder_id, bi.membership_kind, bi.item_type, bi.item_id, bi.x, bi.y, bi.metadata, bi.created_at, bi.updated_at
      FROM board_items bi LEFT JOIN markdown_documents md ON bi.item_type = 'markdown' AND md.id = bi.item_id
      WHERE bi.id = ${boardItemId}
        AND (bi.item_type <> 'markdown' OR bi.membership_kind = 'reference' OR md.folder_id = bi.folder_id) LIMIT 1
    `;
    if (rows[0]?.membership_kind === "reference") return toCatalogBoardItemRow(rows[0]);
    if (rows[0]?.item_type === "markdown") return await this.getMarkdownDocumentBoardItem(rows[0].item_id);
    if (rows[0]?.item_type === "session") return await this.getPrimarySessionBoardItem(rows[0].item_id);
    if (rows[0] && rows[0].item_type !== "subfolder") return toCatalogBoardItemRow(rows[0]);
    if (boardItemId.startsWith("markdown:")) return await this.getMarkdownDocumentBoardItem(boardItemId.slice("markdown:".length));
    if (boardItemId.startsWith("session:")) return await this.getPrimarySessionBoardItem(boardItemId.slice("session:".length));
    if (rows[0]?.item_type === "subfolder" || boardItemId.startsWith("subfolder:")) {
      const folderId = rows[0]?.item_id ?? boardItemId.slice("subfolder:".length);
      const folders = await sql<readonly BoardItemDbRow[]>`
        SELECT 'subfolder:' || id AS id, parent_folder_id AS folder_id, 'primary'::text AS membership_kind,
          'subfolder'::text AS item_type, id AS item_id, 0::float8 AS x, 0::float8 AS y,
          '{}'::jsonb AS metadata, created_at, updated_at FROM folders
        WHERE id = ${folderId} AND parent_folder_id IS NOT NULL
      `;
      return folders[0] ? toCatalogBoardItemRow(folders[0]) : null;
    }
    return null;
  }

  async getPrimarySessionBoardItem(sessionId: string): Promise<CatalogBoardItemRow | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly BoardItemDbRow[]>`
      SELECT 'session:' || session_id AS id, folder_id, 'primary'::text AS membership_kind,
        'session'::text AS item_type, session_id AS item_id, 0::float8 AS x, 0::float8 AS y,
        '{}'::jsonb AS metadata, created_at, updated_at
      FROM sessions WHERE session_id = ${sessionId} AND folder_id IS NOT NULL
      LIMIT 1
    `;
    return rows[0] ? toCatalogBoardItemRow(rows[0]) : null;
  }

  async getMarkdownDocumentBoardItem(
    documentId: string,
  ): Promise<CatalogBoardItemRow | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly BoardItemDbRow[]>`
      SELECT COALESCE(bi.id, 'markdown:' || md.id) AS id, md.folder_id, 'primary'::text AS membership_kind,
        'markdown'::text AS item_type, md.id AS item_id, COALESCE(bi.x, 0) AS x, COALESCE(bi.y, 0) AS y,
        COALESCE(bi.metadata, '{}'::jsonb) || jsonb_build_object('title', md.title,
          'preview', LEFT(TRIM(REGEXP_REPLACE(md.body, '\\s+', ' ', 'g')), 180), 'version', md.version) AS metadata,
        COALESCE(bi.created_at, md.created_at) AS created_at, md.updated_at
      FROM markdown_documents md LEFT JOIN board_items bi ON bi.item_type = 'markdown' AND bi.item_id = md.id
        AND bi.membership_kind = 'primary' AND bi.folder_id = md.folder_id
      WHERE md.id = ${documentId} AND md.folder_id IS NOT NULL
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
      SELECT id, folder_id, title, body, version, created_at, updated_at FROM markdown_documents WHERE id = ${documentId}
    `;
    return rows[0] ? toMarkdownDocumentRow(rows[0]) : null;
  }

  async listMarkdownDocuments(input: {
    folderId?: string; search?: string; cursor?: string; limit: number; allowedFolderIds?: readonly string[];
  }): Promise<{ documents: MarkdownDocumentRow[]; nextCursor: string | null }> {
    let cursor: { updatedAt: string; id: string } | null = null;
    if (input.cursor) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
        if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== "string"
          || !Number.isFinite(Date.parse(parsed[0])) || typeof parsed[1] !== "string" || !parsed[1]) throw new Error();
        cursor = { updatedAt: parsed[0], id: parsed[1] };
      } catch { throw Object.assign(new Error("Invalid cursor"), { statusCode: 422 }); }
    }
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly (MarkdownDbRow & { cursor_updated_at: string })[]>`
      SELECT id, folder_id, title, body, version, created_at, updated_at, updated_at::text AS cursor_updated_at FROM markdown_documents
      WHERE (${input.folderId ?? null}::text IS NULL OR folder_id = ${input.folderId ?? null})
        AND (${input.allowedFolderIds === undefined} OR folder_id = ANY(${sql.array(input.allowedFolderIds ?? [])}::text[]))
        AND (${input.search ?? null}::text IS NULL OR POSITION(LOWER(${input.search ?? ""}) IN LOWER(title || ' ' || body)) > 0)
        AND (${cursor?.updatedAt ?? null}::text IS NULL OR updated_at < ${cursor?.updatedAt ?? null}::text::timestamptz
          OR (updated_at = ${cursor?.updatedAt ?? null}::text::timestamptz AND id > ${cursor?.id ?? ""}))
      ORDER BY updated_at DESC, id ASC LIMIT ${input.limit + 1}
    `;
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const time = last?.cursor_updated_at;
    return { documents: page.map(toMarkdownDocumentRow), nextCursor: rows.length > input.limit && last && time
      ? Buffer.from(JSON.stringify([time, last.id]), "utf8").toString("base64url") : null };
  }

  async listFolderItems(
    params: ListFolderItemsParams,
  ): Promise<ListFolderItemsResult> {
    const sql = await this.sqlResolver.resolveSql();
    const itemTypes = params.itemTypes ?? [];
    const scanLimit = params.scanLimit ?? null;
    const scanCandidateLimit = scanLimit == null ? 0 : scanLimit + 1;
    const rows = await sql<readonly ContainerItemDbRow[]>`
      WITH flat_items AS (
        SELECT 'session:' || s.session_id AS id, s.folder_id, 'primary'::text AS membership_kind,
          'session'::text AS item_type, s.session_id AS item_id, 0::float8 AS x, 0::float8 AS y,
          '{}'::jsonb AS metadata, s.created_at, s.updated_at
        FROM sessions s WHERE s.folder_id = ${params.folderId}
        UNION ALL
        SELECT COALESCE(b.id, 'markdown:' || md.id), md.folder_id, 'primary'::text, 'markdown'::text,
          md.id, COALESCE(b.x, 0), COALESCE(b.y, 0),
          COALESCE(b.metadata, '{}'::jsonb) || jsonb_build_object('title', md.title,
            'preview', LEFT(TRIM(REGEXP_REPLACE(md.body, '\\s+', ' ', 'g')), 180), 'version', md.version),
          COALESCE(b.created_at, md.created_at), md.updated_at
        FROM markdown_documents md
        LEFT JOIN board_items b ON b.item_type = 'markdown' AND b.item_id = md.id
          AND b.membership_kind = 'primary' AND b.folder_id = md.folder_id
        WHERE md.folder_id = ${params.folderId}
        UNION ALL
        SELECT 'subfolder:' || f.id, f.parent_folder_id, 'primary'::text, 'subfolder'::text,
          f.id, 0::float8, 0::float8, '{}'::jsonb, f.created_at, f.updated_at
        FROM folders f WHERE f.parent_folder_id = ${params.folderId}
        UNION ALL
        SELECT b.id, b.folder_id, b.membership_kind, b.item_type, b.item_id, b.x, b.y,
          b.metadata, b.created_at, b.updated_at
        FROM board_items b WHERE b.folder_id = ${params.folderId} AND b.item_type IN ('asset', 'custom_view')
      ),
      search_candidates AS MATERIALIZED (
        SELECT
          bi.id,
          COALESCE(s.updated_at, md.updated_at, bi.updated_at) AS content_updated_at
        FROM flat_items bi
        LEFT JOIN sessions s
          ON bi.item_type = 'session' AND s.session_id = bi.item_id
        LEFT JOIN markdown_documents md
          ON bi.item_type = 'markdown' AND md.id = bi.item_id
        WHERE ${scanLimit}::INTEGER IS NOT NULL
          AND bi.folder_id = ${params.folderId}
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

            WHEN bi.item_type = 'custom_view' THEN COALESCE(cv.archived, FALSE)
            WHEN bi.item_type = 'subfolder' THEN COALESCE(sf.archived, FALSE)
            ELSE FALSE
          END AS item_archived,
          COALESCE(
            s.updated_at,
            md.updated_at,
            sf.updated_at,
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



          cv.id AS custom_view_id,
          cv.title AS custom_view_title,
          cv.updated_at AS custom_view_updated_at,
          fa.id AS asset_id,
          fa.original_name AS asset_title,
          fa.updated_at AS asset_updated_at,
          sf.id AS subfolder_id,
          sf.name AS subfolder_title
        FROM flat_items bi
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

        LEFT JOIN board_custom_views cv
          ON bi.item_type = 'custom_view' AND cv.id = bi.item_id
        LEFT JOIN file_assets fa
          ON bi.item_type = 'asset' AND fa.id = bi.item_id
        LEFT JOIN folders sf
          ON bi.item_type = 'subfolder' AND sf.id = bi.item_id
        WHERE bi.folder_id = ${params.folderId}
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

          COUNT(*) FILTER (WHERE item_type = 'custom_view')::BIGINT AS custom_view_count,
          (SELECT scanned_items FROM search_scan) AS scanned_items,
          (SELECT truncated FROM search_scan) AS search_truncated
        FROM filtered
      )
      SELECT
        p.id AS bi_id,
        p.folder_id AS bi_folder_id,


        p.membership_kind AS bi_membership_kind,
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
      items: rows.flatMap((row) => row.bi_id ? [toFolderItemRecord(row)] : []),
      total: Number(summary?.total_count ?? 0),
      counts: {
        session: Number(summary?.session_count ?? 0),
        markdown: Number(summary?.markdown_count ?? 0),
        subfolder: Number(summary?.subfolder_count ?? 0),
        asset: Number(summary?.asset_count ?? 0),
        frame: Number(summary?.frame_count ?? 0),

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
