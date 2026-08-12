import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import * as Y from "yjs";

import { startPostgresTestContainer } from
  "../../packages/db-schema/scripts/postgres-test-container.mjs";
import { createBoardYjsPersistence } from "../src/board-yjs/board_yjs_persistence.js";
import {
  createBoardYDocSnapshot,
  readBoardYDocReplica,
} from "../src/board-yjs/board_yjs_model.js";
import { BoardYjsMoveRepository } from "../src/board-yjs/board_yjs_move_repository.js";
import { BoardYjsRepository } from "../src/board-yjs/board_yjs_repository.js";
import { BoardYjsService } from "../src/board-yjs/board_yjs_service.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import { SessionBoardMoveService } from "../src/session/session_board_move_service.js";

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const hasPostgresBackend = Boolean(process.env.TEST_DATABASE_URL?.trim()) || hasDocker;
const describePostgres = hasPostgresBackend ? describe : describe.skip;

interface FullSchemaPostgresHarness {
  sql: ReturnType<typeof postgres>;
  cleanup(): Promise<void>;
}

describePostgres("board Y.Doc bootstrap seed scope", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("seeds the requested missing document without changing another container", async () => {
    await harness.sql`
      INSERT INTO folders (id, name)
      VALUES ('seed-folder-a', 'Seed A'), ('seed-folder-b', 'Seed B')
    `;
    await harness.sql`
      INSERT INTO sessions (session_id, folder_id)
      VALUES ('seed-session-a', 'seed-folder-a'), ('seed-session-b', 'seed-folder-b')
    `;
    await harness.sql`
      INSERT INTO board_items (
        id, folder_id, container_kind, container_id, membership_kind,
        item_type, item_id, x, y, metadata
      )
      VALUES (
        'session:stale-b', 'seed-folder-b', 'folder', 'seed-folder-b', 'primary',
        'session', 'stale-b', 17, 29, '{"sentinel":true}'::jsonb
      )
    `;
    const beforeOther = await readContainerRows(harness, "seed-folder-b");
    const repository = new BoardYjsRepository(createLiveDbSqlResolver({
      sql: harness.sql as unknown as LivePostgresSql,
    }));
    const persistence = createBoardYjsPersistence(repository);

    const snapshot = await persistence.database.configuration.fetch?.({
      documentName: "board-folder:seed-folder-a",
    } as never);

    const scope = {
      folderId: "seed-folder-a",
      containerKind: "folder" as const,
      containerId: "seed-folder-a",
    };
    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot as Uint8Array);
    expect(readBoardYDocReplica(scope, doc).boardItems.map((item) => item.id))
      .toEqual(["session:seed-session-a"]);
    await expect(readContainerRows(harness, "seed-folder-a")).resolves.toEqual([
      expect.objectContaining({ id: "session:seed-session-a", item_id: "seed-session-a" }),
    ]);
    await expect(readContainerRows(harness, "seed-folder-b")).resolves.toEqual(beforeOther);
  });

  it("persists an immediate folder-session upsert to its existing Y.Doc and projection only", async () => {
    await harness.sql`
      INSERT INTO folders (id, name)
      VALUES ('instant-folder-a', 'Instant A'), ('instant-folder-b', 'Instant B')
    `;
    await harness.sql`
      INSERT INTO sessions (session_id, folder_id)
      VALUES
        ('instant-session-a', NULL),
        ('instant-session-b', 'instant-folder-b')
    `;
    const targetScope = {
      folderId: "instant-folder-a",
      containerKind: "folder" as const,
      containerId: "instant-folder-a",
    };
    const otherScope = {
      folderId: "instant-folder-b",
      containerKind: "folder" as const,
      containerId: "instant-folder-b",
    };
    const otherItem = {
      id: "session:instant-session-b",
      folderId: "instant-folder-b",
      containerKind: "folder" as const,
      containerId: "instant-folder-b",
      membershipKind: "primary" as const,
      sourceTaskItemId: null,
      itemType: "session" as const,
      itemId: "instant-session-b",
      x: 17,
      y: 29,
      metadata: { sentinel: true },
    };
    const sqlResolver = createLiveDbSqlResolver({
      sql: harness.sql as unknown as LivePostgresSql,
    });
    const repository = new BoardYjsRepository(sqlResolver);
    await repository.storeBoardYjsSnapshot(
      "board-folder:instant-folder-a",
      createBoardYDocSnapshot({
        ...targetScope,
        boardItems: [],
        markdownDocuments: [],
      }),
      null,
    );
    await repository.storeBoardYjsSnapshot(
      "board-folder:instant-folder-b",
      createBoardYDocSnapshot({
        ...otherScope,
        boardItems: [otherItem],
        markdownDocuments: [],
      }),
      null,
    );
    await harness.sql`
      INSERT INTO board_items (
        id, folder_id, container_kind, container_id, membership_kind,
        item_type, item_id, x, y, metadata
      )
      VALUES (
        ${otherItem.id}, ${otherItem.folderId}, ${otherItem.containerKind},
        ${otherItem.containerId}, ${otherItem.membershipKind}, ${otherItem.itemType},
        ${otherItem.itemId}, ${otherItem.x}, ${otherItem.y},
        ${harness.sql.json(otherItem.metadata)}::jsonb
      )
    `;
    const beforeOtherRows = await readContainerRows(harness, "instant-folder-b");
    const beforeOtherSnapshot = await repository.getBoardYjsSnapshot(
      "board-folder:instant-folder-b",
    );
    let service!: BoardYjsService;
    const moveService = new SessionBoardMoveService({
      board: {
        async withSessionBoardMoveApplications(input, persist) {
          if (!service) throw new Error("Board Yjs service is not initialized");
          return await service.withSessionBoardMoveApplications(input, persist);
        },
      },
      repository: new BoardYjsMoveRepository(sqlResolver),
    });
    service = new BoardYjsService({
      repository,
      logger: createSilentLogger(),
      moveSessionBoardItem: async (input) =>
        await moveService.moveSessionBoardItem(input),
      auth: {
        authBearerToken: "test-token",
        environment: "production",
        dashboardAuthEnabled: false,
        verifyDashboardToken: async () => null,
      },
    });

    try {
      await service.upsertSessionBoardItem({
        folderId: targetScope.folderId,
        container: targetScope,
        sessionId: "instant-session-a",
        sourceTaskItemId: null,
        x: 0,
        y: 160,
      });

      const targetSnapshot = await repository.getBoardYjsSnapshot(
        "board-folder:instant-folder-a",
      );
      expect(targetSnapshot).not.toBeNull();
      const targetDoc = new Y.Doc();
      Y.applyUpdate(targetDoc, targetSnapshot!);
      expect(readBoardYDocReplica(targetScope, targetDoc).boardItems).toEqual([
        expect.objectContaining({
          id: "session:instant-session-a",
          itemId: "instant-session-a",
          containerId: "instant-folder-a",
        }),
      ]);
      await expect(readContainerRows(harness, "instant-folder-a")).resolves.toEqual([
        expect.objectContaining({
          id: "session:instant-session-a",
          item_id: "instant-session-a",
        }),
      ]);
      await expect(harness.sql`
        SELECT folder_id
        FROM sessions
        WHERE session_id = 'instant-session-a'
      `).resolves.toEqual([{ folder_id: "instant-folder-a" }]);
      await expect(readContainerRows(harness, "instant-folder-b"))
        .resolves.toEqual(beforeOtherRows);
      const afterOtherSnapshot = await repository.getBoardYjsSnapshot(
        "board-folder:instant-folder-b",
      );
      expect(Buffer.from(afterOtherSnapshot!)).toEqual(Buffer.from(beforeOtherSnapshot!));
    } finally {
      await service.close();
    }
  });

  it("advances snapshot revision and rejects a stale compare-and-swap", async () => {
    const repository = new BoardYjsRepository(createLiveDbSqlResolver({
      sql: harness.sql as unknown as LivePostgresSql,
    }));
    const first = createBoardYDocSnapshot({
      folderId: "cas-folder",
      boardItems: [],
      markdownDocuments: [],
    });
    const secondDoc = new Y.Doc();
    Y.applyUpdate(secondDoc, first);
    secondDoc.getMap("boardItems").set("session:second", {
      item_type: "session",
      item_id: "second",
      x: 0,
      y: 0,
      metadata: {},
    });
    const second = Y.encodeStateAsUpdate(secondDoc);

    const created = await repository.storeBoardYjsSnapshot(
      "board-folder:cas-folder",
      first,
      null,
    );
    const updated = await repository.storeBoardYjsSnapshot(
      "board-folder:cas-folder",
      second,
      created!.revision,
    );
    const stale = await repository.storeBoardYjsSnapshot(
      "board-folder:cas-folder",
      first,
      created!.revision,
    );

    expect(created?.revision).toBe(1);
    expect(updated?.revision).toBe(2);
    expect(stale).toBeNull();
    await expect(harness.sql`
      SELECT revision, snapshot
      FROM board_yjs_documents
      WHERE name = 'board-folder:cas-folder'
    `).resolves.toEqual([{
      revision: 2,
      snapshot: Buffer.from(second),
    }]);
  });
});

function createSilentLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
    level: "silent",
    silent: vi.fn(),
  };
  return logger as never;
}

async function readContainerRows(
  harness: FullSchemaPostgresHarness,
  containerId: string,
): Promise<Array<Record<string, unknown>>> {
  return await harness.sql<Array<Record<string, unknown>>>`
    SELECT id, folder_id, container_kind, container_id, membership_kind,
      item_type, item_id, x, y, metadata
    FROM board_items
    WHERE container_kind = 'folder' AND container_id = ${containerId}
    ORDER BY id
  `;
}

async function createFullSchemaPostgresHarness(): Promise<FullSchemaPostgresHarness> {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await assertSafeExternalDatabase(externalUrl);
    return await connect(externalUrl);
  }

  const container = startPostgresTestContainer({
    user: "board_yjs_seed_test",
    password: "board_yjs_seed_test",
    database: "board_yjs_seed_test_db",
  });
  try {
    return await connect(
      `postgres://board_yjs_seed_test:board_yjs_seed_test@127.0.0.1:${container.port}/board_yjs_seed_test_db`,
      container.stop,
    );
  } catch (error) {
    container.stop();
    throw error;
  }
}

async function connect(
  url: string,
  stopContainer?: () => void,
): Promise<FullSchemaPostgresHarness> {
  const schema = `board_yjs_seed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const bootstrap = postgres(url, { max: 1, idle_timeout: 1, onnotice: () => {} });
  try {
    await waitForPostgres(bootstrap);
    await bootstrap.unsafe(`CREATE SCHEMA ${schema}`);
    await bootstrap.unsafe(`SET search_path TO ${schema}`);
    const schemaSql = readFileSync(fileURLToPath(
      new URL("../../packages/db-schema/sql/schema.sql", import.meta.url),
    ), "utf8");
    await bootstrap.unsafe(schemaSql);
  } catch (error) {
    await dropSchema(url, schema);
    throw error;
  } finally {
    await bootstrap.end({ timeout: 2 });
  }

  const sql = postgres(url, {
    max: 1,
    idle_timeout: 1,
    onnotice: () => {},
    connection: { search_path: schema },
  });
  try {
    await waitForPostgres(sql);
  } catch (error) {
    await sql.end({ timeout: 2 });
    await dropSchema(url, schema);
    throw error;
  }
  return {
    sql,
    async cleanup() {
      try {
        await sql.end({ timeout: 2 });
      } finally {
        await dropSchema(url, schema);
        stopContainer?.();
      }
    },
  };
}

async function assertSafeExternalDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "").toLowerCase();
  const target = `${parsed.hostname}/${name}`.toLowerCase();
  if (!name.includes("test")) {
    throw new Error("TEST_DATABASE_URL database name must include 'test'");
  }
  if (["atom_db", "reverie", "soulstream", "serendipity"].some(
    (protectedName) => target.includes(protectedName)
  )) {
    throw new Error("TEST_DATABASE_URL points at a protected database name");
  }
  const sql = postgres(url, { max: 1, idle_timeout: 1 });
  try {
    const rows = await sql<readonly { count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    `;
    if ((rows[0]?.count ?? 0) > 0) {
      throw new Error("TEST_DATABASE_URL must point at an empty test database");
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function waitForPostgres(sql: ReturnType<typeof postgres>): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await waitForPostgres(sql);
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}
