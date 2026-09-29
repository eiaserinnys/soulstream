import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type postgres from "postgres";

// Frozen schema.sql from 6469bcd6. Historical upgrade tests must start with the
// actual preceding schema, not partially undo DDL in the current folder schema.
export async function restorePreFolderSchema(sql: ReturnType<typeof postgres>) {
  const ledger = await sql`SELECT * FROM schema_migrations WHERE migration_id <> '108_unify_folders.sql'`;
  const schema = gunzipSync(readFileSync(new URL(
    "../db/fixtures/folder_schema_pre_108_6469bcd6.sql.gz", import.meta.url,
  )));
  if (createHash("sha256").update(schema).digest("hex") !==
      "7907195bef6959f4e8bc89c66e578d0f9bf001dca5ef2965473f592d59f1805b") {
    throw new Error("historical schema fixture checksum differs");
  }
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await sql.unsafe(schema.toString("utf8"));
  await sql.unsafe(`CREATE TABLE schema_migrations (
    migration_id TEXT PRIMARY KEY, checksum TEXT NOT NULL,
    release_id TEXT NOT NULL, ordinal INTEGER NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), applied_kind TEXT NOT NULL
  )`);
  if (ledger.length) await sql`INSERT INTO schema_migrations ${sql(ledger)}`;
}
