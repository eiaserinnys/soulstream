import { execFileSync, spawnSync } from "node:child_process";

import postgres from "postgres";

import type { SqlClient } from "../../src/db/session_db.js";

const TEST_DB_NAME = "runbook_test_db";
const TEST_USER = "runbook_test";
const TEST_PASSWORD = "runbook_test";

export interface RunbookPostgresHarness {
  sql: SqlClient;
  cleanup(): Promise<void>;
}

export const hasRunbookPostgresBackend =
  Boolean(process.env.TEST_DATABASE_URL?.trim()) || hasDockerBinary();

export async function createRunbookPostgresHarness(): Promise<RunbookPostgresHarness> {
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

export async function resetRunbookData(sql: SqlClient): Promise<void> {
  await sql`
    TRUNCATE runbook_operations, runbook_items, runbook_sections, runbooks,
      board_yjs_catalog_cache, board_items, folders, events, sessions
    RESTART IDENTITY CASCADE
  `;
  await sql`
    INSERT INTO sessions (session_id, node_id, status, session_type)
    VALUES ('sess-actor', 'node-1', 'running', 'claude')
  `;
  await sql`INSERT INTO folders (id, name, sort_order) VALUES ('folder-1', 'Folder', 1)`;
}

async function connect(
  url: string,
  containerId: string | undefined,
): Promise<RunbookPostgresHarness> {
  const schema = `runbook_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const sql = postgres(url, { max: 1, idle_timeout: 1 }) as SqlClient;
  await waitForPostgres(sql);
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}`);
  await createRunbookSchema(sql);

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

async function createRunbookSchema(sql: SqlClient): Promise<void> {
  await sql`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      node_id TEXT,
      status TEXT,
      session_type TEXT,
      last_event_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE events (
      id INTEGER NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::JSONB,
      searchable_text TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      parent_event_id INTEGER,
      dedupe_key TEXT,
      PRIMARY KEY (session_id, id)
    )
  `;
  await sql`
    CREATE UNIQUE INDEX uq_events_dedupe
    ON events(session_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL
  `;
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION event_append(
      p_session_id TEXT,
      p_event_type TEXT,
      p_payload TEXT,
      p_searchable_text TEXT,
      p_created_at TIMESTAMPTZ,
      p_dedupe_key TEXT DEFAULT NULL
    ) RETURNS INTEGER LANGUAGE plpgsql AS $$
    DECLARE
      v_event_id INTEGER;
    BEGIN
      PERFORM session_id FROM sessions WHERE session_id = p_session_id FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session not found: %', p_session_id;
      END IF;
      IF p_dedupe_key IS NOT NULL THEN
        SELECT id INTO v_event_id
        FROM events
        WHERE session_id = p_session_id AND dedupe_key = p_dedupe_key
        LIMIT 1;
        IF v_event_id IS NOT NULL THEN
          UPDATE sessions SET last_event_id = v_event_id WHERE session_id = p_session_id;
          RETURN v_event_id;
        END IF;
      END IF;
      INSERT INTO events (id, session_id, event_type, payload, searchable_text, created_at, dedupe_key)
      VALUES (
        (SELECT COALESCE(MAX(id), 0) + 1 FROM events WHERE session_id = p_session_id),
        p_session_id, p_event_type, p_payload::jsonb, p_searchable_text, p_created_at, p_dedupe_key
      ) RETURNING id INTO v_event_id;
      UPDATE sessions SET last_event_id = v_event_id WHERE session_id = p_session_id;
      RETURN v_event_id;
    END;
    $$;
  `);
  await sql`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    )
  `;
  await sql`
    CREATE TABLE board_items (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL CHECK (item_type IN ('session', 'markdown', 'subfolder', 'asset', 'frame', 'runbook')),
      item_id TEXT NOT NULL,
      x DOUBLE PRECISION NOT NULL DEFAULT 0,
      y DOUBLE PRECISION NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (folder_id, item_id)
    )
  `;
  await sql`
    CREATE TABLE board_yjs_catalog_cache (
      folder_id TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
      board_items JSONB NOT NULL DEFAULT '[]'::JSONB,
      markdown_documents JSONB NOT NULL DEFAULT '[]'::JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await createRunbookTables(sql);
}

async function createRunbookTables(sql: SqlClient): Promise<void> {
  await sql`
    CREATE TABLE runbooks (
      id TEXT PRIMARY KEY,
      board_item_id TEXT NOT NULL REFERENCES board_items(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      version INTEGER NOT NULL DEFAULT 1,
      created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      created_event_id INTEGER,
      completed_kind TEXT CHECK (completed_kind IN ('agent','user')),
      completed_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      completed_event_id INTEGER,
      completed_user_id TEXT,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
      FOREIGN KEY (completed_session_id, completed_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
    )
  `;
  await sql`
    CREATE TABLE runbook_sections (
      id TEXT PRIMARY KEY,
      runbook_id TEXT NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
      position_key TEXT NOT NULL,
      title TEXT NOT NULL,
      assignee_kind TEXT CHECK (assignee_kind IN ('agent','human','session')),
      assignee_agent_id TEXT,
      assignee_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      assignee_user_id TEXT,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      version INTEGER NOT NULL DEFAULT 1,
      created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      created_event_id INTEGER,
      updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      updated_event_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (created_session_id, created_event_id) REFERENCES events(session_id, id) ON DELETE SET NULL,
      FOREIGN KEY (updated_session_id, updated_event_id) REFERENCES events(session_id, id) ON DELETE SET NULL
    )
  `;
  await sql`
    CREATE TABLE runbook_items (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL REFERENCES runbook_sections(id) ON DELETE CASCADE,
      position_key TEXT NOT NULL,
      title TEXT NOT NULL,
      how_to TEXT NOT NULL DEFAULT '',
      assignee_kind TEXT CHECK (assignee_kind IN ('agent','human','session')),
      assignee_agent_id TEXT,
      assignee_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      assignee_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','review','completed','cancelled')),
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      version INTEGER NOT NULL DEFAULT 1,
      created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      created_event_id INTEGER,
      updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      updated_event_id INTEGER,
      completed_kind TEXT CHECK (completed_kind IN ('agent','user')),
      completed_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      completed_event_id INTEGER,
      completed_user_id TEXT,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (created_session_id, created_event_id) REFERENCES events(session_id, id) ON DELETE SET NULL,
      FOREIGN KEY (updated_session_id, updated_event_id) REFERENCES events(session_id, id) ON DELETE SET NULL,
      FOREIGN KEY (completed_session_id, completed_event_id) REFERENCES events(session_id, id) ON DELETE SET NULL
    )
  `;
  await sql`
    CREATE TABLE runbook_operations (
      id TEXT PRIMARY KEY,
      runbook_id TEXT REFERENCES runbooks(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('runbook','section','item')),
      target_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      actor_kind TEXT NOT NULL DEFAULT 'agent' CHECK (actor_kind IN ('agent','user','system')),
      actor_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      actor_event_id INTEGER,
      actor_user_id TEXT,
      idempotency_key TEXT,
      payload_json JSONB NOT NULL DEFAULT '{}'::JSONB,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (actor_session_id, actor_event_id) REFERENCES events(session_id, id) ON DELETE SET NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX uq_runbook_ops_idem ON runbook_operations(idempotency_key) WHERE idempotency_key IS NOT NULL`;
}

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}

async function assertSafeExternalDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "").toLowerCase();
  const full = `${parsed.hostname}/${name}`.toLowerCase();
  const banned = ["atom_db", "reverie", "soulstream", "serendipity"];
  if (!name.includes("test")) throw new Error("TEST_DATABASE_URL database name must include 'test'");
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
    if (match) return match[1]!;
  }
  throw new Error("docker did not publish a PostgreSQL port");
}

function stopDocker(containerId: string): void {
  execFileSync("docker", ["stop", containerId], { stdio: "ignore" });
}
