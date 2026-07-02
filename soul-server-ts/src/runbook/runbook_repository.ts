import type {
  RunbookAssigneeFields,
  RunbookItemRow,
  RunbookItemStatus,
  RunbookListRow,
  RunbookMyTurnItemRow,
  RunbookOperationRow,
  RunbookOperationTargetKind,
  RunbookRow,
  RunbookSectionRow,
  RunbookSnapshot,
  RunbookStatus,
  SqlClient,
} from "../db/session_db_types.js";
import {
  asPostgresJsonValue,
  recordFromDb,
  type RepositorySql,
} from "../db/repositories/repository_helpers.js";
import type { RunbookOperationActorKind } from "../db/session_db_types.js";
import {
  type AppendRunbookOperationTxParams,
  cleanPatch,
  normalizeOperation,
  requireOne,
  RunbookVersionConflict,
} from "./runbook_models.js";

type RunbookPatch = Partial<Pick<RunbookRow, "title" | "archived">>;
type SectionPatch = Partial<
  Pick<RunbookSectionRow, "title" | "archived" | "position_key"> &
    RunbookAssigneeFields
>;
type ItemPatch = Partial<
  Pick<RunbookItemRow, "title" | "how_to" | "archived" | "position_key" | "section_id"> &
    RunbookAssigneeFields
>;

export class RunbookRepository {
  constructor(private readonly sql: SqlClient) {}

  async transaction<T>(callback: (sql: RepositorySql) => Promise<T>): Promise<T> {
    return (await this.sql.begin(callback)) as T;
  }

  async getRunbook(runbookId: string): Promise<RunbookRow | null> {
    const rows = await this.sql<RunbookRow[]>`
      SELECT * FROM runbooks WHERE id = ${runbookId}
    `;
    return rows[0] ?? null;
  }

  async getRunbookForUpdateTx(
    sql: RepositorySql,
    runbookId: string,
  ): Promise<RunbookRow> {
    const rows = await sql<RunbookRow[]>`
      SELECT * FROM runbooks WHERE id = ${runbookId} FOR UPDATE
    `;
    return requireOne(rows, "getRunbookForUpdateTx");
  }

  async getSection(sectionId: string): Promise<RunbookSectionRow | null> {
    const rows = await this.sql<RunbookSectionRow[]>`
      SELECT * FROM runbook_sections WHERE id = ${sectionId}
    `;
    return rows[0] ?? null;
  }

  async getItem(itemId: string): Promise<RunbookItemRow | null> {
    const rows = await this.sql<RunbookItemRow[]>`
      SELECT * FROM runbook_items WHERE id = ${itemId}
    `;
    return rows[0] ?? null;
  }

  async getItemForUpdateTx(
    sql: RepositorySql,
    itemId: string,
  ): Promise<RunbookItemRow> {
    const rows = await sql<RunbookItemRow[]>`
      SELECT * FROM runbook_items WHERE id = ${itemId} FOR UPDATE
    `;
    return requireOne(rows, "getItemForUpdateTx");
  }

  async getRunbookIdForItemTx(
    sql: RepositorySql,
    itemId: string,
  ): Promise<string> {
    const rows = await sql<Array<{ runbook_id: string }>>`
      SELECT s.runbook_id
      FROM runbook_items i
      JOIN runbook_sections s ON s.id = i.section_id
      WHERE i.id = ${itemId}
    `;
    return requireOne(rows, "getRunbookIdForItemTx").runbook_id;
  }

  async assertSectionBelongsToRunbookTx(
    sql: RepositorySql,
    sectionId: string,
    runbookId: string,
  ): Promise<void> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id
      FROM runbook_sections
      WHERE id = ${sectionId}
        AND runbook_id = ${runbookId}
    `;
    requireOne(rows, "assertSectionBelongsToRunbookTx");
  }

  async assertItemBelongsToRunbookTx(
    sql: RepositorySql,
    itemId: string,
    runbookId: string,
  ): Promise<void> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT i.id
      FROM runbook_items i
      JOIN runbook_sections s ON s.id = i.section_id
      WHERE i.id = ${itemId}
        AND s.runbook_id = ${runbookId}
    `;
    requireOne(rows, "assertItemBelongsToRunbookTx");
  }

  async getSnapshot(runbookId: string): Promise<RunbookSnapshot | null> {
    const [runbook, sections, items] = await Promise.all([
      this.getRunbook(runbookId),
      this.listSections(runbookId, { includeArchived: true }),
      this.listItems(runbookId, { includeArchived: true }),
    ]);
    return runbook ? { runbook, sections, items } : null;
  }

  async listRunbooks(params: {
    folderId: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<RunbookListRow[]> {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    const rows = await this.sql<Array<{
      id: string;
      board_item_id: string;
      folder_id: string;
      title: string;
      status: RunbookStatus;
      archived: boolean;
      version: number;
      x: string | number;
      y: string | number;
      metadata: unknown;
      completed_kind: RunbookRow["completed_kind"];
      completed_session_id: string | null;
      completed_event_id: number | null;
      completed_user_id: string | null;
      completed_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>>`
      SELECT
        r.id,
        r.board_item_id,
        bi.folder_id,
        r.title,
        r.status,
        r.archived,
        r.version,
        bi.x,
        bi.y,
        bi.metadata,
        r.completed_kind,
        r.completed_session_id,
        r.completed_event_id,
        r.completed_user_id,
        r.completed_at,
        r.created_at,
        r.updated_at
      FROM runbooks r
      JOIN board_items bi ON bi.id = r.board_item_id
      WHERE bi.folder_id = ${params.folderId}
        AND bi.item_type = 'runbook'
        AND (${params.includeArchived ?? false} OR r.archived = FALSE)
      ORDER BY bi.y ASC, bi.x ASC, r.updated_at DESC, r.id ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      ...row,
      x: Number(row.x),
      y: Number(row.y),
      metadata: recordFromDb(row.metadata),
    }));
  }

  async listSections(
    runbookId: string,
    params: { includeArchived?: boolean } = {},
  ): Promise<RunbookSectionRow[]> {
    return await this.sql<RunbookSectionRow[]>`
      SELECT *
      FROM runbook_sections
      WHERE runbook_id = ${runbookId}
        AND (${params.includeArchived ?? false} OR archived = FALSE)
      ORDER BY position_key ASC, created_at ASC
    `;
  }

  async listItems(
    runbookId: string,
    params: { includeArchived?: boolean } = {},
  ): Promise<RunbookItemRow[]> {
    return await this.sql<RunbookItemRow[]>`
      SELECT i.*
      FROM runbook_items i
      JOIN runbook_sections s ON s.id = i.section_id
      WHERE s.runbook_id = ${runbookId}
        AND (${params.includeArchived ?? false} OR i.archived = FALSE)
      ORDER BY s.position_key ASC, i.position_key ASC, i.created_at ASC
    `;
  }

  async listMyTurnItems(params: {
    userId?: string | null;
    limit?: number;
  } = {}): Promise<RunbookMyTurnItemRow[]> {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    return await this.sql<RunbookMyTurnItemRow[]>`
      SELECT
        r.id AS runbook_id,
        r.title AS runbook_title,
        r.status AS runbook_status,
        r.board_item_id,
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
        COALESCE(i.assignee_kind, s.assignee_kind) AS effective_assignee_kind,
        CASE WHEN i.assignee_kind IS NULL THEN s.assignee_agent_id ELSE i.assignee_agent_id END AS effective_assignee_agent_id,
        CASE WHEN i.assignee_kind IS NULL THEN s.assignee_session_id ELSE i.assignee_session_id END AS effective_assignee_session_id,
        CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END AS effective_assignee_user_id
      FROM runbook_items i
      JOIN runbook_sections s ON s.id = i.section_id
      JOIN runbooks r ON r.id = s.runbook_id
      WHERE r.archived = FALSE
        AND r.status <> 'completed'
        AND s.archived = FALSE
        AND i.archived = FALSE
        AND i.status NOT IN ('completed', 'cancelled')
        AND COALESCE(i.assignee_kind, s.assignee_kind) = 'human'
        AND (
          ${params.userId ?? null}::text IS NULL
          OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) IS NULL
          OR (CASE WHEN i.assignee_kind IS NULL THEN s.assignee_user_id ELSE i.assignee_user_id END) = ${params.userId ?? null}
        )
      ORDER BY r.updated_at DESC, s.position_key ASC, i.position_key ASC
      LIMIT ${limit}
    `;
  }

  async getOperationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<RunbookOperationRow | null> {
    const rows = await this.sql<RunbookOperationRow[]>`
      SELECT *
      FROM runbook_operations
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return rows[0] ? normalizeOperation(rows[0]) : null;
  }

  async listOperations(runbookId: string, limit = 50): Promise<RunbookOperationRow[]> {
    return (
      await this.sql<RunbookOperationRow[]>`
        SELECT *
        FROM runbook_operations
        WHERE runbook_id = ${runbookId}
        ORDER BY created_at DESC
        LIMIT ${Math.min(Math.max(limit, 1), 200)}
      `
    ).map(normalizeOperation);
  }

  async listAgentSubscriberSessionIds(runbookId: string): Promise<string[]> {
    const rows = await this.sql<Array<{ actor_session_id: string }>>`
      SELECT DISTINCT actor_session_id
      FROM runbook_operations
      WHERE runbook_id = ${runbookId}
        AND actor_kind = 'agent'
        AND actor_session_id IS NOT NULL
      ORDER BY actor_session_id ASC
    `;
    return rows.map((row) => row.actor_session_id);
  }

  async createRunbookTx(
    sql: RepositorySql,
    params: {
      id: string;
      boardItemId: string;
      title: string;
      createdSessionId: string | null;
      createdEventId: number;
    },
  ): Promise<RunbookRow> {
    const rows = await sql<RunbookRow[]>`
      INSERT INTO runbooks (id, board_item_id, title, created_session_id, created_event_id)
      VALUES (
        ${params.id},
        ${params.boardItemId},
        ${params.title},
        ${params.createdSessionId},
        ${params.createdEventId}
      )
      RETURNING *
    `;
    return requireOne(rows, "createRunbookTx");
  }

  async createRunbookBoardItemTx(
    sql: RepositorySql,
    params: {
      id: string;
      folderId: string;
      itemId: string;
      title: string;
      x: number;
      y: number;
    },
  ): Promise<void> {
    await sql`
      INSERT INTO board_items (id, folder_id, item_type, item_id, x, y, metadata)
      VALUES (
        ${params.id},
        ${params.folderId},
        'runbook',
        ${params.itemId},
        ${params.x},
        ${params.y},
        ${sql.json(asPostgresJsonValue({ title: params.title }))}::jsonb
      )
    `;
    await sql`
      DELETE FROM board_yjs_catalog_cache
      WHERE folder_id = ${params.folderId}
    `;
  }

  async patchRunbookBoardItemTitleTx(
    sql: RepositorySql,
    runbookId: string,
    title: string,
  ): Promise<void> {
    await sql`
      UPDATE board_items
      SET metadata = jsonb_set(metadata, '{title}', to_jsonb(${title}::text), true),
          updated_at = NOW()
      WHERE id = (
        SELECT board_item_id
        FROM runbooks
        WHERE id = ${runbookId}
      )
    `;
    await sql`
      DELETE FROM board_yjs_catalog_cache
      WHERE folder_id IN (
        SELECT bi.folder_id
        FROM board_items bi
        JOIN runbooks r ON r.board_item_id = bi.id
        WHERE r.id = ${runbookId}
      )
    `;
  }

  async patchRunbookTx(
    sql: RepositorySql,
    runbookId: string,
    fields: RunbookPatch,
    expectedVersion: number,
  ): Promise<RunbookRow> {
    await this.assertVersionTx(sql, "runbook", runbookId, expectedVersion);
    const clean = cleanPatch(fields);
    const rows = await sql<RunbookRow[]>`
      UPDATE runbooks
      SET ${sql(clean)},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${runbookId}
      RETURNING *
    `;
    return requireOne(rows, "patchRunbookTx");
  }

  async setRunbookStatusTx(
    sql: RepositorySql,
    params: {
      runbookId: string;
      status: RunbookStatus;
      expectedVersion: number;
      actorKind: RunbookOperationActorKind;
      actorSessionId: string | null;
      actorUserId: string | null;
      eventId: number;
    },
  ): Promise<RunbookRow> {
    await this.assertVersionTx(sql, "runbook", params.runbookId, params.expectedVersion);
    const completedKind =
      params.status === "completed" && params.actorKind !== "system"
        ? params.actorKind
        : null;
    const rows = await sql<RunbookRow[]>`
      UPDATE runbooks
      SET status = ${params.status},
          completed_kind = ${completedKind},
          completed_session_id = ${params.status === "completed" ? params.actorSessionId : null},
          completed_event_id = ${params.status === "completed" ? params.eventId : null},
          completed_user_id = ${params.status === "completed" ? params.actorUserId : null},
          completed_at = ${params.status === "completed" ? new Date() : null},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${params.runbookId}
      RETURNING *
    `;
    return requireOne(rows, "setRunbookStatusTx");
  }

  async createSectionTx(
    sql: RepositorySql,
    params: {
      id: string;
      runbookId: string;
      title: string;
      positionKey: string;
      assignee: RunbookAssigneeFields;
      actorSessionId: string | null;
      eventId: number;
    },
  ): Promise<RunbookSectionRow> {
    const rows = await sql<RunbookSectionRow[]>`
      INSERT INTO runbook_sections (
        id, runbook_id, position_key, title,
        assignee_kind, assignee_agent_id, assignee_session_id, assignee_user_id,
        created_session_id, created_event_id, updated_session_id, updated_event_id
      )
      VALUES (
        ${params.id}, ${params.runbookId}, ${params.positionKey}, ${params.title},
        ${params.assignee.assignee_kind}, ${params.assignee.assignee_agent_id},
        ${params.assignee.assignee_session_id}, ${params.assignee.assignee_user_id},
        ${params.actorSessionId}, ${params.eventId}, ${params.actorSessionId}, ${params.eventId}
      )
      RETURNING *
    `;
    return requireOne(rows, "createSectionTx");
  }

  async patchSectionTx(
    sql: RepositorySql,
    sectionId: string,
    fields: SectionPatch,
    expectedVersion: number,
    actorSessionId: string | null,
    eventId: number,
  ): Promise<RunbookSectionRow> {
    await this.assertVersionTx(sql, "section", sectionId, expectedVersion);
    const clean = cleanPatch(fields);
    const rows = await sql<RunbookSectionRow[]>`
      UPDATE runbook_sections
      SET ${sql(clean)},
          updated_session_id = ${actorSessionId},
          updated_event_id = ${eventId},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${sectionId}
      RETURNING *
    `;
    return requireOne(rows, "patchSectionTx");
  }

  async createItemTx(
    sql: RepositorySql,
    params: {
      id: string;
      sectionId: string;
      title: string;
      howTo: string;
      positionKey: string;
      assignee: RunbookAssigneeFields;
      actorKind: RunbookOperationActorKind;
      actorSessionId: string | null;
      actorUserId: string | null;
      eventId: number;
    },
  ): Promise<RunbookItemRow> {
    const rows = await sql<RunbookItemRow[]>`
      INSERT INTO runbook_items (
        id, section_id, position_key, title, how_to,
        assignee_kind, assignee_agent_id, assignee_session_id, assignee_user_id,
        created_session_id, created_event_id, updated_session_id, updated_event_id
      )
      VALUES (
        ${params.id}, ${params.sectionId}, ${params.positionKey}, ${params.title}, ${params.howTo},
        ${params.assignee.assignee_kind}, ${params.assignee.assignee_agent_id},
        ${params.assignee.assignee_session_id}, ${params.assignee.assignee_user_id},
        ${params.actorSessionId}, ${params.eventId}, ${params.actorSessionId}, ${params.eventId}
      )
      RETURNING *
    `;
    return requireOne(rows, "createItemTx");
  }

  async patchItemTx(
    sql: RepositorySql,
    itemId: string,
    fields: ItemPatch,
    expectedVersion: number,
    actorSessionId: string | null,
    eventId: number,
  ): Promise<RunbookItemRow> {
    await this.assertVersionTx(sql, "item", itemId, expectedVersion);
    const clean = cleanPatch(fields);
    const rows = await sql<RunbookItemRow[]>`
      UPDATE runbook_items
      SET ${sql(clean)},
          updated_session_id = ${actorSessionId},
          updated_event_id = ${eventId},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${itemId}
      RETURNING *
    `;
    return requireOne(rows, "patchItemTx");
  }

  async setItemStatusTx(
    sql: RepositorySql,
    params: {
      itemId: string;
      status: RunbookItemStatus;
      expectedVersion: number;
      actorKind: RunbookOperationActorKind;
      actorSessionId: string | null;
      actorUserId: string | null;
      eventId: number;
    },
  ): Promise<RunbookItemRow> {
    await this.assertVersionTx(sql, "item", params.itemId, params.expectedVersion);
    const completedKind =
      params.status === "completed" && params.actorKind !== "system"
        ? params.actorKind
        : null;
    const rows = await sql<RunbookItemRow[]>`
      UPDATE runbook_items
      SET status = ${params.status},
          updated_session_id = ${params.actorSessionId},
          updated_event_id = ${params.eventId},
          completed_kind = ${completedKind},
          completed_session_id = ${params.status === "completed" ? params.actorSessionId : null},
          completed_event_id = ${params.status === "completed" ? params.eventId : null},
          completed_user_id = ${params.status === "completed" ? params.actorUserId : null},
          completed_at = ${params.status === "completed" ? new Date() : null},
          updated_at = NOW(),
          version = version + 1
      WHERE id = ${params.itemId}
      RETURNING *
    `;
    return requireOne(rows, "setItemStatusTx");
  }

  async appendOperationTx(
    sql: RepositorySql,
    params: AppendRunbookOperationTxParams,
  ): Promise<RunbookOperationRow> {
    const rows = await sql<RunbookOperationRow[]>`
      INSERT INTO runbook_operations (
        id, runbook_id, target_kind, target_id, operation_type,
        actor_kind, actor_session_id, actor_event_id, actor_user_id,
        idempotency_key, payload_json, reason
      )
      VALUES (
        ${params.id}, ${params.runbookId}, ${params.targetKind}, ${params.targetId},
        ${params.operationType}, ${params.actorKind}, ${params.actorSessionId ?? null},
        ${params.actorEventId}, ${params.actorUserId ?? null}, ${params.idempotencyKey ?? null},
        ${sql.json(asPostgresJsonValue(params.payload))}::jsonb, ${params.reason ?? null}
      )
      RETURNING *
    `;
    return normalizeOperation(requireOne(rows, "appendOperationTx"));
  }

  async assertRunbookVersionTx(
    sql: RepositorySql,
    runbookId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.assertVersionTx(sql, "runbook", runbookId, expectedVersion);
  }

  async assertSectionVersionTx(
    sql: RepositorySql,
    sectionId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.assertVersionTx(sql, "section", sectionId, expectedVersion);
  }

  async assertItemVersionTx(
    sql: RepositorySql,
    itemId: string,
    expectedVersion: number,
  ): Promise<void> {
    await this.assertVersionTx(sql, "item", itemId, expectedVersion);
  }

  private async assertVersionTx(
    sql: RepositorySql,
    targetKind: RunbookOperationTargetKind,
    targetId: string,
    expectedVersion: number,
  ): Promise<void> {
    const actualVersion = await this.lockVersionTx(sql, targetKind, targetId);
    if (actualVersion !== expectedVersion) {
      throw new RunbookVersionConflict(
        targetKind,
        targetId,
        expectedVersion,
        actualVersion,
      );
    }
  }

  private async lockVersionTx(
    sql: RepositorySql,
    targetKind: RunbookOperationTargetKind,
    targetId: string,
  ): Promise<number> {
    const rows =
      targetKind === "runbook"
        ? await sql<Array<{ version: string | number }>>`
            SELECT version FROM runbooks WHERE id = ${targetId} FOR UPDATE
          `
        : targetKind === "section"
          ? await sql<Array<{ version: string | number }>>`
              SELECT version FROM runbook_sections WHERE id = ${targetId} FOR UPDATE
            `
          : await sql<Array<{ version: string | number }>>`
              SELECT version FROM runbook_items WHERE id = ${targetId} FOR UPDATE
            `;
    const version = rows[0]?.version;
    if (version === undefined) {
      throw new Error(`runbook ${targetKind} not found: ${targetId}`);
    }
    return Number(version);
  }

}
