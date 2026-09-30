import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrationSha256 } from "../../../packages/db-schema/scripts/migration-contract.mjs";

const migrationPath = new URL("../../../packages/db-schema/sql/migrations/111_card_comments.sql", import.meta.url);
const manifestPath = new URL("../../../packages/db-schema/migration-manifest.json", import.meta.url);
const schemaPath = new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url);

describe("card comments migration contract", () => {
  it("registers migration 111 with its checksum and mirrors its table in schema.sql", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { migrations: Array<{ id: string; sha256: string }> };
    const entry = manifest.migrations.find(item => item.id === "111_card_comments.sql");
    expect(entry?.sha256).toBe(migrationSha256(migration));

    const schema = readFileSync(schemaPath, "utf8");
    expect(migration).toContain("CREATE TABLE card_comments");
    expect(migration).toContain("id TEXT PRIMARY KEY");
    expect(migration).toContain("card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE");
    const migrationTable = migration.match(/CREATE TABLE card_comments \([\s\S]*?\);/)?.[0];
    const schemaTable = schema.match(/CREATE TABLE(?: IF NOT EXISTS)? card_comments \([\s\S]*?\);/)?.[0]
      ?.replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE");
    const migrationIndex = migration.match(/CREATE INDEX idx_card_comments_card ON card_comments\(card_id, created_at\);/)?.[0];
    const schemaIndex = schema.match(/CREATE INDEX(?: IF NOT EXISTS)? idx_card_comments_card ON card_comments\(card_id, created_at\);/)?.[0]
      ?.replace("CREATE INDEX IF NOT EXISTS", "CREATE INDEX");
    expect(schemaTable).toBe(migrationTable);
    expect(schemaIndex).toBe(migrationIndex);
  });
});
