import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLiveDbSqlResolver } from "../../src/runtime/live_db_sql.js";
import { PageRepository } from "../../src/page/page_repository.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page_postgres_harness.js";

let harness: PagePostgresHarness;
let sql: PagePostgresHarness["sql"];
let repository: PageRepository;

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
    harness = await createPagePostgresHarness();
    sql = harness.sql;
    repository = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
  }, 60_000);

  afterAll(async () => {
    await harness.cleanup();
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
      snapshot: new Uint8Array([8]),
      replica: {
        ...replica,
        blocks: [
          replica.blocks[0]!,
          { ...replica.blocks[1]!, text: "Edited child", textDelta: [{ insert: "Edited child" }] },
        ],
      },
    });


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
  it("prunes only omitted blocks in the selected page, including an empty replica", async () => {
    const selected = {
      page: { ...replica.page, id: "prune-page", title: "Prune" },
      blocks: replica.blocks.map((block, index) => ({
        ...block, id: `prune-block-${index}`, parentId: null,
      })),
    };
    const other = {
      page: { ...replica.page, id: "prune-other-page", title: "Other" },
      blocks: [{ ...replica.blocks[0]!, id: "prune-other-block", parentId: null }],
    };
    const save = async (value: typeof selected) => repository.storePageYjsState({
      documentName: `page:${value.page.id}`,
      snapshot: new TextEncoder().encode(JSON.stringify(value)),
      replica: value,
    });
    const read = async (pageId: string) => sql`
      SELECT * FROM blocks WHERE page_id = ${pageId} ORDER BY id
    `;
    await save(selected);
    await save(other);
    const otherBefore = await read(other.page.id);

    await save({ ...selected, blocks: selected.blocks.slice(0, 1) });
    expect((await read(selected.page.id)).map((row) => row.id)).toEqual(["prune-block-0"]);
    expect(await read(other.page.id)).toEqual(otherBefore);

    await save({ ...selected, blocks: [] });
    expect(await read(selected.page.id)).toEqual([]);
    expect(await read(other.page.id)).toEqual(otherBefore);
  });
});
