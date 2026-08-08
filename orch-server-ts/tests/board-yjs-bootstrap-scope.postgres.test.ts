import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import * as Y from "yjs";

import { createBoardYjsPersistence } from "../src/board-yjs/board_yjs_persistence.js";
import { readBoardYDocReplica } from "../src/board-yjs/board_yjs_model.js";
import { BoardYjsRepository } from "../src/board-yjs/board_yjs_repository.js";
import { createLiveDbSqlResolver } from "../src/runtime/live_db_sql.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";

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
});

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

  const containerId = execFileSync("docker", [
    "run", "--rm", "-d",
    "-e", "POSTGRES_USER=board_yjs_seed_test",
    "-e", "POSTGRES_PASSWORD=board_yjs_seed_test",
    "-e", "POSTGRES_DB=board_yjs_seed_test_db",
    "-p", "127.0.0.1::5432",
    "postgres:16-alpine",
  ], { encoding: "utf8" }).trim();
  try {
    return await connect(
      `postgres://board_yjs_seed_test:board_yjs_seed_test@127.0.0.1:${dockerPort(containerId)}/board_yjs_seed_test_db`,
      containerId,
    );
  } catch (error) {
    stopDocker(containerId);
    throw error;
  }
}

async function connect(
  url: string,
  containerId?: string,
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
        if (containerId) stopDocker(containerId);
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

function dockerPort(containerId: string): string {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const output = execFileSync("docker", ["port", containerId, "5432/tcp"], {
      encoding: "utf8",
    }).trim();
    const match = output.match(/:(\d+)$/);
    if (match) return match[1]!;
  }
  throw new Error("docker did not publish a PostgreSQL port");
}

function stopDocker(containerId: string): void {
  execFileSync("docker", ["stop", containerId], { stdio: "ignore" });
}
