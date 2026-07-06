import type {
  BoardYjsContainerRef,
  CatalogBoardItemRow,
  CustomViewRow,
  SqlClient,
} from "../session_db_types.js";
import {
  toCatalogBoardItemRow,
  toIsoString,
  type RepositorySql,
} from "./repository_helpers.js";

export class CustomViewRevisionConflictError extends Error {
  constructor(
    customViewId: string,
    expectedRevision: number,
    actualRevision: number,
  ) {
    super(
      `custom view revision conflict for ${customViewId}: expected ${expectedRevision}, actual ${actualRevision}`,
    );
    this.name = "CustomViewRevisionConflictError";
  }
}

export interface CustomViewWithBoardItem {
  customView: CustomViewRow;
  boardItem: CatalogBoardItemRow;
}

export class CustomViewRepository {
  constructor(private readonly sql: SqlClient) {}

  async transaction<T>(callback: (sql: RepositorySql) => Promise<T>): Promise<T> {
    return (await this.sql.begin(callback)) as T;
  }

  async getCustomView(customViewId: string): Promise<CustomViewWithBoardItem | null> {
    const rows = await this.sql<CustomViewJoinRow[]>`
      SELECT
        cv.id AS cv_id,
        cv.board_item_id AS cv_board_item_id,
        cv.title AS cv_title,
        cv.html AS cv_html,
        cv.revision AS cv_revision,
        cv.archived AS cv_archived,
        cv.created_session_id AS cv_created_session_id,
        cv.created_event_id AS cv_created_event_id,
        cv.updated_session_id AS cv_updated_session_id,
        cv.updated_event_id AS cv_updated_event_id,
        cv.created_at AS cv_created_at,
        cv.updated_at AS cv_updated_at,
        bi.id AS bi_id,
        bi.folder_id AS bi_folder_id,
        bi.container_kind AS bi_container_kind,
        bi.container_id AS bi_container_id,
        bi.membership_kind AS bi_membership_kind,
        bi.source_runbook_item_id AS bi_source_runbook_item_id,
        bi.item_type AS bi_item_type,
        bi.item_id AS bi_item_id,
        bi.x AS bi_x,
        bi.y AS bi_y,
        bi.metadata AS bi_metadata,
        bi.created_at AS bi_created_at,
        bi.updated_at AS bi_updated_at
      FROM board_custom_views cv
      JOIN board_items bi ON bi.id = cv.board_item_id
      WHERE cv.id = ${customViewId}
      LIMIT 1
    `;
    return rows[0] ? normalizeCustomViewJoin(rows[0]) : null;
  }

  async listCustomViews(params: {
    container: BoardYjsContainerRef;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<CustomViewWithBoardItem[]> {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    const rows = await this.sql<CustomViewJoinRow[]>`
      SELECT
        cv.id AS cv_id,
        cv.board_item_id AS cv_board_item_id,
        cv.title AS cv_title,
        cv.html AS cv_html,
        cv.revision AS cv_revision,
        cv.archived AS cv_archived,
        cv.created_session_id AS cv_created_session_id,
        cv.created_event_id AS cv_created_event_id,
        cv.updated_session_id AS cv_updated_session_id,
        cv.updated_event_id AS cv_updated_event_id,
        cv.created_at AS cv_created_at,
        cv.updated_at AS cv_updated_at,
        bi.id AS bi_id,
        bi.folder_id AS bi_folder_id,
        bi.container_kind AS bi_container_kind,
        bi.container_id AS bi_container_id,
        bi.membership_kind AS bi_membership_kind,
        bi.source_runbook_item_id AS bi_source_runbook_item_id,
        bi.item_type AS bi_item_type,
        bi.item_id AS bi_item_id,
        bi.x AS bi_x,
        bi.y AS bi_y,
        bi.metadata AS bi_metadata,
        bi.created_at AS bi_created_at,
        bi.updated_at AS bi_updated_at
      FROM board_custom_views cv
      JOIN board_items bi ON bi.id = cv.board_item_id
      WHERE bi.container_kind = ${params.container.containerKind}
        AND bi.container_id = ${params.container.containerId}
        AND (${params.includeArchived ?? false} OR cv.archived = FALSE)
      ORDER BY bi.y ASC, bi.x ASC, cv.updated_at DESC, cv.id ASC
      LIMIT ${limit}
    `;
    return rows.map(normalizeCustomViewJoin);
  }

  async createCustomViewTx(
    sql: RepositorySql,
    params: {
      id: string;
      boardItemId: string;
      title: string | null;
      html: string;
      actorSessionId: string;
      eventId: number;
    },
  ): Promise<CustomViewRow> {
    const rows = await sql<CustomViewDbRow[]>`
      INSERT INTO board_custom_views (
        id,
        board_item_id,
        title,
        html,
        revision,
        archived,
        created_session_id,
        created_event_id,
        updated_session_id,
        updated_event_id
      )
      VALUES (
        ${params.id},
        ${params.boardItemId},
        ${params.title},
        ${params.html},
        1,
        FALSE,
        ${params.actorSessionId},
        ${params.eventId},
        ${params.actorSessionId},
        ${params.eventId}
      )
      RETURNING *
    `;
    return normalizeCustomViewRow(requireOne(rows, "createCustomViewTx"));
  }

  async patchCustomViewTx(
    sql: RepositorySql,
    params: {
      customViewId: string;
      expectedRevision: number;
      html: string;
      title?: string | null;
      actorSessionId: string;
      eventId: number;
    },
  ): Promise<CustomViewRow> {
    const currentRows = await sql<CustomViewDbRow[]>`
      SELECT *
      FROM board_custom_views
      WHERE id = ${params.customViewId}
      FOR UPDATE
    `;
    const current = normalizeCustomViewRow(requireOne(currentRows, "patchCustomViewTx"));
    if (current.revision !== params.expectedRevision) {
      throw new CustomViewRevisionConflictError(
        params.customViewId,
        params.expectedRevision,
        current.revision,
      );
    }
    const nextTitle = Object.prototype.hasOwnProperty.call(params, "title")
      ? params.title ?? null
      : current.title;
    const rows = await sql<CustomViewDbRow[]>`
      UPDATE board_custom_views
      SET title = ${nextTitle},
          html = ${params.html},
          revision = revision + 1,
          updated_session_id = ${params.actorSessionId},
          updated_event_id = ${params.eventId},
          updated_at = NOW()
      WHERE id = ${params.customViewId}
      RETURNING *
    `;
    return normalizeCustomViewRow(requireOne(rows, "patchCustomViewTx update"));
  }

  async getCustomViewBoardItem(customViewId: string): Promise<CatalogBoardItemRow | null> {
    const rows = await this.sql<BoardItemDbRow[]>`
      SELECT bi.*
      FROM board_custom_views cv
      JOIN board_items bi ON bi.id = cv.board_item_id
      WHERE cv.id = ${customViewId}
      LIMIT 1
    `;
    return rows[0] ? toCatalogBoardItemRow(rows[0]) : null;
  }
}

function normalizeCustomViewJoin(row: CustomViewJoinRow): CustomViewWithBoardItem {
  return {
    customView: normalizeCustomViewRow({
      id: row.cv_id,
      board_item_id: row.cv_board_item_id,
      title: row.cv_title,
      html: row.cv_html,
      revision: row.cv_revision,
      archived: row.cv_archived,
      created_session_id: row.cv_created_session_id,
      created_event_id: row.cv_created_event_id,
      updated_session_id: row.cv_updated_session_id,
      updated_event_id: row.cv_updated_event_id,
      created_at: row.cv_created_at,
      updated_at: row.cv_updated_at,
    }),
    boardItem: toCatalogBoardItemRow({
      id: row.bi_id,
      folder_id: row.bi_folder_id,
      container_kind: row.bi_container_kind,
      container_id: row.bi_container_id,
      membership_kind: row.bi_membership_kind,
      source_runbook_item_id: row.bi_source_runbook_item_id,
      item_type: row.bi_item_type,
      item_id: row.bi_item_id,
      x: row.bi_x,
      y: row.bi_y,
      metadata: row.bi_metadata,
      created_at: row.bi_created_at,
      updated_at: row.bi_updated_at,
    }),
  };
}

function normalizeCustomViewRow(row: CustomViewDbRow): CustomViewRow {
  return {
    id: row.id,
    boardItemId: row.board_item_id,
    title: row.title,
    html: row.html,
    revision: Number(row.revision),
    archived: Boolean(row.archived),
    createdSessionId: row.created_session_id,
    createdEventId: row.created_event_id === null ? null : Number(row.created_event_id),
    updatedSessionId: row.updated_session_id,
    updatedEventId: row.updated_event_id === null ? null : Number(row.updated_event_id),
    ...(toIsoString(row.created_at) ? { createdAt: toIsoString(row.created_at) } : {}),
    ...(toIsoString(row.updated_at) ? { updatedAt: toIsoString(row.updated_at) } : {}),
  };
}

function requireOne<T>(rows: readonly T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${label} returned no rows`);
  return row;
}

interface CustomViewDbRow {
  id: string;
  board_item_id: string;
  title: string | null;
  html: string;
  revision: string | number;
  archived: boolean;
  created_session_id: string | null;
  created_event_id: string | number | null;
  updated_session_id: string | null;
  updated_event_id: string | number | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface BoardItemDbRow {
  id: string;
  folder_id: string;
  container_kind: "folder" | "runbook" | null;
  container_id: string | null;
  membership_kind: "primary" | "reference" | null;
  source_runbook_item_id: string | null;
  item_type: "custom_view";
  item_id: string;
  x: string | number;
  y: string | number;
  metadata: unknown;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface CustomViewJoinRow {
  cv_id: string;
  cv_board_item_id: string;
  cv_title: string | null;
  cv_html: string;
  cv_revision: string | number;
  cv_archived: boolean;
  cv_created_session_id: string | null;
  cv_created_event_id: string | number | null;
  cv_updated_session_id: string | null;
  cv_updated_event_id: string | number | null;
  cv_created_at: Date | string | null;
  cv_updated_at: Date | string | null;
  bi_id: string;
  bi_folder_id: string;
  bi_container_kind: "folder" | "runbook" | null;
  bi_container_id: string | null;
  bi_membership_kind: "primary" | "reference" | null;
  bi_source_runbook_item_id: string | null;
  bi_item_type: "custom_view";
  bi_item_id: string;
  bi_x: string | number;
  bi_y: string | number;
  bi_metadata: unknown;
  bi_created_at: Date | string | null;
  bi_updated_at: Date | string | null;
}
