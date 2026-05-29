import { execFileSync } from "node:child_process";

import postgres from "postgres";

import type { SqlClient } from "../../src/db/session_db.js";

export interface PostgresTestHarness {
  sql: SqlClient;
  cleanup(): Promise<void>;
}

const TEST_DB_NAME = "schedule_test_db";
const TEST_USER = "schedule_test";
const TEST_PASSWORD = "schedule_test";

export async function createPostgresTestHarness(): Promise<PostgresTestHarness> {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await assertSafeExternalDatabase(externalUrl);
    return await connectWithIsolatedSchema(externalUrl, undefined);
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
    const url = `postgres://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${port}/${TEST_DB_NAME}`;
    return await connectWithIsolatedSchema(url, containerId);
  } catch (err) {
    stopDocker(containerId);
    throw err;
  }
}

async function connectWithIsolatedSchema(
  url: string,
  containerId: string | undefined,
): Promise<PostgresTestHarness> {
  const schema = `schedule_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const sql = postgres(url, { max: 1, idle_timeout: 1 }) as SqlClient;
  await waitForPostgres(sql);
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}`);
  await createMinimalScheduleSchema(sql);

  return {
    sql,
    async cleanup() {
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await sql.end();
        if (containerId) stopDocker(containerId);
      }
    },
  };
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
    await sql.end();
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

async function createMinimalScheduleSchema(sql: SqlClient): Promise<void> {
  await sql`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      node_id TEXT,
      status TEXT,
      prompt TEXT,
      client_id TEXT,
      session_type TEXT,
      claude_session_id TEXT,
      metadata JSONB,
      last_event_id INTEGER,
      last_read_event_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      agent_id TEXT,
      caller_session_id TEXT
    )
  `;
  await sql`
    CREATE TABLE soulstream_schedules (
      schedule_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('wakeup', 'cron')),
      status TEXT NOT NULL CHECK (
        status IN (
          'active',
          'dispatching',
          'firing',
          'completed',
          'cancelled',
          'failed',
          'orphaned'
        )
      ),
      prompt TEXT NOT NULL,
      source_tool TEXT NOT NULL,
      tool_use_id TEXT,
      cron_expression TEXT,
      run_once_at TIMESTAMPTZ,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      recurring BOOLEAN NOT NULL DEFAULT FALSE,
      next_run_at TIMESTAMPTZ,
      last_fired_at TIMESTAMPTZ,
      fired_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claim_token TEXT,
      claimed_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE soulstream_node_heartbeats (
      node_id TEXT PRIMARY KEY,
      last_seen_at TIMESTAMPTZ NOT NULL
    )
  `;
}
