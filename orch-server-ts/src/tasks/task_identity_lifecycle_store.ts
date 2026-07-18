import type {
  BoardYjsQuerySql,
  BoardYjsSql,
} from "../board-yjs/board_yjs_sql.js";
import type {
  TaskIdentityRepository,
  TaskMountBinding,
  TaskMountExpectation,
  TaskMountPageApplication,
} from "./task_identity_contracts.js";
import { bindingRows } from "./task_identity_queries.js";
import {
  appendTaskEvent,
  findOperation,
  insertTaskOperation,
  storeBoardApplication,
} from "./task_identity_operation_store.js";
import { commitTaskProjectMount } from "./task_project_mount_store.js";
import { mountBindingsEqual } from "./task_mount_reconciliation.js";

export async function listTaskMountBindings(
  sql: BoardYjsQuerySql,
  pageId: string,
  scope: "all" | "project",
): Promise<readonly TaskMountBinding[]> {
  const rows = scope === "project"
    ? await sql<readonly MountRow[]>`
        SELECT block.page_id AS source_page_id,
               array_agg(DISTINCT block.id ORDER BY block.id) AS source_block_ids
        FROM block_links link
        JOIN blocks block ON block.id = link.source_block_id
        WHERE link.target_page_id = ${pageId}
          AND link.link_kind = 'mount'
          AND EXISTS (
            SELECT 1 FROM folders folder
            WHERE folder.project_page_id = block.page_id
          )
        GROUP BY block.page_id
        ORDER BY block.page_id
      `
    : await sql<readonly MountRow[]>`
        SELECT block.page_id AS source_page_id,
               array_agg(DISTINCT block.id ORDER BY block.id) AS source_block_ids
        FROM block_links link
        JOIN blocks block ON block.id = link.source_block_id
        WHERE link.target_page_id = ${pageId}
          AND link.link_kind = 'mount'
        GROUP BY block.page_id
        ORDER BY block.page_id
      `;
  return rows.map((row) => ({
    sourcePageId: row.source_page_id,
    sourceBlockIds: [...row.source_block_ids],
  }));
}

export async function commitTaskMountApplications(
  transaction: BoardYjsQuerySql,
  applications: readonly TaskMountPageApplication[],
) {
  const commits = [];
  for (const item of [...applications].sort((left, right) => (
    left.pageId < right.pageId ? -1 : left.pageId > right.pageId ? 1 : 0
  ))) {
    commits.push(await commitTaskProjectMount(transaction, item));
  }
  return commits;
}

export async function assertTaskMountExpectation(
  transaction: BoardYjsQuerySql,
  taskPageId: string,
  expectation?: TaskMountExpectation,
): Promise<void> {
  if (!expectation) return;
  const current = await listTaskMountBindings(transaction, taskPageId, expectation.scope);
  if (!mountBindingsEqual(current, expectation.bindings)) {
    throw new Error(`task mount projection changed: ${taskPageId}`);
  }
}

export async function persistTaskProjectMove(
  sql: BoardYjsSql,
  input: Parameters<TaskIdentityRepository["move"]>[0],
): Promise<void> {
  await sql.begin(async (transaction) => {
    const lockIds = new Set([
      input.binding.taskId,
      ...input.mountPageApplications.map((item) => item.pageId),
    ]);
    for (const lockId of [...lockIds].sort()) {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${lockId}, 0))`;
    }
    if (await findOperation(transaction, input.idempotencyKey)) return;

    const locked = (await bindingRows(
      transaction,
      "task",
      input.binding.taskId,
      true,
    ))[0];
    if (!locked || locked.pageId !== input.binding.pageId) {
      throw new Error(`task identity mapping changed: ${input.binding.taskId}`);
    }
    if (locked.folderId !== input.sourceFolderId) {
      throw new Error(`task identity source folder changed: ${input.binding.taskId}`);
    }
    if (locked.taskVersion !== input.binding.taskVersion) {
      throw new Error(`task version conflict: ${input.binding.taskId}`);
    }
    const folders = new Map<string, { project_page_id: string | null; archived: boolean }>();
    for (const folderId of [input.sourceFolderId, input.targetFolderId].sort()) {
      const rows = await transaction<readonly {
        project_page_id: string | null;
        archived: boolean;
      }[]>`
        SELECT project_page_id, archived
        FROM folders
        WHERE id = ${folderId}
        FOR UPDATE
      `;
      if (!rows[0]) throw new Error(`task identity folder not found: ${folderId}`);
      folders.set(folderId, rows[0]);
    }
    const target = folders.get(input.targetFolderId);
    if (!target || target.archived) {
      throw new Error(`task identity target folder not found: ${input.targetFolderId}`);
    }
    if (target.project_page_id !== input.expectedTargetProjectPageId) {
      throw new Error(`task identity project mapping changed: ${input.targetFolderId}`);
    }
    await assertTaskMountExpectation(transaction, input.binding.pageId, input.mountExpectation);
    assertBoardMoveApplications(input);

    const orderedBoardApplications = [...input.boardApplications].sort((left, right) => {
      if (left.scope.folderId === input.targetFolderId) return -1;
      if (right.scope.folderId === input.targetFolderId) return 1;
      return left.documentName < right.documentName ? -1 : 1;
    });
    for (const application of orderedBoardApplications) {
      await storeBoardApplication(transaction, application);
    }
    const mountCommits = await commitTaskMountApplications(
      transaction,
      input.mountPageApplications,
    );
    const eventId = await appendTaskEvent(transaction, {
      actor: input.actor,
      operationId: input.operationId,
      operationType: "update_task",
      taskId: input.binding.taskId,
      idempotencyKey: input.idempotencyKey,
    });
    const updated = await transaction<readonly { id: string }[]>`
      UPDATE tasks
      SET version = version + 1, updated_at = NOW()
      WHERE id = ${input.binding.taskId}
        AND version = ${input.binding.taskVersion}
      RETURNING id
    `;
    if (!updated[0]) throw new Error(`task version conflict: ${input.binding.taskId}`);
    await insertTaskOperation(transaction, {
      id: input.operationId,
      taskId: input.binding.taskId,
      operationType: "update_task",
      actor: input.actor,
      eventId,
      idempotencyKey: input.idempotencyKey,
      payload: {
        page_id: input.binding.pageId,
        source_folder_id: input.sourceFolderId,
        target_folder_id: input.targetFolderId,
        project_page_id: input.expectedTargetProjectPageId,
        mount_page_operation_ids: mountCommits.map((commit) => commit.operation.id),
      },
      reason: "move task identity between projects",
    });
  });
}

function assertBoardMoveApplications(
  input: Parameters<TaskIdentityRepository["move"]>[0],
): void {
  const expected = new Set([input.sourceFolderId, input.targetFolderId]);
  const actual = new Set(input.boardApplications.map((application) => {
    if (application.scope.containerKind !== "folder"
      || application.scope.containerId !== application.scope.folderId) {
      throw new Error("task identity board move requires folder board applications");
    }
    return application.scope.folderId;
  }));
  if (input.boardApplications.length !== 2
    || actual.size !== 2
    || [...expected].some((folderId) => !actual.has(folderId))) {
    throw new Error("task identity board move applications are incomplete");
  }
}

interface MountRow extends Record<string, unknown> {
  source_page_id: string;
  source_block_ids: string[];
}
