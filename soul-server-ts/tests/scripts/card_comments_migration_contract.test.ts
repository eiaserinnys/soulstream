import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrationSha256 } from "../../../packages/db-schema/scripts/migration-contract.mjs";

const migrationPath = new URL("../../../packages/db-schema/sql/migrations/111_card_comments.sql", import.meta.url);
const manifestPath = new URL("../../../packages/db-schema/migration-manifest.json", import.meta.url);
const schemaPath = new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url);

describe("card comments migration contract", () => {
  it("keeps migration 111 immutable and lets the canonical schema add notes", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { migrations: Array<{ id: string; sha256: string }> };
    const entry = manifest.migrations.find(item => item.id === "111_card_comments.sql");
    expect(entry?.sha256).toBe(migrationSha256(migration));

    const schema = readFileSync(schemaPath, "utf8");
    expect(migration).toContain("CREATE TABLE card_comments");
    expect(migration).toContain("id TEXT PRIMARY KEY");
    expect(migration).toContain("card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE");
    expect(migration).toMatch(/CHECK \(kind IN \('comment','spoken'\)\)/);
    expect(migration).not.toContain("'note'");
    expect(schema).toMatch(/ALTER TABLE card_comments\s+ADD COLUMN IF NOT EXISTS item_id INTEGER/);
    expect(schema).toContain("CHECK (kind IN ('comment','spoken','note'))");
    expect(schema).toContain("CREATE INDEX IF NOT EXISTS idx_card_comments_card ON card_comments(card_id, created_at)");
  });
});
