import { execFileSync } from "node:child_process";

import postgres from "postgres";

import type { LivePostgresSql } from "../../src/runtime/live_db_sql.js";

export interface PagePostgresHarness {
  sql: ReturnType<typeof postgres>;
  liveSql: LivePostgresSql;
  cleanup(): Promise<void>;
}

const TEST_DB_NAME = "page_mutation_test_db";
const TEST_USER = "page_mutation_test";
const TEST_PASSWORD = "page_mutation_test";

export async function createPagePostgresHarness(): Promise<PagePostgresHarness> {
  const externalUrl = process.env.TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await assertSafeExternalDatabase(externalUrl);
    return await connect(externalUrl);
  }

  const containerId = execFileSync("docker", [
    "run", "--rm", "-d",
    "-e", `POSTGRES_USER=${TEST_USER}`,
    "-e", `POSTGRES_PASSWORD=${TEST_PASSWORD}`,
    "-e", `POSTGRES_DB=${TEST_DB_NAME}`,
    "-p", "127.0.0.1::5432",
    "postgres:16-alpine",
  ], { encoding: "utf8" }).trim();
  try {
    const port = dockerMappedPort(containerId);
    return await connect(
      `postgres://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${port}/${TEST_DB_NAME}`,
      containerId,
    );
  } catch (error) {
    stopDocker(containerId);
    throw error;
  }
}

async function connect(url: string, containerId?: string): Promise<PagePostgresHarness> {
  const sql = postgres(url, { max: 1, idle_timeout: 1, onnotice: () => {} });
  await waitForPostgres(sql);
  const schema = `page_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await sql.unsafe(`CREATE SCHEMA ${schema}`);
  await sql.unsafe(`SET search_path TO ${schema}`);
  await createSchema(sql);
  return {
    sql,
    liveSql: sql as unknown as LivePostgresSql,
    async cleanup() {
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await sql.end({ timeout: 2 });
        if (containerId) stopDocker(containerId);
      }
    },
  };
}

async function createSchema(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      folder_id TEXT,
      display_name TEXT,
      node_id TEXT,
      session_type TEXT,
      status TEXT,
      agent_id TEXT,
      predecessor_session_id TEXT,
      review_state TEXT NOT NULL DEFAULT 'not_required',
      last_event_id INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE events (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB,
      searchable_text TEXT,
      dedupe_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, id),
      UNIQUE (session_id, dedupe_key)
    );
    CREATE OR REPLACE FUNCTION event_append(
      p_session_id TEXT,
      p_event_type TEXT,
      p_payload JSONB,
      p_searchable_text TEXT,
      p_created_at TIMESTAMPTZ,
      p_dedupe_key TEXT DEFAULT NULL
    ) RETURNS INTEGER LANGUAGE plpgsql AS $$
    DECLARE next_id INTEGER;
    BEGIN
      UPDATE sessions SET last_event_id = last_event_id + 1
      WHERE session_id = p_session_id
      RETURNING last_event_id INTO next_id;
      IF next_id IS NULL THEN RAISE EXCEPTION 'session not found: %', p_session_id; END IF;
      INSERT INTO events (
        session_id, id, event_type, payload, searchable_text, dedupe_key, created_at
      ) VALUES (
        p_session_id, next_id, p_event_type, p_payload, p_searchable_text,
        p_dedupe_key, p_created_at
      );
      RETURN next_id;
    END;
    $$;
    CREATE TABLE board_yjs_documents (
      name TEXT PRIMARY KEY,
      snapshot BYTEA NOT NULL,
      synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE board_yjs_updates (
      id BIGSERIAL PRIMARY KEY,
      document_name TEXT NOT NULL REFERENCES board_yjs_documents(name) ON DELETE CASCADE,
      update BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE pages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_key TEXT GENERATED ALWAYS AS (lower(btrim(title))) STORED,
      daily_date DATE,
      version INTEGER NOT NULL CHECK (version > 0),
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      created_event_id INTEGER,
      updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      updated_event_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
      FOREIGN KEY (updated_session_id, updated_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
    );
    CREATE TABLE blocks (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      parent_id TEXT,
      position_key TEXT NOT NULL,
      block_type TEXT NOT NULL,
      text_plain TEXT NOT NULL DEFAULT '',
      properties JSONB NOT NULL DEFAULT '{}'::jsonb,
      collapsed BOOLEAN NOT NULL DEFAULT FALSE,
      created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      created_event_id INTEGER,
      updated_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      updated_event_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (page_id, id),
      FOREIGN KEY (page_id, parent_id) REFERENCES blocks(page_id, id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX uq_blocks_primary_session_ref
      ON blocks ((properties ->> 'sessionId'))
      WHERE block_type = 'session_ref'
        AND properties ->> 'primary' = 'true';
    CREATE TABLE session_page_bindings (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      target_page_id TEXT,
      target_block_id TEXT,
      target_expected_version INTEGER,
      daily_date DATE NOT NULL,
      session_type TEXT NOT NULL,
      page_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (page_state IN ('pending','bound','manual_repair')),
      legacy_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (legacy_state IN ('pending','completed','manual_repair')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (target_page_id IS NULL AND target_block_id IS NULL AND target_expected_version IS NULL)
        OR (target_page_id IS NOT NULL AND target_block_id IS NOT NULL
          AND target_expected_version IS NOT NULL AND target_expected_version > 0)
      )
    );
    CREATE TABLE block_operations (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      target_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
      operation_type TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent','user','system')),
      actor_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      actor_event_id INTEGER,
      actor_user_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      expected_version INTEGER NOT NULL,
      result_version INTEGER NOT NULL CHECK (result_version = expected_version + 1),
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (actor_session_id, actor_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
      CHECK (actor_kind <> 'agent' OR actor_session_id IS NOT NULL),
      CHECK (actor_kind <> 'user' OR actor_user_id IS NOT NULL)
    );
    CREATE TABLE checklist_runbook_projection_outbox (
      block_id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      source_hash TEXT NOT NULL,
      processed_hash TEXT,
      actor_kind TEXT NOT NULL DEFAULT 'system'
        CHECK (actor_kind IN ('agent','user','system')),
      actor_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      actor_user_id TEXT,
      routing_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_owner_node_id TEXT,
      lease_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (actor_kind = 'agent' AND actor_session_id IS NOT NULL AND actor_user_id IS NULL)
        OR (actor_kind = 'user' AND actor_user_id IS NOT NULL)
        OR (actor_kind = 'system' AND actor_user_id IS NULL)
      )
    );
    CREATE UNIQUE INDEX uq_pages_title_key ON pages(title_key);
    CREATE UNIQUE INDEX uq_pages_daily_date ON pages(daily_date) WHERE daily_date IS NOT NULL;
    CREATE INDEX idx_pages_title_prefix
      ON pages (title_key text_pattern_ops, id) WHERE archived = FALSE;
    CREATE INDEX idx_blocks_text_prefix
      ON blocks ((lower(text_plain)) text_pattern_ops, id);
    CREATE INDEX idx_checklist_runbook_projection_due
      ON checklist_runbook_projection_outbox(next_retry_at, updated_at, block_id)
      WHERE processed_hash IS DISTINCT FROM source_hash;
    CREATE TABLE block_links (
      id TEXT PRIMARY KEY,
      source_block_id TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
      link_kind TEXT NOT NULL CHECK (link_kind IN ('mount','inline_page','block_ref')),
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      source_start INTEGER NOT NULL CHECK (source_start >= 0),
      source_end INTEGER NOT NULL CHECK (source_end > source_start),
      target_page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      target_title TEXT,
      target_title_key TEXT,
      target_block_id TEXT REFERENCES blocks(id) ON DELETE SET NULL,
      target_block_ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_block_id, ordinal),
      CHECK (
        (link_kind IN ('mount','inline_page')
          AND target_title IS NOT NULL AND target_title_key IS NOT NULL
          AND target_block_ref IS NULL)
        OR
        (link_kind = 'block_ref'
          AND target_block_ref IS NOT NULL
          AND target_title IS NULL AND target_title_key IS NULL)
      )
    );
    CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      project_page_id TEXT UNIQUE REFERENCES pages(id) ON DELETE RESTRICT,
      archived BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE markdown_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE board_items (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      container_kind TEXT NOT NULL DEFAULT 'folder',
      container_id TEXT NOT NULL,
      membership_kind TEXT NOT NULL DEFAULT 'primary',
      source_runbook_item_id TEXT,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      x DOUBLE PRECISION NOT NULL DEFAULT 0,
      y DOUBLE PRECISION NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE board_yjs_catalog_cache (
      folder_id TEXT NOT NULL,
      container_kind TEXT NOT NULL,
      container_id TEXT NOT NULL,
      board_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      markdown_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (container_kind, container_id)
    );
    CREATE TABLE runbooks (
      id TEXT PRIMARY KEY,
      board_item_id TEXT NOT NULL UNIQUE REFERENCES board_items(id) ON DELETE CASCADE,
      task_page_id TEXT UNIQUE REFERENCES pages(id) ON DELETE RESTRICT,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      version INTEGER NOT NULL DEFAULT 1,
      created_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      created_event_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE runbook_sections (
      id TEXT PRIMARY KEY,
      runbook_id TEXT NOT NULL REFERENCES runbooks(id) ON DELETE CASCADE,
      position_key TEXT NOT NULL,
      assignee_agent_id TEXT,
      assignee_user_id TEXT,
      assignee_session_id TEXT,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE runbook_items (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL REFERENCES runbook_sections(id) ON DELETE CASCADE,
      position_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assignee_agent_id TEXT,
      assignee_user_id TEXT,
      assignee_session_id TEXT,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE runbook_operations (
      id TEXT PRIMARY KEY,
      runbook_id TEXT REFERENCES runbooks(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      actor_event_id INTEGER,
      actor_user_id TEXT,
      idempotency_key TEXT UNIQUE,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE folder_project_operations (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE RESTRICT,
      operation_type TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent','user','system')),
      actor_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
      actor_user_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function assertSafeExternalDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "").toLowerCase();
  const full = `${parsed.hostname}/${name}`.toLowerCase();
  if (!name.includes("test")) throw new Error("TEST_DATABASE_URL database name must include test");
  if (["atom_db", "reverie", "soulstream", "serendipity"].some((token) => full.includes(token))) {
    throw new Error("TEST_DATABASE_URL points at a protected database name");
  }
  const sql = postgres(url, { max: 1, idle_timeout: 1 });
  try {
    const [row] = await sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    `;
    if ((row?.count ?? 0) > 0) throw new Error("TEST_DATABASE_URL must point at an empty test database");
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

function dockerMappedPort(containerId: string): string {
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
