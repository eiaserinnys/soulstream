import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CatalogBoardItemService } from "../../src/catalog/catalog_board_item_service.js";
import { BoardYjsService } from "../../src/collaboration/board_yjs_service.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import { TaskService } from "../../src/work-task/task_service.js";
import { resolveDelegatedContainer } from "../../src/session_folder_fallback.js";
import {
  createTaskPostgresHarness,
  hasTaskPostgresBackend,
  resetTaskData,
  type TaskPostgresHarness,
} from "./task_postgres_harness.js";

const describePostgres = hasTaskPostgresBackend ? describe : describe.skip;

describePostgres("Task creator enrollment", () => {
  let harness: TaskPostgresHarness | undefined;
  let db: SessionDB;
  let boardYjsService: BoardYjsService | undefined;
  let emitTaskUpdated: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    harness = await createTaskPostgresHarness();
    db = new SessionDB(harness.sql);
    emitTaskUpdated = vi.fn();
  }, 45_000);

  beforeEach(async () => {
    if (!harness) return;
    await boardYjsService?.close();
    await resetTaskData(harness.sql);
    boardYjsService = createTestBoardYjsService(db);
    emitTaskUpdated.mockClear();
  }, 15_000);

  afterAll(async () => {
    await boardYjsService?.close();
    await harness?.cleanup();
  }, 15_000);

  it("enrolls the creator session into the new task even when its tile was not persisted", async () => {
    const service = createServiceWithCreatorEnrollment();

    await service.createTask({
      taskId: "rb-created",
      folderId: "folder-1",
      title: "Created task",
      actorSessionId: "sess-actor",
    });

    const row = await getSessionBoardItem(harness!.sql, "sess-actor");
    expect(row).toMatchObject({
      id: "session:sess-actor",
      folder_id: "folder-1",
      container_kind: "task",
      container_id: "rb-created",
      membership_kind: "primary",
      item_type: "session",
      item_id: "sess-actor",
    });
    expect(Number(row?.x)).toBe(0);
    expect(Number(row?.y)).toBe(0);

    await expect(
      resolveDelegatedContainer(
        { db, logger: createSilentLogger() as never },
        { callerSessionId: "sess-actor" },
      ),
    ).resolves.toEqual({
      folderId: "folder-1",
      container: { containerKind: "task", containerId: "rb-created" },
    });
  });

  it("moves the creator from an existing task primary membership to the newest task", async () => {
    const service = createServiceWithCreatorEnrollment();

    await service.createTask({
      taskId: "rb-old",
      folderId: "folder-1",
      title: "Old task",
      actorSessionId: "sess-actor",
    });
    await service.createTask({
      taskId: "rb-new",
      folderId: "folder-1",
      title: "New task",
      actorSessionId: "sess-actor",
    });

    const row = await getSessionBoardItem(harness!.sql, "sess-actor");
    expect(row).toMatchObject({
      container_kind: "task",
      container_id: "rb-new",
      item_id: "sess-actor",
    });

    const countRows = await harness!.sql<Array<{ count: string | number }>>`
      SELECT COUNT(*)::int AS count
      FROM board_items
      WHERE item_type = 'session' AND item_id = 'sess-actor'
    `;
    expect(Number(countRows[0]?.count)).toBe(1);
  });

  it("allows a page-backed task to skip creator-session enrollment", async () => {
    const mover = { moveBoardItemToContainer: vi.fn(async () => undefined) };
    const service = createServiceWithCreatorEnrollment({ mover });

    await service.createTask({
      taskId: "page-task:page-1",
      folderId: "folder-1",
      title: "Page task",
      actorSessionId: "sess-actor",
      enrollCreator: false,
    });

    expect(mover.moveBoardItemToContainer).not.toHaveBeenCalled();
    await expect(db.tasks().getSnapshot("page-task:page-1")).resolves.toMatchObject({
      task: { id: "page-task:page-1" },
    });
  });

  it("keeps task creation successful and logs a warning when creator enrollment fails", async () => {
    const mover = {
      moveBoardItemToContainer: vi.fn(async () => {
        throw new Error("enrollment unavailable");
      }),
    };
    const logger = createSilentLogger();
    const service = createServiceWithCreatorEnrollment({ mover, logger });

    const result = await service.createTask({
      taskId: "rb-fallback",
      folderId: "folder-1",
      title: "Fallback task",
      actorSessionId: "sess-actor",
    });

    expect(result.snapshot.task).toMatchObject({
      id: "rb-fallback",
      board_item_id: "task:rb-fallback",
    });
    await expect(db.tasks().getSnapshot("rb-fallback")).resolves.toMatchObject({
      task: { id: "rb-fallback" },
    });
    expect(mover.moveBoardItemToContainer).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        actorSessionId: "sess-actor",
        taskId: "rb-fallback",
      }),
      "task creator session enrollment failed",
    );
  });

  function createServiceWithCreatorEnrollment(params: {
    mover?: { moveBoardItemToContainer: CatalogBoardItemService["moveBoardItemToContainer"] };
    logger?: ReturnType<typeof createSilentLogger>;
  } = {}): TaskService {
    const mover = params.mover ?? new CatalogBoardItemService(
      db,
      boardYjsService,
      async () => undefined,
    );
    return new TaskService(
      db,
      { emitTaskUpdated },
      boardYjsService!,
      undefined,
      mover,
      params.logger ?? createSilentLogger(),
    );
  }
});

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

async function getSessionBoardItem(sql: SqlClient, sessionId: string) {
  const rows = await sql<Array<{
    id: string;
    folder_id: string;
    container_kind: string;
    container_id: string;
    membership_kind: string;
    item_type: string;
    item_id: string;
    x: string | number;
    y: string | number;
  }>>`
    SELECT id, folder_id, container_kind, container_id, membership_kind, item_type, item_id, x, y
    FROM board_items
    WHERE id = ${`session:${sessionId}`}
  `;
  return rows[0];
}
