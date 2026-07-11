import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PageRepository } from "../../src/page/page_repository.js";
import { createLiveDbSqlResolver } from "../../src/runtime/live_db_sql.js";
import type { PageYjsReplica } from "../../src/page/page_yjs_model.js";
import {
  createPagePostgresHarness,
  type PagePostgresHarness,
} from "./page_postgres_harness.js";

describe("PageRepository PostgreSQL link projection", () => {
  let harness: PagePostgresHarness;
  let repository: PageRepository;

  beforeAll(async () => {
    harness = await createPagePostgresHarness();
    repository = new PageRepository(createLiveDbSqlResolver({ sql: harness.liveSql }));
  }, 60_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it("materializes every occurrence, resolves targets, and performs zero repeated writes", async () => {
    await store(repository, page("page-a", "A", [{ id: "block-a", text: "target" }]));
    await store(repository, page("page-source", "Source", [{
      id: "source-block",
      text: "[[A]] + [[Missing]] + ((block-a))",
      textDelta: [
        {
          insert: "[[A]]",
          attributes: { ref: { kind: "page", targetId: "page-a" } },
        },
        { insert: " + [[Missing]] + ((block-a))" },
      ],
    }]));

    const first = await linkRows(harness);
    expect(first).toMatchObject([
      {
        id: "block-link:source-block:0",
        link_kind: "inline_page",
        ordinal: 0,
        target_page_id: "page-a",
        target_title: "A",
        target_title_key: "a",
      },
      {
        id: "block-link:source-block:1",
        link_kind: "inline_page",
        ordinal: 1,
        target_page_id: null,
        target_title: "Missing",
        target_title_key: "missing",
      },
      {
        id: "block-link:source-block:2",
        link_kind: "block_ref",
        ordinal: 2,
        target_block_id: "block-a",
        target_block_ref: "block-a",
      },
    ]);

    await store(repository, page("page-source", "Source", [{
      id: "source-block",
      text: "[[A]] + [[Missing]] + ((block-a))",
      textDelta: [
        {
          insert: "[[A]]",
          attributes: { ref: { kind: "page", targetId: "page-a" } },
        },
        { insert: " + [[Missing]] + ((block-a))" },
      ],
    }]));

    const second = await linkRows(harness);
    expect(second.map(({ xmin }) => xmin)).toEqual(first.map(({ xmin }) => xmin));
  }, 30_000);

  it("resolves old unresolved links when a page is created or renamed", async () => {
    await store(repository, page("page-resolve-source", "Resolve Source", [{
      id: "resolve-block",
      text: "[[Created Later]] [[Renamed Later]]",
    }]));

    await store(repository, page("page-created-later", "Created Later"));
    await store(repository, page("page-rename-target", "Before Rename"));
    await store(repository, page("page-rename-target", "Renamed Later"));

    const rows = await harness.sql<readonly {
      target_title_key: string;
      target_page_id: string | null;
    }[]>`
      SELECT target_title_key, target_page_id
      FROM block_links
      WHERE source_block_id = 'resolve-block'
      ORDER BY ordinal
    `;
    expect(rows).toEqual([
      { target_title_key: "created later", target_page_id: "page-created-later" },
      { target_title_key: "renamed later", target_page_id: "page-rename-target" },
    ]);
  }, 30_000);

  it("keeps a resolved target through rename and nulls it on target deletion", async () => {
    await store(repository, page("page-stable-target", "Original Title"));
    const source = page("page-stable-source", "Stable Source", [{
      id: "stable-block",
      text: "[[Original Title]]",
    }]);
    await store(repository, source);

    await store(repository, page("page-stable-target", "Changed Title"));
    await store(repository, source);
    const [afterRename] = await harness.sql<readonly {
      target_page_id: string | null;
      target_title: string;
      target_title_key: string;
    }[]>`
      SELECT target_page_id, target_title, target_title_key
      FROM block_links WHERE source_block_id = 'stable-block'
    `;
    expect(afterRename).toEqual({
      target_page_id: "page-stable-target",
      target_title: "Original Title",
      target_title_key: "original title",
    });

    await harness.sql`DELETE FROM pages WHERE id = 'page-stable-target'`;
    await store(repository, source);
    const [afterDelete] = await harness.sql<readonly {
      target_page_id: string | null;
      target_title: string;
      target_title_key: string;
    }[]>`
      SELECT target_page_id, target_title, target_title_key
      FROM block_links WHERE source_block_id = 'stable-block'
    `;
    expect(afterDelete).toEqual({
      target_page_id: null,
      target_title: "Original Title",
      target_title_key: "original title",
    });
  }, 30_000);
});

async function store(repository: PageRepository, replica: PageYjsReplica): Promise<void> {
  await repository.storePageYjsState({
    documentName: `page:${replica.page.id}`,
    snapshot: new TextEncoder().encode(JSON.stringify(replica)),
    replica,
  });
}

function page(
  id: string,
  title: string,
  blocks: readonly {
    id: string;
    text: string;
    textDelta?: PageYjsReplica["blocks"][number]["textDelta"];
  }[] = [],
): PageYjsReplica {
  return {
    page: {
      id,
      title,
      dailyDate: null,
      mutationVersion: 1,
      archived: false,
      metadata: {},
    },
    blocks: blocks.map((block, index) => ({
      id: block.id,
      parentId: null,
      positionKey: String.fromCharCode(97 + index),
      type: "paragraph",
      text: block.text,
      textDelta: block.textDelta ?? [{ insert: block.text }],
      properties: {},
      collapsed: false,
    })),
  };
}

async function linkRows(harness: PagePostgresHarness) {
  return await harness.sql<readonly {
    id: string;
    link_kind: string;
    ordinal: number;
    target_page_id: string | null;
    target_title: string | null;
    target_title_key: string | null;
    target_block_id: string | null;
    target_block_ref: string | null;
    xmin: string;
  }[]>`
    SELECT id, link_kind, ordinal, target_page_id, target_title,
           target_title_key, target_block_id, target_block_ref,
           xmin::text AS xmin
    FROM block_links
    WHERE source_block_id = 'source-block'
    ORDER BY ordinal
  `;
}
