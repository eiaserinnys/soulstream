import type { BoardYjsSql } from "../board-yjs/board_yjs_sql.js";
import {
  assertDatabaseMutationVersion,
  commitPageMutationInTransaction,
} from "../page/page_repository.js";
import { getPageYjsDocumentName } from "../page/page_yjs_model.js";
import type {
  RunbookTaskIdentityMutationResult,
  RunbookTaskIdentityRepository,
} from "./runbook_task_identity_contracts.js";
import {
  assertTaskMountExpectation,
  commitTaskMountApplications,
} from "./runbook_task_identity_lifecycle_store.js";
import {
  appendRunbookEvent,
  findOperation,
  insertRunbookOperation,
  readResult,
  storeBoardApplication,
} from "./runbook_task_identity_operation_store.js";

export async function persistRunbookTaskPromotion(
  sql: BoardYjsSql,
  input: Parameters<RunbookTaskIdentityRepository["promote"]>[0],
): Promise<RunbookTaskIdentityMutationResult> {
  return await sql.begin(async (transaction) => {
    const lockIds = new Set([
      input.id,
      ...(input.mountPageApplications ?? []).map((application) => application.pageId),
    ]);
    for (const lockId of [...lockIds].sort()) {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockId}, 0))`;
    }
    const existing = await findOperation(transaction, input.idempotencyKey);
    if (existing) return await readResult(transaction, input.runbookId, existing, true);

    const collisions = await transaction<readonly {
      runbook_exists: boolean;
      page_exists: boolean;
    }[]>`
      SELECT
        EXISTS(SELECT 1 FROM runbooks WHERE id = ${input.runbookId}) AS runbook_exists,
        EXISTS(SELECT 1 FROM pages WHERE id = ${input.pageId}) AS page_exists
    `;
    if (collisions[0]?.runbook_exists) {
      throw new Error(`task identity runbook already exists: ${input.runbookId}`);
    }
    if (!collisions[0]?.page_exists) {
      throw new Error(`task identity source page not found: ${input.pageId}`);
    }
    await assertProjectMountContract(transaction, input);

    await storeBoardApplication(transaction, input.boardApplication);
    const pageCommitInput = {
      documentName: getPageYjsDocumentName(input.pageId),
      application: input.pageApplication,
      operationId: input.pageOperationId,
    };
    await assertDatabaseMutationVersion(transaction, pageCommitInput);
    const pageCommit = await commitPageMutationInTransaction(transaction, pageCommitInput);
    const mountCommits = await commitTaskMountApplications(
      transaction,
      input.mountPageApplications ?? [],
    );
    const eventId = await appendRunbookEvent(transaction, {
      actor: input.actor,
      operationId: input.operationId,
      operationType: "create_runbook",
      runbookId: input.runbookId,
      idempotencyKey: input.idempotencyKey,
    });
    await transaction`
      INSERT INTO runbooks (
        id, board_item_id, task_page_id, title, archived,
        created_session_id, created_event_id
      ) VALUES (
        ${input.runbookId}, ${input.boardItemId}, ${input.taskPageId}, ${input.title},
        ${input.pageApplication.replica.page.archived},
        ${input.actor.actorSessionId ?? null}, ${eventId}
      )
    `;
    const operation = await insertRunbookOperation(transaction, {
      id: input.operationId,
      runbookId: input.runbookId,
      operationType: "create_runbook",
      actor: input.actor,
      eventId,
      idempotencyKey: input.idempotencyKey,
      payload: {
        id: input.id,
        page_id: input.pageId,
        board_item_id: input.boardItemId,
        folder_id: input.folderId,
        title: input.title,
        promoted_existing_page: true,
        page_operation_id: pageCommit.operation.id,
        ...(input.expectedProjectPageId
          ? { project_page_id: input.expectedProjectPageId }
          : {}),
        ...(mountCommits.length > 0
          ? { mount_page_operation_ids: mountCommits.map((commit) => commit.operation.id) }
          : {}),
      },
      reason: "promote page to runbook task identity",
    });
    return await readResult(transaction, input.runbookId, operation, false, pageCommit);
  });
}

async function assertProjectMountContract(
  transaction: Parameters<Parameters<BoardYjsSql["begin"]>[0]>[0],
  input: Parameters<RunbookTaskIdentityRepository["promote"]>[0],
): Promise<void> {
  if (input.expectedProjectPageId === undefined) return;
  if (!input.mountExpectation) {
    throw new Error("task identity project mount expectation is missing");
  }
  const folders = await transaction<readonly {
    project_page_id: string | null;
    archived: boolean;
  }[]>`
    SELECT project_page_id, archived
    FROM folders
    WHERE id = ${input.folderId}
    FOR UPDATE
  `;
  const folder = folders[0];
  if (!folder || folder.archived) {
    throw new Error(`task identity folder not found: ${input.folderId}`);
  }
  if (folder.project_page_id !== input.expectedProjectPageId) {
    throw new Error(`task identity project mapping changed: ${input.folderId}`);
  }
  if ((input.mountPageApplications ?? []).some(
    (application) => application.pageId !== input.expectedProjectPageId,
  )) {
    throw new Error("task identity project mount application is invalid");
  }
  await assertTaskMountExpectation(transaction, input.pageId, input.mountExpectation);
}
