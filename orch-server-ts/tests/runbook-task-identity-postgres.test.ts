import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  RunbookTaskIdentityBoardApplication,
  RunbookTaskIdentityBoardPort,
} from "../src/runbooks/runbook_task_identity_service.js";
import { RunbookTaskIdentityService } from "../src/runbooks/runbook_task_identity_service.js";
import { SqlRunbookTaskIdentityRepository } from "../src/runbooks/runbook_task_identity_repository.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page/page_postgres_harness.js";

describe("Runbook task identity PostgreSQL transaction", () => {
  let harness: PagePostgresHarness;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    await harness.sql`INSERT INTO folders (id, name) VALUES ('folder-a', 'Folder A')`;
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("commits one UUID across page, runbook, board projection, and primary reference", async () => {
    const id = "00000000-0000-4000-8000-0000000000ae";
    const board = new TransactionBoardPort();
    const service = createService(board, id, ["runbook-op-a", "page-op-a"]);

    await expect(service.create({
      title: "원자 업무",
      description: "하나의 정체성",
      folderId: "folder-a",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "task-identity:create:success",
    })).resolves.toMatchObject({ id, pageId: id, runbookId: id });

    const rows = await harness.sql<Array<{
      runbook_id: string;
      task_page_id: string;
      board_item_id: string;
      page_id: string;
      reference_runbook_id: string;
    }>>`
      SELECT r.id AS runbook_id, r.task_page_id, r.board_item_id,
             p.id AS page_id, b.properties->>'runbookId' AS reference_runbook_id
      FROM runbooks r
      JOIN pages p ON p.id = r.task_page_id
      JOIN blocks b ON b.page_id = p.id
        AND b.block_type = 'runbook_ref'
        AND b.properties->>'primary' = 'true'
      WHERE r.id = ${id}
    `;
    expect(rows).toEqual([{
      runbook_id: id,
      task_page_id: id,
      board_item_id: `runbook:${id}`,
      page_id: id,
      reference_runbook_id: id,
    }]);
    expect(board.liveApplied).toBe(true);

    await service.mutateFromRunbook({
      runbookId: id,
      expectedVersion: 1,
      title: "이름이 바뀐 업무",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "task-identity:rename:runbook-surface",
    });
    await service.mutateFromPage({
      pageId: id,
      expectedVersion: 2,
      command: { type: "archive_page" },
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey: "task-identity:archive:page-surface",
    });
    const synchronized = await harness.sql<Array<{
      runbook_title: string;
      page_title: string;
      runbook_archived: boolean;
      page_archived: boolean;
    }>>`
      SELECT r.title AS runbook_title, p.title AS page_title,
             r.archived AS runbook_archived, p.archived AS page_archived
      FROM runbooks r JOIN pages p ON p.id = r.task_page_id
      WHERE r.id = ${id}
    `;
    expect(synchronized[0]).toEqual({
      runbook_title: "이름이 바뀐 업무",
      page_title: "이름이 바뀐 업무",
      runbook_archived: true,
      page_archived: true,
    });
  });

  it("rolls back board, page, and runbook records together when provenance fails", async () => {
    const id = "00000000-0000-4000-8000-0000000000af";
    const board = new TransactionBoardPort();
    const service = createService(board, id, ["runbook-op-b", "page-op-b"]);

    await expect(service.create({
      title: "롤백 업무",
      folderId: "folder-a",
      actor: { actorKind: "agent", actorSessionId: "missing-session" },
      idempotencyKey: "task-identity:create:rollback",
    })).rejects.toThrow();

    const rows = await harness.sql<Array<{ pages: number; runbooks: number; board_items: number }>>`
      SELECT
        (SELECT COUNT(*)::int FROM pages WHERE id = ${id}) AS pages,
        (SELECT COUNT(*)::int FROM runbooks WHERE id = ${id}) AS runbooks,
        (SELECT COUNT(*)::int FROM board_items WHERE id = ${`runbook:${id}`}) AS board_items
    `;
    expect(rows[0]).toEqual({ pages: 0, runbooks: 0, board_items: 0 });
    expect(board.liveApplied).toBe(false);
  });

  it("recovers the original UUID when a create response is lost and retried", async () => {
    const committedId = "00000000-0000-4000-8000-0000000000b0";
    const discardedRetryId = "00000000-0000-4000-8000-0000000000b1";
    const idempotencyKey = "task-identity:create:response-loss";
    const firstBoard = new TransactionBoardPort();
    const firstService = createService(firstBoard, committedId, ["runbook-op-c", "page-op-c"]);

    await firstService.create({
      title: "응답 유실 업무",
      folderId: "folder-a",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey,
    });

    const retryBoard = new TransactionBoardPort();
    const retryService = createService(
      retryBoard,
      discardedRetryId,
      ["runbook-op-d", "page-op-d"],
    );
    await expect(retryService.create({
      title: "응답 유실 업무",
      folderId: "folder-a",
      actor: { actorKind: "user", actorUserId: "user@example.com" },
      idempotencyKey,
    })).resolves.toMatchObject({
      id: committedId,
      pageId: committedId,
      runbookId: committedId,
      idempotent: true,
    });

    const counts = await harness.sql<Array<{ runbooks: number; pages: number }>>`
      SELECT
        (SELECT COUNT(*)::int FROM runbooks
          WHERE id IN (${committedId}, ${discardedRetryId})) AS runbooks,
        (SELECT COUNT(*)::int FROM pages
          WHERE id IN (${committedId}, ${discardedRetryId})) AS pages
    `;
    expect(counts[0]).toEqual({ runbooks: 1, pages: 1 });
    expect(retryBoard.liveApplied).toBe(false);
  });

  it("keeps a legacy runbook bound to the first backfill page across retries", async () => {
    const runbookId = "legacy-runbook-ae";
    const firstPageId = "00000000-0000-4000-8000-0000000000b2";
    const discardedRetryPageId = "00000000-0000-4000-8000-0000000000b3";
    const boardItemId = `runbook:${runbookId}`;
    await harness.sql`
      INSERT INTO board_items (
        id, folder_id, container_kind, container_id, membership_kind,
        item_type, item_id, metadata
      ) VALUES (
        ${boardItemId}, 'folder-a', 'folder', 'folder-a', 'primary',
        'runbook', ${runbookId}, ${harness.sql.json({ title: "기존 런북" })}::jsonb
      )
    `;
    await harness.sql`
      INSERT INTO runbooks (id, board_item_id, title)
      VALUES (${runbookId}, ${boardItemId}, '기존 런북')
    `;
    const idempotencyKey = "task-identity:backfill:response-loss";
    const firstService = createService(
      new TransactionBoardPort(),
      firstPageId,
      ["runbook-op-e", "page-op-e"],
    );
    await expect(firstService.backfillLegacyRunbook({
      runbookId,
      actor: { actorKind: "system" },
      idempotencyKey,
    })).resolves.toMatchObject({ runbookId, pageId: firstPageId, createdPage: true });

    const retryService = createService(
      new TransactionBoardPort(),
      discardedRetryPageId,
      ["runbook-op-f", "page-op-f"],
    );
    await expect(retryService.backfillLegacyRunbook({
      runbookId,
      actor: { actorKind: "system" },
      idempotencyKey,
    })).resolves.toMatchObject({
      runbookId,
      pageId: firstPageId,
      createdPage: true,
      idempotent: true,
    });

    const bindings = await harness.sql<Array<{
      task_page_id: string;
      created_pages: number;
      reference_runbook_id: string;
    }>>`
      SELECT r.task_page_id,
             (SELECT COUNT(*)::int FROM pages
               WHERE id IN (${firstPageId}, ${discardedRetryPageId})) AS created_pages,
             b.properties->>'runbookId' AS reference_runbook_id
      FROM runbooks r
      JOIN blocks b ON b.page_id = r.task_page_id
        AND b.block_type = 'runbook_ref'
        AND b.properties->>'primary' = 'true'
      WHERE r.id = ${runbookId}
    `;
    expect(bindings).toEqual([{
      task_page_id: firstPageId,
      created_pages: 1,
      reference_runbook_id: runbookId,
    }]);
  });

  function createService(
    board: TransactionBoardPort,
    id: string,
    operationIds: string[],
  ): RunbookTaskIdentityService {
    return new RunbookTaskIdentityService({
      board,
      repository: new SqlRunbookTaskIdentityRepository(
        createLiveDbSqlResolver({ sql: harness.liveSql }),
      ),
      createId: () => id,
      createOperationId: () => operationIds.shift() ?? randomUUID(),
      hydratePage: async () => undefined,
    });
  }
});

class TransactionBoardPort implements RunbookTaskIdentityBoardPort {
  liveApplied = false;

  async withRunbookBoardApplication<T>(
    input: Parameters<RunbookTaskIdentityBoardPort["withRunbookBoardApplication"]>[0],
    persist: (application: RunbookTaskIdentityBoardApplication) => Promise<T>,
  ): Promise<T> {
    const result = await persist({
      documentName: `board-folder:${input.folderId}`,
      scope: {
        folderId: input.folderId,
        containerKind: "folder",
        containerId: input.folderId,
      },
      snapshot: new Uint8Array([1, 2, 3]),
      replica: {
        boardItems: [{
          id: input.boardItemId,
          folderId: input.folderId,
          containerKind: "folder",
          containerId: input.folderId,
          membershipKind: "primary",
          sourceRunbookItemId: null,
          itemType: "runbook",
          itemId: input.runbookId,
          x: input.x,
          y: input.y,
          metadata: { title: input.title, archived: input.archived },
        }],
        markdownDocuments: [],
      },
    });
    this.liveApplied = true;
    return result;
  }
}
