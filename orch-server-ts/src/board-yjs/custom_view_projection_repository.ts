import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import {
  BoardYjsSqlResolver,
  type BoardYjsQuerySql,
} from "./board_yjs_sql.js";
import {
  normalizeCustomViewJoin,
  normalizeCustomViewRow,
  type CustomViewDbRow,
  type CustomViewJoinRow,
} from "./board_projection_serialization.js";
import {
  CustomViewRevisionConflictError,
  type CreateCustomViewRecordInput,
  type CustomViewRecordMutationResult,
  type CustomViewWithBoardItem,
  type PatchCustomViewRecordInput,
} from "./board_projection_types.js";
import type { BoardYjsContainerRef } from "./board_yjs_types.js";

export class CustomViewProjectionRepository {
  private readonly sqlResolver: BoardYjsSqlResolver;

  constructor(resolver: LiveDbSqlResolver) {
    this.sqlResolver = new BoardYjsSqlResolver(resolver);
  }

  async getCustomView(customViewId: string): Promise<CustomViewWithBoardItem | null> {
    const sql = await this.sqlResolver.resolveSql();
    const rows = await sql<readonly CustomViewJoinRow[]>`
      SELECT
        cv.id AS cv_id,
        cv.board_item_id AS cv_board_item_id,
        cv.title AS cv_title,
        cv.html AS cv_html,
        cv.revision AS cv_revision,
        cv.archived AS cv_archived,
        cv.created_actor_kind AS cv_created_actor_kind,
        cv.created_session_id AS cv_created_session_id,
        cv.created_event_id AS cv_created_event_id,
        cv.updated_actor_kind AS cv_updated_actor_kind,
        cv.updated_session_id AS cv_updated_session_id,
        cv.updated_event_id AS cv_updated_event_id,
        cv.created_at AS cv_created_at,
        cv.updated_at AS cv_updated_at,
        bi.id AS bi_id,
        bi.folder_id AS bi_folder_id,
        bi.container_kind AS bi_container_kind,
        bi.container_id AS bi_container_id,
        bi.membership_kind AS bi_membership_kind,
        bi.source_task_item_id AS bi_source_task_item_id,
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
    const sql = await this.sqlResolver.resolveSql();
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    const rows = await sql<readonly CustomViewJoinRow[]>`
      SELECT
        cv.id AS cv_id,
        cv.board_item_id AS cv_board_item_id,
        cv.title AS cv_title,
        cv.html AS cv_html,
        cv.revision AS cv_revision,
        cv.archived AS cv_archived,
        cv.created_actor_kind AS cv_created_actor_kind,
        cv.created_session_id AS cv_created_session_id,
        cv.created_event_id AS cv_created_event_id,
        cv.updated_actor_kind AS cv_updated_actor_kind,
        cv.updated_session_id AS cv_updated_session_id,
        cv.updated_event_id AS cv_updated_event_id,
        cv.created_at AS cv_created_at,
        cv.updated_at AS cv_updated_at,
        bi.id AS bi_id,
        bi.folder_id AS bi_folder_id,
        bi.container_kind AS bi_container_kind,
        bi.container_id AS bi_container_id,
        bi.membership_kind AS bi_membership_kind,
        bi.source_task_item_id AS bi_source_task_item_id,
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

  async createCustomViewRecord(
    input: CreateCustomViewRecordInput,
  ): Promise<CustomViewRecordMutationResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      const eventId = input.actorSessionId
        ? await appendActorEvent(transaction, {
            actorSessionId: input.actorSessionId,
            eventType: "custom_view_created",
            customViewId: input.id,
            boardItemId: input.boardItemId,
            revision: 1,
            idempotencyKey: input.idempotencyKey,
            searchableText: `custom view created ${input.title}`,
          })
        : null;
      const rows = await transaction<readonly CustomViewDbRow[]>`
        INSERT INTO board_custom_views (
          id,
          board_item_id,
          title,
          html,
          revision,
          archived,
          created_actor_kind,
          created_session_id,
          created_event_id,
          updated_actor_kind,
          updated_session_id,
          updated_event_id
        )
        VALUES (
          ${input.id},
          ${input.boardItemId},
          ${input.title},
          ${input.html},
          1,
          FALSE,
          ${input.actorKind},
          ${input.actorSessionId},
          ${eventId},
          ${input.actorKind},
          ${input.actorSessionId},
          ${eventId}
        )
        RETURNING *
      `;
      return {
        customView: normalizeCustomViewRow(requireOne(rows, "createCustomViewRecord")),
        eventId,
      };
    });
  }

  async patchCustomViewRecord(
    input: PatchCustomViewRecordInput,
  ): Promise<CustomViewRecordMutationResult> {
    const sql = await this.sqlResolver.resolveSql();
    return await sql.begin(async (transaction) => {
      const eventId = input.actorSessionId
        ? await appendActorEvent(transaction, {
            actorSessionId: input.actorSessionId,
            eventType: "custom_view_updated",
            customViewId: input.customViewId,
            boardItemId: input.boardItemId,
            revision: input.expectedRevision + 1,
            idempotencyKey: input.idempotencyKey,
            searchableText: `custom view updated ${input.customViewId}`,
          })
        : null;
      const currentRows = await transaction<readonly CustomViewDbRow[]>`
        SELECT *
        FROM board_custom_views
        WHERE id = ${input.customViewId}
        FOR UPDATE
      `;
      const current = normalizeCustomViewRow(
        requireOne(currentRows, "patchCustomViewRecord"),
      );
      if (current.revision !== input.expectedRevision) {
        throw new CustomViewRevisionConflictError(
          input.customViewId,
          input.expectedRevision,
          current.revision,
        );
      }
      const nextTitle = Object.prototype.hasOwnProperty.call(input, "title")
        ? input.title ?? null
        : current.title;
      const rows = await transaction<readonly CustomViewDbRow[]>`
        UPDATE board_custom_views
        SET title = ${nextTitle},
            html = ${input.html},
            revision = revision + 1,
            updated_actor_kind = ${input.actorKind},
            updated_session_id = ${input.actorSessionId},
            updated_event_id = ${eventId},
            updated_at = NOW()
        WHERE id = ${input.customViewId}
        RETURNING *
      `;
      return {
        customView: normalizeCustomViewRow(
          requireOne(rows, "patchCustomViewRecord update"),
        ),
        eventId,
      };
    });
  }
}

async function appendActorEvent(
  sql: BoardYjsQuerySql,
  input: {
    actorSessionId: string;
    eventType: "custom_view_created" | "custom_view_updated";
    customViewId: string;
    boardItemId: string;
    revision: number;
    idempotencyKey: string;
    searchableText: string;
  },
): Promise<number> {
  const rows = await sql<readonly { event_append: string | number }[]>`
    SELECT event_append(
      ${input.actorSessionId},
      ${input.eventType},
      ${JSON.stringify({
        custom_view_id: input.customViewId,
        board_item_id: input.boardItemId,
        revision: input.revision,
      })},
      ${input.searchableText},
      ${new Date()},
      ${input.idempotencyKey}
    ) AS event_append
  `;
  const eventId = Number(rows[0]?.event_append);
  if (!Number.isFinite(eventId)) {
    throw new Error(`event_append returned non-number: ${JSON.stringify(rows[0])}`);
  }
  return eventId;
}

function requireOne<T>(rows: readonly T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${label} returned no rows`);
  return row;
}
