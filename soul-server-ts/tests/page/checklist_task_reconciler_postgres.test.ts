import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardYjsService } from "../../src/collaboration/board_yjs_service.js";
import { SessionDB } from "../../src/db/session_db.js";
import { ChecklistTaskAdapter } from "../../src/page/checklist_task_adapter.js";
import { ChecklistTaskReconciler } from "../../src/page/checklist_task_reconciler.js";
import { composeChecklistTaskProjection } from "../../src/runtime/checklist_task_composition.js";
import { TaskService } from "../../src/work-task/task_service.js";
import {
  createTaskPostgresHarness,
  hasTaskPostgresBackend,
  resetTaskData,
  type TaskPostgresHarness,
} from "../work-task/task_postgres_harness.js";

const describePostgres = hasTaskPostgresBackend ? describe : describe.skip;

describePostgres("checklist production projection PostgreSQL integration", () => {
  let harness: TaskPostgresHarness | undefined;
  let db: SessionDB;
  let boardYjsService: BoardYjsService | undefined;
  let service: TaskService;

  beforeAll(async () => {
    harness = await createTaskPostgresHarness();
    db = new SessionDB(harness.sql);
  }, 45_000);

  beforeEach(async () => {
    await boardYjsService?.close();
    await resetTaskData(harness!.sql);
    boardYjsService = createTestBoardYjsService(db);
    service = new TaskService(
      db,
      { emitTaskUpdated: vi.fn(async () => undefined) },
      boardYjsService,
      { notifyHumanHandoff: vi.fn() },
    );
  }, 15_000);

  afterAll(async () => {
    await boardYjsService?.close();
    await harness?.cleanup();
  }, 15_000);

  it("recovers a partial failure after restart and remains safe under replay, toggle, delete, and recreate", async () => {
    await harness!.sql`
      INSERT INTO pages (id, title, version, metadata)
      VALUES ('page-1', 'Project', 1, '{"legacyFolderId":"folder-1"}'::jsonb)
    `;
    await enqueue("reconcile:legacy");

    let currentBlock: ReturnType<typeof checklistBlock> | null = checklistBlock({ checked: true });
    let pageVersion = 1;
    let failReferenceWrite = true;
    const batchPageOperations = vi.fn(async (input: Record<string, unknown>) => {
      if (failReferenceWrite) {
        failReferenceWrite = false;
        throw new Error("temporary page host failure");
      }
      const operation = (input.operations as Array<{
        properties: Record<string, unknown>;
      }>)[0]!;
      currentBlock = checklistBlock(operation.properties);
      pageVersion += 1;
      return {
        page: pageDto(pageVersion),
        blocks: [currentBlock],
        temp_id_mapping: {},
        operation: {},
      };
    });
    const pageHost = {
      getPage: vi.fn(async () => ({
        page: pageDto(pageVersion),
        blocks: currentBlock ? [currentBlock] : [],
      })),
      batchPageOperations,
    };
    const logger = { warn: vi.fn(), info: vi.fn() };

    const firstProcess = createReconciler(pageHost, logger);
    await firstProcess.reconcileDue();
    const afterFailure = await readOutbox();
    expect(afterFailure).toMatchObject({
      attempts: 1,
      processed_hash: null,
      last_error: "temporary page host failure",
    });
    await expect(service.getTask("page-1")).resolves.toMatchObject({
      items: [expect.objectContaining({ status: "completed", archived: false })],
    });

    await harness!.sql`
      UPDATE checklist_task_projection_outbox
      SET next_retry_at = NOW() - INTERVAL '1 second'
      WHERE block_id = 'block-1'
    `;
    const restartedProcess = createReconciler(pageHost, logger);
    await restartedProcess.reconcileDue();
    expect(currentBlock?.properties).toEqual({
      taskId: "page-1",
      itemId: "checklist:block-1",
    });
    expect(await readOutbox()).toMatchObject({
      processed_hash: "reconcile:legacy",
      attempts: 0,
      last_error: null,
    });
    const writesAfterRecovery = batchPageOperations.mock.calls.length;
    await restartedProcess.reconcileDue();
    expect(batchPageOperations).toHaveBeenCalledTimes(writesAfterRecovery);

    const existingIdentity = { promoteExistingPage: vi.fn() };
    const leftAdapter = new ChecklistTaskAdapter(service, existingIdentity);
    const rightAdapter = new ChecklistTaskAdapter(service, existingIdentity);
    await Promise.all([
      leftAdapter.toggle({
        taskId: "page-1",
        itemId: "checklist:block-1",
        actor: { actorKind: "agent", actorSessionId: "sess-actor" },
        idempotencyKey: "toggle:left",
      }),
      rightAdapter.toggle({
        taskId: "page-1",
        itemId: "checklist:block-1",
        actor: { actorKind: "agent", actorSessionId: "sess-actor" },
        idempotencyKey: "toggle:right",
      }),
    ]);
    await expect(service.getTask("page-1")).resolves.toMatchObject({
      items: [expect.objectContaining({ status: "completed" })],
    });

    currentBlock = null;
    await enqueue("archive:block-1");
    await createReconciler(pageHost, logger).reconcileDue();
    await expect(service.getTask("page-1")).resolves.toMatchObject({
      items: [expect.objectContaining({ archived: true })],
    });

    currentBlock = checklistBlock({});
    currentBlock.text = "Recreated task";
    await enqueue("reconcile:recreated");
    await createReconciler(pageHost, logger).reconcileDue();
    await expect(service.getTask("page-1")).resolves.toMatchObject({
      items: [expect.objectContaining({
        title: "Recreated task",
        archived: false,
        status: "completed",
      })],
    });
    expect(currentBlock.properties).toEqual({
      taskId: "page-1",
      itemId: "checklist:block-1",
    });
  }, 30_000);

  function createReconciler(
    pageHost: {
      getPage: ReturnType<typeof vi.fn>;
      batchPageOperations: ReturnType<typeof vi.fn>;
    },
    logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> },
  ): ChecklistTaskReconciler {
    return composeChecklistTaskProjection({
      nodeId: "node-1",
      db,
      taskService: service,
      taskIdentityHost: {
        promoteExistingPage: vi.fn(async (input) => {
          await service.createTask({
            actorKind: input.actorKind,
            actorSessionId: input.actorSessionId,
            actorUserId: input.actorUserId,
            taskId: input.pageId,
            folderId: input.folderId,
            title: input.title,
            enrollCreator: false,
            idempotencyKey: input.idempotencyKey,
          });
          return {
            id: input.pageId,
            pageId: input.pageId,
            taskId: input.pageId,
          } as never;
        }),
      },
      pageHost: pageHost as never,
      logger: logger as never,
    }).checklistTaskReconciler;
  }

  async function enqueue(sourceHash: string): Promise<void> {
    await harness!.sql`
      INSERT INTO checklist_task_projection_outbox (
        block_id, page_id, source_hash,
        actor_kind, actor_session_id, next_retry_at,
        lease_owner_node_id, lease_expires_at
      ) VALUES (
        'block-1', 'page-1', ${sourceHash},
        'agent', 'sess-actor', NOW(), NULL, NULL
      )
      ON CONFLICT (block_id) DO UPDATE
      SET source_hash = EXCLUDED.source_hash,
          next_retry_at = NOW(),
          lease_owner_node_id = NULL,
          lease_expires_at = NULL
    `;
  }

  async function readOutbox(): Promise<{
    attempts: number;
    processed_hash: string | null;
    last_error: string | null;
  }> {
    const [row] = await harness!.sql<Array<{
      attempts: number;
      processed_hash: string | null;
      last_error: string | null;
    }>>`
      SELECT attempts, processed_hash, last_error
      FROM checklist_task_projection_outbox
      WHERE block_id = 'block-1'
    `;
    return row!;
  }
});

function pageDto(version: number) {
  return {
    id: "page-1",
    title: "Project",
    daily_date: null,
    version,
    archived: false,
    metadata: { legacyFolderId: "folder-1" },
    created_at: "2026-07-13T00:00:00.000Z",
    updated_at: "2026-07-13T00:00:00.000Z",
  };
}

function checklistBlock(properties: Record<string, unknown>) {
  return {
    id: "block-1",
    page_id: "page-1",
    parent_id: null,
    position_key: "a",
    block_type: "checklist" as const,
    text: "Ship it",
    properties,
    collapsed: false,
  };
}

function createTestBoardYjsService(db: SessionDB): BoardYjsService {
  return new BoardYjsService({
    db,
    logger: createSilentLogger() as never,
    nodeId: "test-node",
    hostNodeId: "test-node",
    isHost: true,
    auth: {
      authBearerToken: "",
      environment: "development",
      dashboardAuthEnabled: false,
    },
  });
}

function createSilentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => createSilentLogger(),
  };
}
