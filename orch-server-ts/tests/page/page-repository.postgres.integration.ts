import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createLiveDbSqlResolver,
  type LivePostgresSql,
} from "../../src/runtime/live_db_sql.js";
import { PageRepository } from "../../src/page/page_repository.js";

const databaseUrl = requireTestDatabaseUrl();
const sql = postgres(databaseUrl, { max: 2 });
const repository = new PageRepository(createLiveDbSqlResolver({
  sql: sql as unknown as LivePostgresSql,
}));

const replica = {
  page: {
    id: "page-1",
    title: "Page",
    dailyDate: null,
    mutationVersion: 2,
    archived: false,
    metadata: { color: "blue" },
  },
  blocks: [
    {
      id: "root",
      parentId: null,
      positionKey: "a",
      type: "paragraph",
      text: "Root",
      textDelta: [{ insert: "Root" }],
      properties: {},
      collapsed: false,
    },
    {
      id: "child",
      parentId: "root",
      positionKey: "b",
      type: "checklist",
      text: "Child",
      textDelta: [{ insert: "Child" }],
      properties: { checked: true },
      collapsed: true,
    },
  ],
};

describe("PageRepository PostgreSQL replica integration", () => {
  beforeAll(async () => {
    const [{ count }] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count
      FROM pg_tables
      WHERE schemaname = 'public'
    `;
    if (count !== "0") {
      throw new Error(`test database must be empty before setup; found ${count} tables`);
    }
    await sql.unsafe(`
      CREATE TABLE board_yjs_documents (
        name TEXT PRIMARY KEY,
        snapshot BYTEA NOT NULL,
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
        title TEXT NOT NULL CHECK (btrim(title) <> ''),
        daily_date DATE,
        version INTEGER NOT NULL CHECK (version > 0),
        archived BOOLEAN NOT NULL DEFAULT FALSE,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE blocks (
        id TEXT PRIMARY KEY,
        page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        parent_id TEXT,
        position_key TEXT NOT NULL CHECK (position_key <> ''),
        block_type TEXT NOT NULL,
        text_plain TEXT NOT NULL DEFAULT '',
        properties JSONB NOT NULL DEFAULT '{}'::jsonb,
        collapsed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_blocks_page_id_id UNIQUE (page_id, id),
        CONSTRAINT blocks_parent_same_page_fkey
          FOREIGN KEY (page_id, parent_id) REFERENCES blocks(page_id, id) ON DELETE CASCADE
      );
    `);
  });

  afterAll(async () => {
    await sql.unsafe(`
      DROP TABLE blocks;
      DROP TABLE pages;
      DROP TABLE board_yjs_updates;
      DROP TABLE board_yjs_documents;
    `);
    await sql.end({ timeout: 2 });
  });

  it("round-trips the snapshot and keeps repeated reconciliation idempotent", async () => {
    const snapshot = new Uint8Array([1, 2, 3]);
    await repository.storePageYjsState({
      documentName: "page:page-1",
      snapshot,
      update: new Uint8Array([4, 5]),
      replica,
    });
    const [firstPage] = await sql<[{ updated_at: Date }]>`
      SELECT updated_at FROM pages WHERE id = 'page-1'
    `;
    const [firstDocument] = await sql<[{ updated_at: Date }]>`
      SELECT updated_at FROM board_yjs_documents WHERE name = 'page:page-1'
    `;

    await repository.storePageYjsState({
      documentName: "page:page-1",
      snapshot,
      replica,
    });

    await expect(repository.getPageYjsSnapshot("page:page-1")).resolves.toEqual(snapshot);
    const [counts] = await sql<[{ pages: number; blocks: number; updates: number }]>`
      SELECT
        (SELECT COUNT(*)::int FROM pages) AS pages,
        (SELECT COUNT(*)::int FROM blocks) AS blocks,
        (SELECT COUNT(*)::int FROM board_yjs_updates) AS updates
    `;
    expect(counts).toEqual({ pages: 1, blocks: 2, updates: 1 });
    const rows = await sql<readonly {
      id: string;
      parent_id: string | null;
      text_plain: string;
      properties: Record<string, unknown>;
    }[]>`
      SELECT id, parent_id, text_plain, properties
      FROM blocks
      ORDER BY position_key
    `;
    expect(rows).toEqual([
      { id: "root", parent_id: null, text_plain: "Root", properties: {} },
      {
        id: "child",
        parent_id: "root",
        text_plain: "Child",
        properties: { checked: true },
      },
    ]);
    const [secondPage] = await sql<[{ updated_at: Date }]>`
      SELECT updated_at FROM pages WHERE id = 'page-1'
    `;
    const [secondDocument] = await sql<[{ updated_at: Date }]>`
      SELECT updated_at FROM board_yjs_documents WHERE name = 'page:page-1'
    `;
    expect(secondPage?.updated_at).toEqual(firstPage?.updated_at);
    expect(secondDocument?.updated_at).toEqual(firstDocument?.updated_at);

    await repository.storePageYjsState({
      documentName: "page:page-1",
      snapshot: new Uint8Array([9]),
      replica: { ...replica, blocks: [replica.blocks[0]!] },
    });
    const [{ count: remainingBlocks }] = await sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM blocks
    `;
    expect(remainingBlocks).toBe(1);

    await expect(repository.storePageYjsState({
      documentName: "page:page-2",
      snapshot: new Uint8Array([10]),
      replica: {
        page: { ...replica.page, id: "page-2", title: "Other page" },
        blocks: [replica.blocks[0]!],
      },
    })).rejects.toThrow();
    const [{ count: rolledBackPage }] = await sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM pages WHERE id = 'page-2'
    `;
    expect(rolledBackPage).toBe(0);
  });
});

function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error("TEST_DATABASE_URL is required for PostgreSQL integration tests");
  const databaseName = new URL(value).pathname.slice(1).toLowerCase();
  if (!databaseName.includes("test")) {
    throw new Error("TEST_DATABASE_URL database name must include test");
  }
  for (const forbidden of ["atom_db", "reverie", "soulstream", "serendipity"]) {
    if (databaseName.includes(forbidden)) {
      throw new Error(`TEST_DATABASE_URL must not target ${forbidden}`);
    }
  }
  return value;
}
