import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

describe("V1 sessions-row owner emergency rollback artifact", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 45_000);

  afterAll(async () => await harness.cleanup());

  it("restores legacy writers and can reapply the 073 drain-only cut", async () => {
    const rollbackSql = readArtifact(
      "../../../packages/db-schema/sql/rollback/073_sessions_execution_owner_v1_rollback.sql",
    );
    const migrationSql = readArtifact(
      "../../../packages/db-schema/sql/migrations/073_sessions_execution_owner_v1.sql",
    );
    const now = new Date("2026-08-27T00:00:00.000Z");
    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status, agent_id)
      VALUES ('v1-rollback', 'codex', 'initializing', 'v1-rollback')
    `;

    await harness.sql.unsafe(rollbackSql);
    const restored = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_ownership_v2(
        'v1-rollback', 1, 'in_process', 'manifest:rollback',
        'runtime:rollback', ${now}
      )
    `;
    expect(restored[0]?.applied).toBe(true);
    await expect(legacyWriterCount(harness)).resolves.toBe(1);

    await harness.sql`DELETE FROM session_execution_ownerships WHERE session_id = 'v1-rollback'`;
    await harness.sql.unsafe(migrationSql);
    const cut = await harness.sql<Array<{ applied: boolean }>>`
      SELECT * FROM session_reserve_execution_ownership_v2(
        'v1-rollback', 2, 'in_process', 'manifest:cut',
        'runtime:cut', ${now}
      )
    `;
    expect(cut[0]?.applied).toBe(false);
    await expect(legacyWriterCount(harness)).resolves.toBe(0);
  });
});

function readArtifact(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

async function legacyWriterCount(harness: FullSchemaPostgresHarness): Promise<number> {
  const rows = await harness.sql<Array<{ count: string | number }>>`
    SELECT COUNT(*)::int AS count FROM session_execution_ownerships
    WHERE session_id = 'v1-rollback'
  `;
  return Number(rows[0]?.count ?? 0);
}
