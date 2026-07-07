import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CatalogBoardItemService } from "../../src/catalog/catalog_board_item_service.js";
import { BoardYjsService } from "../../src/collaboration/board_yjs_service.js";
import { SessionDB, type SqlClient } from "../../src/db/session_db.js";
import { RunbookService } from "../../src/runbook/runbook_service.js";
import { resolveDelegatedContainer } from "../../src/session_folder_fallback.js";
import {
  createRunbookPostgresHarness,
  hasRunbookPostgresBackend,
  resetRunbookData,
  type RunbookPostgresHarness,
} from "./runbook_postgres_harness.js";

const describePostgres = hasRunbookPostgresBackend ? describe : describe.skip;

describePostgres("Runbook creator enrollment", () => {
  let harness: RunbookPostgresHarness | undefined;
  let db: SessionDB;
  let boardYjsService: BoardYjsService | undefined;
  let emitRunbookUpdated: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    harness = await createRunbookPostgresHarness();
    db = new SessionDB(harness.sql);
    emitRunbookUpdated = vi.fn();
  }, 45_000);

  beforeEach(async () => {
    if (!harness) return;
    await boardYjsService?.close();
    await resetRunbookData(harness.sql);
    boardYjsService = createTestBoardYjsService(db);
    emitRunbookUpdated.mockClear();
  }, 15_000);

  afterAll(async () => {
    await boardYjsService?.close();
    await harness?.cleanup();
  }, 15_000);

  it("enrolls the creator session into the new runbook even when its tile was not persisted", async () => {
    const service = createServiceWithCreatorEnrollment();

    await service.createRunbook({
      runbookId: "rb-created",
      folderId: "folder-1",
      title: "Created runbook",
      actorSessionId: "sess-actor",
    });

    const row = await getSessionBoardItem(harness!.sql, "sess-actor");
    expect(row).toMatchObject({
      id: "session:sess-actor",
      folder_id: "folder-1",
      container_kind: "runbook",
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
      container: { containerKind: "runbook", containerId: "rb-created" },
    });
  });

  it("moves the creator from an existing runbook primary membership to the newest runbook", async () => {
    const service = createServiceWithCreatorEnrollment();

    await service.createRunbook({
      runbookId: "rb-old",
      folderId: "folder-1",
      title: "Old runbook",
      actorSessionId: "sess-actor",
    });
    await service.createRunbook({
      runbookId: "rb-new",
      folderId: "folder-1",
      title: "New runbook",
      actorSessionId: "sess-actor",
    });

    const row = await getSessionBoardItem(harness!.sql, "sess-actor");
    expect(row).toMatchObject({
      container_kind: "runbook",
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

  it("keeps runbook creation successful and logs a warning when creator enrollment fails", async () => {
    const mover = {
      moveBoardItemToContainer: vi.fn(async () => {
        throw new Error("enrollment unavailable");
      }),
    };
    const logger = createSilentLogger();
    const service = createServiceWithCreatorEnrollment({ mover, logger });

    const result = await service.createRunbook({
      runbookId: "rb-fallback",
      folderId: "folder-1",
      title: "Fallback runbook",
      actorSessionId: "sess-actor",
    });

    expect(result.snapshot.runbook).toMatchObject({
      id: "rb-fallback",
      board_item_id: "runbook:rb-fallback",
    });
    await expect(db.runbooks().getSnapshot("rb-fallback")).resolves.toMatchObject({
      runbook: { id: "rb-fallback" },
    });
    expect(mover.moveBoardItemToContainer).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        actorSessionId: "sess-actor",
        runbookId: "rb-fallback",
      }),
      "runbook creator session enrollment failed",
    );
  });

  function createServiceWithCreatorEnrollment(params: {
    mover?: { moveBoardItemToContainer: CatalogBoardItemService["moveBoardItemToContainer"] };
    logger?: ReturnType<typeof createSilentLogger>;
  } = {}): RunbookService {
    const mover = params.mover ?? new CatalogBoardItemService(
      db,
      boardYjsService,
      async () => undefined,
    );
    return new RunbookService(
      db,
      { emitRunbookUpdated },
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
