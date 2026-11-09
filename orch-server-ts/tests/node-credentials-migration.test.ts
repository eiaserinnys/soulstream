import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";
// @ts-expect-error JavaScript migration contract boundary, matching existing migration tests.
import { loadMigrationManifest } from "../../packages/db-schema/scripts/migration-contract.mjs";

const MIGRATION_ID = "150_node_credentials.sql";

it("registers the node credentials migration in the manifest and mirror schema", async () => {
  const migrations = await loadMigrationManifest();
  const migration = migrations.find(
    (candidate: { id: string }) => candidate.id === MIGRATION_ID,
  ) as { id: string; sql: string } | undefined;

  expect(migration).toBeDefined();
  const sql = migration!.sql;
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS node_credentials");
  expect(sql).toContain("credential_id UUID PRIMARY KEY");
  expect(sql).toContain("node_id TEXT NOT NULL");
  expect(sql).toContain("company_pc BOOLEAN NOT NULL");
  expect(sql).toContain("token_sha256 CHAR(64) NOT NULL UNIQUE");
  expect(sql).toContain("revoked_at TIMESTAMPTZ");
  expect(sql).toContain("WHERE revoked_at IS NULL");

  const schema = await readFile(
    new URL("../../packages/db-schema/sql/schema.sql", import.meta.url),
    "utf8",
  );
  expect(schema).toContain("CREATE TABLE IF NOT EXISTS node_credentials");
  expect(schema).toContain("uq_node_credentials_active_node");
  expect(schema).toContain("WHERE revoked_at IS NULL");
});
