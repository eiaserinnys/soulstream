import { expect, it } from "vitest";
import { createPagePostgresHarness } from "./page/page_postgres_harness.js";
// @ts-expect-error JavaScript migration contract boundary, matching existing migration tests.
import { loadMigrationManifest } from "../../packages/db-schema/scripts/migration-contract.mjs";

it("applies check-item migration without changing existing card content", async () => {
  const migrations = await loadMigrationManifest();
  const numberMigration = migrations.find((candidate: { id: string; sql: string }) => candidate.id === "120_card_number.sql");
  const migration = migrations.find((candidate: { id: string; sql: string }) => candidate.id === "121_card_check_items.sql");
  expect(numberMigration).toBeDefined();
  expect(migration).toBeDefined();
  if (!numberMigration || !migration) return;

  const harness = await createPagePostgresHarness();
  try {
    await harness.sql`ALTER TABLE cards DROP COLUMN IF EXISTS items, DROP COLUMN IF EXISTS now`;
    await harness.sql`ALTER TABLE card_comments DROP COLUMN IF EXISTS item_id`;
    await harness.sql`ALTER TABLE card_comments DROP CONSTRAINT IF EXISTS card_comments_kind_check`;
    await harness.sql`ALTER TABLE card_comments ADD CONSTRAINT card_comments_kind_check CHECK (kind IN ('comment','spoken'))`;
    await harness.sql`INSERT INTO folders(id,name) VALUES ('items-folder','확인 항목 migration')`;
    await harness.sql`INSERT INTO cards(id,folder_id,position_key,title,request,status,version,updated_at)
      VALUES ('old-card','items-folder','a','기존 카드','기존 요청','running',7,'2026-10-01T10:00:00Z')`;
    await harness.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body,created_at)
      VALUES ('old-comment','old-card','user','comment','기존 커멘트','2026-10-01T10:01:00Z'),
             ('old-spoken','old-card','user','spoken','기존 발언','2026-10-01T10:02:00Z')`;
    await harness.sql`INSERT INTO card_reports(id,card_id,title,format,body,created_at)
      VALUES ('old-report','old-card','기존 보고','markdown','기존 보고 본문','2026-10-01T10:03:00Z')`;

    const before = await harness.sql`SELECT id,title,request,status,version,updated_at FROM cards WHERE id='old-card'`;
    const commentsBefore = await harness.sql`SELECT id,kind,body,created_at FROM card_comments WHERE card_id='old-card' ORDER BY id`;
    const reportsBefore = await harness.sql`SELECT id,title,body,created_at FROM card_reports WHERE card_id='old-card' ORDER BY id`;

    await harness.sql.unsafe(numberMigration.sql);
    const numberSchema = await harness.sql`SELECT
      EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='cards'::regclass AND attname='number' AND NOT attisdropped) AS has_number,
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='cards'::regclass AND conname='cards_live_number_check') AS has_number_check`;
    expect(numberSchema).toEqual([{ has_number: true, has_number_check: true }]);

    await harness.sql.unsafe(migration.sql);
    await harness.sql.unsafe(migration.sql);

    const oldCard = await harness.sql`SELECT id,title,request,status,version,updated_at,items,now FROM cards WHERE id='old-card'`;
    expect(oldCard).toEqual([{ ...before[0], items: [], now: null }]);
    expect(await harness.sql`SELECT id,kind,body,created_at,item_id FROM card_comments WHERE card_id='old-card' ORDER BY id`)
      .toEqual(commentsBefore.map((row) => ({ ...row, item_id: null })));
    expect(await harness.sql`SELECT id,title,body,created_at FROM card_reports WHERE card_id='old-card' ORDER BY id`).toEqual(reportsBefore);

    await harness.sql`INSERT INTO cards(id,folder_id,position_key,title) VALUES ('new-card','items-folder','b','새 카드')`;
    const newCard = await harness.sql`SELECT items,now FROM cards WHERE id='new-card'`;
    expect(newCard).toEqual([{ items: [], now: null }]);
    await harness.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body)
      VALUES ('new-note','old-card','agent','note','새 노트')`;
    await expect(harness.sql`UPDATE cards SET items=NULL WHERE id='new-card'`).rejects.toMatchObject({ code: "23502" });
    await expect(harness.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body)
      VALUES ('bad-kind','old-card','agent','unknown','잘못된 종류')`).rejects.toMatchObject({ code: "23514" });
  } finally {
    await harness.cleanup();
  }
}, 60000);
