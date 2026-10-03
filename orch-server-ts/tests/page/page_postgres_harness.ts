import postgres from "postgres";

import { startPostgresTestContainer } from
  "../../../packages/db-schema/scripts/postgres-test-container.mjs";
import type { LivePostgresSql } from "../../src/runtime/live_db_sql.js";

export interface PagePostgresHarness {
  sql: ReturnType<typeof postgres>;
  peerSql: ReturnType<typeof postgres>;
  concurrentSql: ReturnType<typeof postgres>;
  lockSql: ReturnType<typeof postgres>;
  liveSql: LivePostgresSql;
  peerLiveSql: LivePostgresSql;
  concurrentLiveSql: LivePostgresSql;
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

  const container = startPostgresTestContainer({
    user: TEST_USER,
    password: TEST_PASSWORD,
    database: TEST_DB_NAME,
  });
  try {
    return await connect(
      `postgres://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${container.port}/${TEST_DB_NAME}`,
      container.stop,
    );
  } catch (error) {
    container.stop();
    throw error;
  }
}

async function connect(url: string, stopContainer?: () => void): Promise<PagePostgresHarness> {
  const schema = `page_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const bootstrapSql = postgres(url, { max: 1, idle_timeout: 1, onnotice: () => {} });
  try {
    await waitForPostgres(bootstrapSql);
    await bootstrapSql.unsafe(`CREATE SCHEMA ${schema}`);
    await bootstrapSql.unsafe(`SET search_path TO ${schema}`);
    await createSchema(bootstrapSql);
  } catch (error) {
    await dropSchema(url, schema);
    throw error;
  } finally {
    await bootstrapSql.end({ timeout: 2 });
  }

  const sql = postgres(url, {
    max: 1,
    idle_timeout: 1,
    onnotice: () => {},
    connection: { search_path: schema },
  });
  const peerSql = postgres(url, {
    max: 1,
    idle_timeout: 1,
    onnotice: () => {},
    connection: { search_path: schema },
  });
  const concurrentSql = postgres(url, {
    max: 1,
    idle_timeout: 1,
    onnotice: () => {},
    connection: { search_path: schema },
  });
  const lockSql = postgres(url, {
    max: 1,
    idle_timeout: 1,
    onnotice: () => {},
    connection: { search_path: schema },
  });
  try {
    await waitForPostgres(sql);
    await waitForPostgres(peerSql);
    await waitForPostgres(concurrentSql);
    await waitForPostgres(lockSql);
  } catch (error) {
    await sql.end({ timeout: 2 });
    await peerSql.end({ timeout: 2 });
    await concurrentSql.end({ timeout: 2 });
    await lockSql.end({ timeout: 2 });
    await dropSchema(url, schema);
    throw error;
  }
  return {
    sql,
    peerSql,
    concurrentSql,
    lockSql,
    liveSql: sql as unknown as LivePostgresSql,
    peerLiveSql: peerSql as unknown as LivePostgresSql,
    concurrentLiveSql: concurrentSql as unknown as LivePostgresSql,
    async cleanup() {
      try {
        await Promise.all([
          sql.end({ timeout: 2 }),
          peerSql.end({ timeout: 2 }),
          concurrentSql.end({ timeout: 2 }),
          lockSql.end({ timeout: 2 }),
        ]);
      } finally {
        try {
          await dropSchema(url, schema);
        } finally {
          stopContainer?.();
        }
      }
    },
  };
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const cleanupSql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await waitForPostgres(cleanupSql);
    await cleanupSql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await cleanupSql.end({ timeout: 2 });
  }
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
      reasoning_effort TEXT,
      predecessor_session_id TEXT,
      caller_session_id TEXT,
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
    CREATE TABLE session_feed_state (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      attention_revision INTEGER NOT NULL DEFAULT 0 CHECK (attention_revision >= 0),
      notification_watermark INTEGER NOT NULL DEFAULT 0 CHECK (notification_watermark >= 0),
      feed_last_event_id INTEGER CHECK (feed_last_event_id IS NULL OR feed_last_event_id > 0),
      notification_count BIGINT NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE session_pending_attentions (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      attention_id TEXT NOT NULL,
      source_event_id INTEGER NOT NULL CHECK (source_event_id > 0),
      projection JSONB NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (session_id, attention_id),
      FOREIGN KEY (session_id, source_event_id)
        REFERENCES events(session_id, id) ON DELETE CASCADE
    );
    CREATE TABLE session_feed_notices (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      source_event_id INTEGER NOT NULL CHECK (source_event_id > 0),
      projection JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (session_id, source_event_id),
      FOREIGN KEY (session_id, source_event_id)
        REFERENCES events(session_id, id) ON DELETE CASCADE
    );
    CREATE OR REPLACE FUNCTION event_append(
      p_session_id TEXT,
      p_event_type TEXT,
      p_payload TEXT,
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
        p_session_id, next_id, p_event_type, p_payload::jsonb, p_searchable_text,
        p_dedupe_key, p_created_at
      );
      RETURN next_id;
    END;
    $$;
    CREATE TABLE board_yjs_documents (
      name TEXT PRIMARY KEY,
      snapshot BYTEA NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE FUNCTION board_yjs_documents_advance_revision()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
        NEW.revision := OLD.revision + 1;
      ELSE
        NEW.revision := OLD.revision;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER trg_board_yjs_documents_advance_revision
      BEFORE UPDATE OF snapshot ON board_yjs_documents
      FOR EACH ROW EXECUTE FUNCTION board_yjs_documents_advance_revision();
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
    CREATE OR REPLACE FUNCTION planner_starred_page_identity_trim(identity_value TEXT)
    RETURNS TEXT
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    AS $$
      SELECT NULLIF(BTRIM(
        identity_value,
        chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) ||
        chr(160) || chr(5760) || chr(8192) || chr(8193) || chr(8194) ||
        chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) ||
        chr(8200) || chr(8201) || chr(8202) || chr(8232) || chr(8233) ||
        chr(8239) || chr(8287) || chr(12288) || chr(65279)
      ), '')
    $$;
    CREATE TABLE planner_starred_page_order (
      page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      position BIGINT NOT NULL CHECK (position >= 0)
    );
    CREATE INDEX idx_planner_starred_page_order_position
      ON planner_starred_page_order(position, page_id);
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
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent','user','system','llm')),
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
    CREATE UNIQUE INDEX uq_pages_title_key ON pages(title_key);
    CREATE UNIQUE INDEX uq_pages_daily_date ON pages(daily_date) WHERE daily_date IS NOT NULL;
    CREATE INDEX idx_pages_title_prefix
      ON pages (title_key text_pattern_ops, id) WHERE archived = FALSE;
    CREATE INDEX idx_blocks_text_prefix
      ON blocks ((lower(text_plain)) text_pattern_ops, id);
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
    id          TEXT PRIMARY KEY,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    parent_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    project_page_id TEXT,
    archived    BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
    version INTEGER NOT NULL DEFAULT 1,
    created_session_id TEXT,
    created_event_id INTEGER,
    completed_kind TEXT CHECK (completed_kind IN ('agent','user','llm')),
    completed_session_id TEXT,
    completed_event_id INTEGER,
    completed_user_id TEXT,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
      membership_kind TEXT NOT NULL DEFAULT 'primary',
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
      board_items JSONB NOT NULL DEFAULT '[]'::jsonb,
      markdown_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (folder_id)
    );
CREATE TABLE cards (
    id                   TEXT PRIMARY KEY,
    folder_id            TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    position_key         TEXT NOT NULL,
    queue_position_key   TEXT,
    title                TEXT NOT NULL,
    request              TEXT NOT NULL DEFAULT '',
    attachments          JSONB NOT NULL DEFAULT '[]'::jsonb,
    brief                TEXT NOT NULL DEFAULT '',
    blocked_kind         TEXT CHECK (blocked_kind IN ('limit','question','no_report')),
    blocked_detail       TEXT,
    node_id              TEXT,
    model_preset         TEXT,
    assignee_kind        TEXT CHECK (assignee_kind IN ('agent','human','session')),
    assignee_agent_id    TEXT,
    assignee_session_id  TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    assignee_user_id     TEXT,
    status               TEXT NOT NULL DEFAULT 'todo'
                           CHECK (status IN ('todo','queued','blocked','running','review','done','cancelled')),
    status_changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived             BOOLEAN NOT NULL DEFAULT FALSE,
    version              INTEGER NOT NULL DEFAULT 1,
    created_session_id   TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_event_id     INTEGER,
    updated_session_id   TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    updated_event_id     INTEGER,
    completed_kind       TEXT CHECK (completed_kind IN ('agent','user','llm')),
    completed_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    completed_event_id   INTEGER,
    completed_user_id    TEXT,
    completed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (created_session_id, created_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    FOREIGN KEY (updated_session_id, updated_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL,
    FOREIGN KEY (completed_session_id, completed_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);

CREATE INDEX idx_cards_folder ON cards(folder_id, position_key COLLATE "C");
CREATE INDEX idx_cards_queue ON cards(queue_position_key COLLATE "C") WHERE status='queued' AND archived=FALSE;
ALTER TABLE sessions ADD COLUMN card_id TEXT REFERENCES cards(id) ON DELETE SET NULL;
CREATE INDEX idx_sessions_card ON sessions(card_id) WHERE card_id IS NOT NULL;

CREATE TABLE card_reports (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('markdown','html')),
    body TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_card_reports_card ON card_reports(card_id, created_at DESC);
CREATE TABLE card_questions (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    text TEXT NOT NULL,
    options JSONB,
    answer TEXT,
    asked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMPTZ,
    answered_by TEXT
);
CREATE INDEX idx_card_questions_card ON card_questions(card_id, asked_at);
CREATE TABLE card_comments (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent')),
    author_id TEXT,
    session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','spoken')),
    body TEXT NOT NULL,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_card_comments_card ON card_comments(card_id, created_at);
CREATE TABLE folder_operations (
    id               TEXT PRIMARY KEY,
    folder_id       TEXT NOT NULL REFERENCES folders(id) ON DELETE RESTRICT,
    target_kind      TEXT NOT NULL CHECK (target_kind IN ('folder','section','card')),
    target_id        TEXT NOT NULL,
    operation_type   TEXT NOT NULL,
    actor_kind       TEXT NOT NULL DEFAULT 'agent' CHECK (actor_kind IN ('agent','user','system','llm')),
    actor_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
    actor_event_id   INTEGER,
    actor_user_id    TEXT,
    idempotency_key  TEXT,
    payload_json     JSONB NOT NULL DEFAULT '{}'::JSONB,
    reason           TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (actor_session_id, actor_event_id)
        REFERENCES events(session_id, id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX uq_folder_ops_idem ON folder_operations(idempotency_key) WHERE idempotency_key IS NOT NULL;
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
