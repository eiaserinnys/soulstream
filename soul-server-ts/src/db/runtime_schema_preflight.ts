import type { SqlClient } from "./session_db_types.js";

export interface RequiredRuntimeMigration {
  ordinal: number;
  migrationId: string;
  checksum: string;
}

/**
 * Release schema boundary for the default-ON persistent runtime.
 *
 * The published metadata-search migration remains ordinal 45. Runtime
 * migrations are appended after it; changing any tuple here must fail the
 * manifest contract test before a worker can start against an older schema.
 */
export const REQUIRED_RUNTIME_MIGRATIONS: readonly RequiredRuntimeMigration[] = [
  {
    ordinal: 45,
    migrationId: "044_session_metadata_search.sql",
    checksum: "79cbf2d4731a922cb6c9463f919507748aefde692fc9a0b6f9010d7f3b68f362",
  },
  {
    ordinal: 46,
    migrationId: "045_session_deliveries.sql",
    checksum: "f914ac0c167a4b2a14476bf211f94994c77f8dade3a05702bb86c62642d5e4cf",
  },
  {
    ordinal: 47,
    migrationId: "046_claude_background_tasks.sql",
    checksum: "e2546369b90060baaabaddb25e7cb04ecd6c4e164e8c26e7ff041cbed80ba68d",
  },
  {
    ordinal: 48,
    migrationId: "047_session_delivery_relation_consumptions.sql",
    checksum: "0f48af08fee35aa57d1609bde856d60578cdb7e77b62a141b6f639b25adbff19",
  },
] as const;

interface AppliedMigrationRow {
  ordinal: number;
  migration_id: string;
  checksum: string;
}

export async function assertRuntimeSchemaReady(sql: SqlClient): Promise<void> {
  let rows: AppliedMigrationRow[];
  try {
    rows = await sql<AppliedMigrationRow[]>`
      SELECT ordinal, migration_id, checksum
      FROM schema_migrations
      WHERE ordinal BETWEEN 45 AND 48
      ORDER BY ordinal
    `;
  } catch (error) {
    throw new Error(
      "Persistent Claude runtime schema preflight failed: "
      + "migration ledger is unavailable",
      { cause: error },
    );
  }

  for (const required of REQUIRED_RUNTIME_MIGRATIONS) {
    const applied = rows.find((row) => row.ordinal === required.ordinal);
    if (
      !applied
      || applied.migration_id !== required.migrationId
      || applied.checksum !== required.checksum
    ) {
      throw new Error(
        "Persistent Claude runtime schema preflight failed: "
        + `required migration ${required.migrationId}@${required.ordinal} `
        + "is missing or differs from this release",
      );
    }
  }
}
