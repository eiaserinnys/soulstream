import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PageRepository } from "../../src/page/page_repository.js";
import { createLiveDbSqlResolver } from "../../src/runtime/live_db_sql.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page_postgres_harness.js";

let harness: PagePostgresHarness;
let repository: PageRepository;

describe("browser page reads PostgreSQL integration", () => {
  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    repository = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
    await harness.sql`
      INSERT INTO pages (id, title, version, archived) VALUES
        ('page-target', 'Target', 1, FALSE),
        ('page-source', 'Source', 1, FALSE),
        ('page-percent', '100%_ Real', 1, FALSE),
        ('page-other', '100xx Other', 1, FALSE),
        ('page-archived', '100%_ Archived', 1, TRUE)
    `;
    await harness.sql`
      INSERT INTO blocks (
        id, page_id, parent_id, position_key, block_type, text_plain, properties, collapsed
      ) VALUES
        ('source-a', 'page-source', NULL, 'a', 'paragraph', 'Prefix   source A', '{}'::jsonb, FALSE),
        ('source-b', 'page-source', NULL, 'b', 'paragraph', 'Prefix source B', '{}'::jsonb, FALSE),
        ('literal-block', 'page-source', NULL, 'c', 'paragraph', '100%_ block', '{}'::jsonb, FALSE),
        ('other-block', 'page-source', NULL, 'd', 'paragraph', '100xx block', '{}'::jsonb, FALSE)
    `;
    await harness.sql`
      INSERT INTO block_links (
        id, source_block_id, link_kind, ordinal, source_start, source_end,
        target_page_id, target_title, target_title_key, created_at
      ) VALUES
        ('link-a', 'source-a', 'mount', 0, 0, 8,
         'page-target', 'Target', 'target', '2026-07-11T00:00:00Z'),
        ('link-b', 'source-b', 'inline_page', 0, 0, 8,
         'page-target', 'Target', 'target', '2026-07-11T00:00:00Z')
    `;
  }, 60_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it("treats percent and underscore literally and excludes archived pages", async () => {
    await expect(repository.searchBrowserPages({ query: "100%_", limit: 20 }))
      .resolves.toEqual({ items: [{ pageId: "page-percent", title: "100%_ Real" }] });
    await expect(repository.searchBrowserBlocks({ query: "100%_", limit: 20 }))
      .resolves.toEqual({
        items: [{
          blockId: "literal-block",
          pageId: "page-source",
          pageTitle: "Source",
          textPreview: "100%_ block",
        }],
      });
  });

  it("uses both prefix indexes at the repository query boundary", async () => {
    await harness.sql.unsafe("SET enable_seqscan = off");
    const pagePlan = await harness.sql`
      EXPLAIN (COSTS OFF)
      SELECT id, title FROM pages
      WHERE archived = FALSE AND title_key LIKE (lower(${"100\\%\\_"}) || '%') ESCAPE '\\'
      ORDER BY title_key ASC, id ASC LIMIT 20
    `;
    const blockPlan = await harness.sql`
      EXPLAIN (COSTS OFF)
      SELECT block.id FROM blocks block
      JOIN pages page ON page.id = block.page_id
      WHERE page.archived = FALSE
        AND lower(block.text_plain) LIKE (lower(${"100\\%\\_"}) || '%') ESCAPE '\\'
      ORDER BY lower(block.text_plain) ASC, block.id ASC LIMIT 20
    `;
    expect(planText(pagePlan)).toContain("idx_pages_title_prefix");
    expect(planText(blockPlan)).toContain("idx_blocks_text_prefix");
  });

  it("paginates duplicate timestamps without gaps or duplicates and survives deleted rows", async () => {
    const first = await repository.getBrowserBacklinks({
      pageId: "page-target",
      kinds: ["mount", "inline_page"],
      limit: 1,
    });
    const second = await repository.getBrowserBacklinks({
      pageId: "page-target",
      kinds: ["inline_page", "mount"],
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect(first.items.map((item) => item.id)).toEqual(["link-a"]);
    expect(second.items.map((item) => item.id)).toEqual(["link-b"]);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(2);

    await harness.sql`DELETE FROM blocks WHERE id = 'source-a'`;
    await expect(repository.getBrowserBacklinks({
      pageId: "page-target",
      kinds: ["mount", "inline_page"],
      limit: 20,
    })).resolves.toMatchObject({ items: [{ id: "link-b" }] });

    await harness.sql`DELETE FROM pages WHERE id = 'page-target'`;
    await expect(repository.getBrowserBacklinks({
      pageId: "page-target",
      kinds: ["mount", "inline_page"],
      limit: 20,
    })).resolves.toEqual({ items: [], nextCursor: null });
  });
});

function planText(rows: readonly Record<string, unknown>[]): string {
  return rows.flatMap((row) => Object.values(row)).join("\n");
}
