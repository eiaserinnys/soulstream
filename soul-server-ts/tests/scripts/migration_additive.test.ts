import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { classifyMigrationSql } from "../../../packages/db-schema/scripts/migration-additive.mjs";

const migrationDirectory = new URL("../../../packages/db-schema/sql/migrations/", import.meta.url);
const files = readdirSync(migrationDirectory);
function migration(prefix: string) {
  const file = files.find((name) => name.startsWith(`${prefix}_`));
  if (!file) throw new Error(`missing migration ${prefix}`);
  return readFileSync(new URL(file, migrationDirectory), "utf8");
}

describe("additive migration classification", () => {
  it.each(["162", "163", "164", "165", "166", "167", "168", "169", "170"])(
    "recognizes real migration %s", (prefix) => {
      expect(classifyMigrationSql(migration(prefix))).toEqual({ additive: true, offending: null });
    },
  );
  it.each(["154", "159", "160"])("fails closed for real migration %s", (prefix) => {
    expect(classifyMigrationSql(migration(prefix)).additive).toBe(false);
  });
  it.each([
    "-- DROP TABLE t;\n CREATE TABLE IF NOT EXISTS t (v text DEFAULT 'a; DROP TABLE t'); /* nested /* ; */ ok */ CREATE UNIQUE INDEX IF NOT EXISTS ix ON t(v);",
    "CREATE TABLE IF NOT EXISTS \"My.Schema\".\"t\" (v text); CREATE UNIQUE INDEX IF NOT EXISTS ix ON \"My.Schema\".\"t\" (v)",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a numeric(10, 2) NOT NULL DEFAULT -1.5::numeric(10, 2)",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a timestamp with time zone DEFAULT NULL",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a text DEFAULT 'ok'::text NOT NULL",
    "ALTER TABLE t SET (autovacuum_analyze_threshold = 50000)",
    "COMMENT ON COLUMN t.a IS 'DROP; TABLE'",
  ])("allows the explicit additive forms: %s", (sql) => {
    expect(classifyMigrationSql(sql)).toEqual({ additive: true, offending: null });
  });
  it.each([
    "CREATE INDEX ix ON t (v)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ix ON existing (v)",
    "CREATE INDEX CONCURRENTLY IF NOT EXISTS ix ON t (v)",
    "CREATE TABLE IF NOT EXISTS t (v int); CREATE UNIQUE INDEX IF NOT EXISTS ix ON other (v)",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a text NOT NULL",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a text DEFAULT now()",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a text DEFAULT 'x'::text || dangerous()",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a text REFERENCES other(id)",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a int CHECK (a > 0)",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a int GENERATED ALWAYS AS (1) STORED",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a int UNIQUE",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a int PRIMARY KEY",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a int, DROP COLUMN old",
    "ALTER TABLE t ADD COLUMN IF NOT EXISTS a text DEFAULT 'x'::text, DROP COLUMN old",
    "ALTER TABLE t SET (autovacuum_enabled = true), DROP COLUMN old",
    "DROP TABLE t", "ALTER TABLE t RENAME TO u", "ALTER TABLE t ALTER COLUMN a TYPE int",
    "ALTER TABLE t ADD CONSTRAINT x CHECK (true)",
    "DO $$ BEGIN EXECUTE 'DROP TABLE t'; END $$",
    "INSERT INTO t VALUES (1)", "UPDATE t SET a = 1",
    "CREATE TABLE IF NOT EXISTS t AS SELECT dangerous()",
    "CREATE TABLE IF NOT EXISTS t (x text); DROP TABLE t",
    "CREATE TABLE IF NOT EXISTS t (x text DEFAULT 'unterminated)",
    "CREATE TABLE IF NOT EXISTS t (x text); /* unterminated",
    "CREATE TABLE IF NOT EXISTS t (x text DEFAULT $tag$unterminated)",
    "-- no statements",
  ])("rejects unsafe, unknown or malformed SQL: %s", (sql) => {
    const result = classifyMigrationSql(sql);
    expect(result.additive).toBe(false);
    expect(result.offending).toBeTruthy();
  });
});
