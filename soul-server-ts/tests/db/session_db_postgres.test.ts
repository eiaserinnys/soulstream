import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionDB, type SqlClient } from "../../src/db/session_db.js";

const TEST_DB_NAME = "session_db_supervisor_test";
const TEST_USER = "session_db_supervisor_test";
const TEST_PASSWORD = "session_db_supervisor_secret";

const hasPostgresTestBackend =
  Boolean(process.env.TEST_DATABASE_URL?.trim()) || hasDockerBinary();
const describePostgres = hasPostgresTestBackend ? describe : describe.skip;

describePostgres("SessionDB supervisor PostgreSQL integration", () => {
  let harness: PostgresHarness | undefined;
  let db: SessionDB;

  beforeAll(async () => {
    harness = await createHarness();
    await applySupervisorSchema(harness.sql);
    db = new SessionDB(harness.sql);
  }, 45_000);

  beforeEach(async () => {
    if (!harness) return;
    await harness.sql`DROP INDEX CONCURRENTLY IF EXISTS idx_sessions_updated_at_session_id`;
    await harness.sql`DELETE FROM sessions`;
  }, 15_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  }, 15_000);

  it("keeps session_get_all pagination stable for sessions with identical updated_at", async () => {
    const tiedUpdatedAt = new Date("2026-06-14T01:00:00Z");
    const oldUpdatedAt = new Date("2026-06-13T01:00:00Z");
    await harness!.sql`
      INSERT INTO sessions (session_id, updated_at, session_type, status)
      VALUES
        ('sess-a', ${tiedUpdatedAt}, 'claude', 'completed'),
        ('sess-c', ${tiedUpdatedAt}, 'claude', 'completed'),
        ('sess-b', ${tiedUpdatedAt}, 'claude', 'completed'),
        ('sess-old', ${oldUpdatedAt}, 'claude', 'completed')
    `;

    await applySupervisorSchema(harness!.sql);

    const firstPage = await harness!.sql<Array<{ session_id: string }>>`
      SELECT session_id FROM session_get_all(NULL, 2, 0)
    `;
    const secondPage = await harness!.sql<Array<{ session_id: string }>>`
      SELECT session_id FROM session_get_all(NULL, 2, 2)
    `;

    expect(firstPage.map((row) => row.session_id)).toEqual(["sess-c", "sess-b"]);
    expect(secondPage.map((row) => row.session_id)).toEqual(["sess-a", "sess-old"]);
    expect(new Set([...firstPage, ...secondPage].map((row) => row.session_id)).size).toBe(4);
  }, 45_000);

  it("creates the stable session order index as a valid concurrent index", async () => {
    await db.ensureStableSessionOrderIndex();

    const rows = await harness!.sql<
      Array<{ indisvalid: boolean; indisready: boolean; definition: string }>
    >`
      SELECT i.indisvalid, i.indisready, pg_get_indexdef(c.oid) AS definition
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.oid = to_regclass('idx_sessions_updated_at_session_id')
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ indisvalid: true, indisready: true });
    expect(rows[0].definition).toContain("(updated_at DESC, session_id DESC)");
  }, 30_000);

  it("drops an invalid concurrent index remnant and recreates a valid one", async () => {
    const duplicateUpdatedAt = new Date("2026-06-14T00:00:00Z");
    await harness!.sql`
      INSERT INTO sessions (session_id, updated_at)
      VALUES ('invalid-a', ${duplicateUpdatedAt}), ('invalid-b', ${duplicateUpdatedAt})
    `;

    await expect(
      harness!.sql`
        CREATE UNIQUE INDEX CONCURRENTLY idx_sessions_updated_at_session_id
        ON sessions (updated_at)
      `,
    ).rejects.toThrow();

    const invalidRows = await harness!.sql<Array<{ indisvalid: boolean }>>`
      SELECT i.indisvalid
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.oid = to_regclass('idx_sessions_updated_at_session_id')
    `;
    expect(invalidRows).toHaveLength(1);
    expect(invalidRows[0].indisvalid).toBe(false);

    await db.ensureStableSessionOrderIndex();

    const repairedRows = await harness!.sql<
      Array<{ indisvalid: boolean; indisready: boolean; definition: string }>
    >`
      SELECT i.indisvalid, i.indisready, pg_get_indexdef(c.oid) AS definition
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.oid = to_regclass('idx_sessions_updated_at_session_id')
    `;
    expect(repairedRows).toHaveLength(1);
    expect(repairedRows[0]).toMatchObject({ indisvalid: true, indisready: true });
    expect(repairedRows[0].definition).toContain(
      "USING btree (updated_at DESC, session_id DESC)",
    );
  }, 45_000);

  it("reads supervisor event head offset and related supervisor state on live PostgreSQL", async () => {
    const now = new Date("2026-06-09T00:00:00Z");

    const first = await db.appendSupervisorEvent({
      sourceNode: "node-a",
      sourceSessionId: "sess-a",
      sourceEventId: 1,
      eventType: "text_delta",
      payload: { text: "one" },
      createdAt: now,
    });
    const second = await db.appendSupervisorEvent({
      sourceNode: "node-a",
      sourceSessionId: "sess-a",
      sourceEventId: 2,
      eventType: "complete",
      payload: { ok: true },
      createdAt: now,
    });

    await expect(db.getSupervisorEventHeadOffset()).resolves.toBe(second.offset);

    const events = await db.readSupervisorEventsAfter(first.offset - 1, 10);
    expect(events.map((event) => event.offset)).toEqual([first.offset, second.offset]);
    expect(events.map((event) => event.eventType)).toEqual(["text_delta", "complete"]);

    await expect(db.getSupervisorConsumerCursor("cluster")).resolves.toBe(0);
    await expect(db.setSupervisorConsumerCursor("cluster", second.offset)).resolves.toBe(
      second.offset,
    );
    await expect(db.getSupervisorConsumerCursor("cluster")).resolves.toBe(second.offset);

    const registry = await db.upsertSupervisorRegistry({
      role: "cluster",
      activeSessionId: "sess-supervisor",
      epoch: 1,
      cursorOffset: second.offset,
      handoverState: "idle_pending",
      cumulativeTokens: 0,
      compactionCount: 0,
      lastSeenAt: now,
    });
    expect(registry.cursorOffset).toBe(second.offset);
    expect(registry.wakeDispatchState).toBe("active");

    const blocked = await db.setSupervisorWakeDispatchState({
      role: "cluster",
      state: "blocked",
      lastSignature: "snapshot:cluster:0:2",
      repeatCount: 1,
      blockedReason: "test block",
      blockedAt: now,
    });
    expect(blocked).toMatchObject({
      role: "cluster",
      wakeDispatchState: "blocked",
      wakeLastSignature: "snapshot:cluster:0:2",
      wakeRepeatCount: 1,
      wakeBlockedReason: "test block",
    });
  });
});

function hasDockerBinary(): boolean {
  const result = spawnSync("docker", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

interface PostgresHarness {
  sql: SqlClient;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<PostgresHarness> {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await assertSafeExternalDatabase(externalUrl);
    return await connect(externalUrl, undefined);
  }

  const containerId = execFileSync("docker", [
    "run",
    "--rm",
    "-d",
    "-e",
    `POSTGRES_USER=${TEST_USER}`,
    "-e",
    `POSTGRES_PASSWORD=${TEST_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${TEST_DB_NAME}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ], { encoding: "utf8" }).trim();

  try {
    const port = dockerMappedPort(containerId);
    return await connect(
      `postgres://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${port}/${TEST_DB_NAME}`,
      containerId,
    );
  } catch (err) {
    stopDocker(containerId);
    throw err;
  }
}

async function connect(url: string, containerId: string | undefined): Promise<PostgresHarness> {
  const schema = `session_db_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const sql = postgres(url, { max: 1, idle_timeout: 1 }) as SqlClient;
  await waitForPostgres(sql);
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}`);

  return {
    sql,
    async cleanup() {
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await sql.end({ timeout: 5 });
        if (containerId) stopDocker(containerId);
      }
    },
  };
}

async function applySupervisorSchema(sql: SqlClient): Promise<void> {
  const schemaSql = readFileSync(
    fileURLToPath(new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url)),
    "utf8",
  );
  const migration022Sql = readFileSync(
    fileURLToPath(
      new URL(
        "../../../packages/db-schema/sql/migrations/022_supervisor_wake_dispatch_state.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  await sql.unsafe(schemaSql);
  await sql.unsafe(migration022Sql);
  await sql.unsafe(migration022Sql);
}

async function assertSafeExternalDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "").toLowerCase();
  const full = `${parsed.hostname}/${name}`.toLowerCase();
  const banned = ["atom_db", "reverie", "soulstream", "serendipity"];
  if (!name.includes("test")) {
    throw new Error("TEST_DATABASE_URL database name must include 'test'");
  }
  if (banned.some((token) => full.includes(token))) {
    throw new Error("TEST_DATABASE_URL points at a protected database name");
  }

  const sql = postgres(url, { max: 1, idle_timeout: 1 }) as SqlClient;
  try {
    const rows = await sql<Array<{ count: string | number }>>`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    `;
    if (Number(rows[0]?.count ?? 0) > 0) {
      throw new Error("TEST_DATABASE_URL must point at an empty test database");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function waitForPostgres(sql: SqlClient): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function dockerMappedPort(containerId: string): string {
  for (let i = 0; i < 30; i += 1) {
    const output = execFileSync("docker", ["port", containerId, "5432/tcp"], {
      encoding: "utf8",
    }).trim();
    const match = output.match(/:(\d+)$/);
    if (match) return match[1];
  }
  throw new Error("docker did not publish a PostgreSQL port");
}

function stopDocker(containerId: string): void {
  execFileSync("docker", ["stop", containerId], { stdio: "ignore" });
}
