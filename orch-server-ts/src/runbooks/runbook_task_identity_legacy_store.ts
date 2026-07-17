import type { BoardYjsQuerySql } from "../board-yjs/board_yjs_sql.js";
import type {
  LegacyRunbookBinding,
  RunbookTaskIdentityRepository,
} from "./runbook_task_identity_contracts.js";
import { insertRunbookOperation } from "./runbook_task_identity_operation_store.js";

export async function assertLegacyBinding(
  sql: BoardYjsQuerySql,
  binding: LegacyRunbookBinding,
  pageId: string,
): Promise<void> {
  const rows = await sql<readonly { version: string | number; task_page_id: string | null }[]>`
    SELECT version, task_page_id FROM runbooks
    WHERE id = ${binding.runbookId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new Error(`legacy runbook not found: ${binding.runbookId}`);
  if (Number(row.version) !== binding.runbookVersion) {
    throw new Error(`runbook version conflict: ${binding.runbookId}`);
  }
  if (row.task_page_id && row.task_page_id !== pageId) {
    throw new Error(`legacy runbook is already bound to page ${row.task_page_id}`);
  }
  const pages = await sql<readonly { exists: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pages WHERE id = ${pageId}) AS exists
  `;
  if (!pages[0]?.exists) throw new Error(`legacy binding page not found: ${pageId}`);
}

export async function persistLegacyBinding(
  sql: BoardYjsQuerySql,
  input: {
    binding: LegacyRunbookBinding;
    pageId: string;
    actor: Parameters<RunbookTaskIdentityRepository["create"]>[0]["actor"];
    idempotencyKey: string;
    operationId: string;
    eventId: number | null;
    createdPage: boolean;
    pageOperationId?: string;
  },
): Promise<Record<string, unknown>> {
  const rows = await sql<readonly Record<string, unknown>[]>`
    UPDATE runbooks
    SET task_page_id = ${input.pageId}, version = version + 1, updated_at = NOW()
    WHERE id = ${input.binding.runbookId}
      AND version = ${input.binding.runbookVersion}
    RETURNING *
  `;
  if (!rows[0]) throw new Error(`runbook version conflict: ${input.binding.runbookId}`);
  return await insertRunbookOperation(sql, {
    id: input.operationId,
    runbookId: input.binding.runbookId,
    operationType: "backfill_task_identity",
    actor: input.actor,
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    payload: {
      page_id: input.pageId,
      created_page: input.createdPage,
      ...(input.pageOperationId ? { page_operation_id: input.pageOperationId } : {}),
    },
    reason: "backfill legacy runbook task identity",
  });
}
