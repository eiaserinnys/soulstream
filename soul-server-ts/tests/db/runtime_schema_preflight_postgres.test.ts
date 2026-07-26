import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertRuntimeSchemaReady,
  REQUIRED_RUNTIME_MIGRATIONS,
} from "../../src/db/runtime_schema_preflight.js";
import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres =
  hasFullSchemaPostgresBackend || hasDockerBinary() ? describe : describe.skip;

describePostgres("persistent runtime schema preflight PostgreSQL", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    await harness.sql.unsafe(`
      CREATE TABLE schema_migrations (
        migration_id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        ordinal INTEGER NOT NULL UNIQUE,
        applied_kind TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }, 45_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("refuses startup until the published baseline and runtime tail are exact", async () => {
    const [published, ...runtimeTail] = REQUIRED_RUNTIME_MIGRATIONS;
    await insertMigration(published);

    await expect(assertRuntimeSchemaReady(harness.sql)).rejects.toThrow(
      "required migration 045_session_deliveries.sql@46",
    );

    for (const migration of runtimeTail) await insertMigration(migration);
    await expect(assertRuntimeSchemaReady(harness.sql)).resolves.toBeUndefined();

    await harness.sql`
      UPDATE schema_migrations
      SET checksum = ${"0".repeat(64)}
      WHERE ordinal = 48
    `;
    await expect(assertRuntimeSchemaReady(harness.sql)).rejects.toThrow(
      "required migration 047_session_delivery_relation_consumptions.sql@48",
    );
  });

  async function insertMigration(
    migration: (typeof REQUIRED_RUNTIME_MIGRATIONS)[number],
  ): Promise<void> {
    await harness.sql`
      INSERT INTO schema_migrations (
        migration_id, checksum, ordinal, applied_kind
      ) VALUES (
        ${migration.migrationId}, ${migration.checksum},
        ${migration.ordinal}, 'migration'
      )
    `;
  }
});

function hasDockerBinary(): boolean {
  return spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
}
