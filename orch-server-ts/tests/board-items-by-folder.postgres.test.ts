import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FolderContentRepository } from "../src/board/folder_content_repository.js";
import type { LiveDbSqlResolver, LivePostgresSql } from "../src/runtime/live_db_sql.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL?.trim()) ||
  spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasPostgres ? describe : describe.skip;

describePostgres("FolderContentRepository.getBoardItemsByFolder contract", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    await seedFixtures(harness);
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("matches the folder item projection and stops reading events and markdown bodies", async () => {
    const calls: string[] = [];
    const repository = new FolderContentRepository(
      recordingResolver(harness.sql as unknown as LivePostgresSql, calls),
    );

    const legacy = await repository.listFolderItems({
      folderId: "folder-a",
      query: null,
      includeArchived: true,
      itemTypes: null,
      limit: 10000,
      cursor: 0,
    });
    const legacyItems = legacy.items.map((item) => item.boardItem);
    const legacyCalls = [...calls];

    const boardItems = await repository.getBoardItemsByFolder("folder-a");

    expect(boardItems).toEqual(legacyItems);
    expect(boardItems.map((item) => item.id)).toEqual([
      "board-asset-orig-newer",
      "session:sess-new",
      "session:sess-tie-a",
      "session:sess-tie-b",
      "board-doc-placed",
      "board-view-archived",
      "markdown:doc-unplaced",
      "subfolder:sub-open",
      "subfolder:sub-archived",
      "session:sess-old",
      "board-asset-place-newer",
    ]);
    expect(boardItems.find((item) => item.id === "board-doc-placed")?.metadata).toEqual({
      pinned: true,
      title: "Placed Doc",
      preview: "alpha beta gamma",
      version: 3,
    });
    expect(boardItems.find((item) => item.id === "board-asset-place-newer")?.updatedAt)
      .toBe("2026-01-08T00:00:00.000Z");
    expect(boardItems.find((item) => item.id === "subfolder:sub-archived")).toBeDefined();
    expect(boardItems.find((item) => item.id === "board-view-archived")).toBeDefined();
    expect(boardItems.some((item) => item.id === "markdown:doc-other")).toBe(false);

    expect(legacyCalls.join("\n")).toContain("FROM events e");
    const dedicatedCalls = calls.slice(legacyCalls.length);
    expect(dedicatedCalls).toHaveLength(1);
    expect(dedicatedCalls[0]).toContain("WITH flat_items");
    expect(dedicatedCalls[0]).not.toContain("FROM events");
    expect(dedicatedCalls[0]).not.toContain("LEFT JOIN LATERAL");
    expect(dedicatedCalls[0]).not.toContain("event_counts");
    expect(dedicatedCalls[0]).not.toContain("markdown_body");
  });
});

async function seedFixtures(harness: FullSchemaPostgresHarness): Promise<void> {
  const { sql } = harness;
  await sql`
    INSERT INTO folders (id, name, created_at, updated_at) VALUES
      ('folder-a', 'Folder A', '2025-12-01T00:00:00Z', '2025-12-01T00:00:00Z'),
      ('folder-b', 'Folder B', '2025-12-01T00:00:00Z', '2025-12-01T00:00:00Z')
  `;
  await sql`
    INSERT INTO folders (id, name, parent_folder_id, archived, created_at, updated_at) VALUES
      ('sub-open', 'Sub Open', 'folder-a', FALSE, '2025-12-02T00:00:00Z', '2026-01-03T00:00:00Z'),
      ('sub-archived', 'Sub Archived', 'folder-a', TRUE, '2025-12-02T00:00:00Z', '2026-01-02T00:00:00Z')
  `;
  await sql`
    INSERT INTO sessions (session_id, folder_id, display_name, created_at, updated_at) VALUES
      ('sess-old', 'folder-a', 'Old', '2025-12-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ('sess-new', 'folder-a', 'New', '2025-12-01T00:00:00Z', '2026-01-09T00:00:00Z'),
      ('sess-tie-a', 'folder-a', 'Tie A', '2025-12-01T00:00:00Z', '2026-01-07T00:00:00Z'),
      ('sess-tie-b', 'folder-a', 'Tie B', '2025-12-01T00:00:00Z', '2026-01-07T00:00:00Z'),
      ('sess-outside', 'folder-b', 'Outside', '2025-12-01T00:00:00Z', '2026-01-11T00:00:00Z')
  `;
  await sql`
    INSERT INTO events (session_id, id, event_type, payload, searchable_text, created_at) VALUES
      ('sess-old', 1, 'user_message', '{"text":"one"}'::jsonb, 'legacy preview 1', '2025-12-05T00:00:00Z'),
      ('sess-old', 2, 'user_message', '{"text":"two"}'::jsonb, 'legacy preview 2', '2025-12-06T00:00:00Z'),
      ('sess-old', 3, 'user_message', '{"text":"three"}'::jsonb, 'legacy preview 3', '2025-12-07T00:00:00Z')
  `;
  await sql`
    INSERT INTO markdown_documents (id, folder_id, title, body, version, created_at, updated_at) VALUES
      ('doc-placed', 'folder-a', 'Placed Doc', ${"  alpha\n\n beta\tgamma  "}, 3,
        '2025-12-20T00:00:00Z', '2026-01-06T00:00:00Z'),
      ('doc-unplaced', 'folder-a', 'Unplaced Doc', '', 1,
        '2025-12-22T00:00:00Z', '2026-01-04T00:00:00Z'),
      ('doc-other', 'folder-b', 'Other Doc', 'other', 1,
        '2025-12-22T00:00:00Z', '2026-01-12T00:00:00Z')
  `;
  await sql`
    INSERT INTO file_assets
      (id, storage_key, original_name, mime_type, byte_size, created_at, updated_at) VALUES
      ('asset-1', 'storage-1', 'Original One', 'image/png', 10,
        '2025-12-01T00:00:00Z', '2026-01-10T00:00:00Z'),
      ('asset-2', 'storage-2', 'Original Two', 'image/png', 20,
        '2025-12-01T00:00:00Z', '2025-12-01T00:00:00Z')
  `;
  await sql`
    INSERT INTO board_items
      (id, folder_id, membership_kind, item_type, item_id, x, y, metadata, created_at, updated_at)
    VALUES
      ('board-doc-placed', 'folder-a', 'primary', 'markdown', 'doc-placed', 10, 20,
        ${sql.json({ pinned: true, title: "Custom" })},
        '2025-12-25T00:00:00Z', '2026-01-02T00:00:00Z'),
      ('board-view-archived', 'folder-a', 'primary', 'custom_view', 'cv-archived', 5, 6,
        '{}'::jsonb, '2025-12-26T00:00:00Z', '2025-12-27T00:00:00Z'),
      ('board-asset-orig-newer', 'folder-a', 'primary', 'asset', 'asset-1', 1, 2,
        '{}'::jsonb, '2025-12-02T00:00:00Z', '2026-01-02T00:00:00Z'),
      ('board-asset-place-newer', 'folder-a', 'primary', 'asset', 'asset-2', 3, 4,
        '{}'::jsonb, '2025-12-03T00:00:00Z', '2026-01-08T00:00:00Z')
  `;
  await sql`
    INSERT INTO board_custom_views
      (id, board_item_id, title, html, revision, archived, created_at, updated_at)
    VALUES
      ('cv-archived', 'board-view-archived', 'View', '<p>x</p>', 2, TRUE,
        '2025-12-26T00:00:00Z', '2026-01-05T00:00:00Z')
  `;
}

function recordingResolver(base: LivePostgresSql, calls: string[]): LiveDbSqlResolver {
  return {
    resolveSql: async () => recordingSql(base, calls),
    close: async () => undefined,
  };
}

function recordingSql(base: LivePostgresSql, calls: string[]): LivePostgresSql {
  const advanced = base as LivePostgresSql & {
    readonly array: (values: readonly unknown[]) => unknown;
    readonly unsafe: (query: string) => unknown;
  };
  const recording = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(strings.join("?"));
    return base(strings, ...values);
  }) as LivePostgresSql;
  return Object.assign(recording, {
    json: (value: unknown) => base.json(value),
    array: (values: readonly unknown[]) => advanced.array(values),
    unsafe: (query: string) => advanced.unsafe(query),
    begin: <T>(callback: (transaction: LivePostgresSql) => Promise<T>) =>
      base.begin!((transaction) => callback(recordingSql(transaction, calls))),
  });
}
