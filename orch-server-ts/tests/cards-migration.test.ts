import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("ships cards migration and the single session link", () => {
  const migration = readFileSync(new URL("../../packages/db-schema/sql/migrations/109_cards.sql", import.meta.url), "utf8");
  expect(migration).toContain("ALTER TABLE checklist_items RENAME TO cards");
  expect(migration).toContain("card_dispatch");
  expect(migration).toContain("DROP COLUMN source_checklist_item_id");
  expect(migration).toContain("conflicting card links");
});
