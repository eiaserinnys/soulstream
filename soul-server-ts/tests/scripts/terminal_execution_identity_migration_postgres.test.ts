import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadMigrationManifest } from
  "../../../packages/db-schema/scripts/migration-contract.mjs";
import {
  hasTestDatabaseResource,
  provisionTestDatabase,
  type TestDatabaseLease,
} from "./database_test_harness.js";

const describeWithPostgres = hasTestDatabaseResource() ? describe : describe.skip;

describeWithPostgres("terminal execution identity migration", () => {
  let lease: TestDatabaseLease;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    lease = await provisionTestDatabase({
      prefix: "terminal_identity_upgrade",
      dockerUser: "terminal_identity_test",
      dockerPassword: "terminal_identity_test",
      dockerDatabase: "terminal_identity_test_db",
    });
    sql = postgres(lease.url, { max: 1, idle_timeout: 1 });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await lease?.cleanup();
  });

  it("upgrades a 079 database while preserving legacy replay and adding the new CAS", async () => {
    await createPost079Fixture(sql);
    const migrations = await loadMigrationManifest();
    const legacyMigration = migrations.find((item) =>
      item.id === "078_terminal_execution_ownership_retirement.sql"
    );
    if (!legacyMigration) throw new Error("078 migration is required by the upgrade fixture");
    await sql.unsafe(legacyMigration.sql);

    await insertLegacyOwnership(sql, "legacy-before-upgrade", 11);
    await expect(retireLegacyOwnership(sql, "legacy-before-upgrade", 11))
      .resolves.toBe(true);

    for (const migration of migrations.filter((item) => item.id.startsWith("080_"))) {
      await sql.unsafe(migration.sql);
    }

    await insertLegacyOwnership(sql, "persisted-legacy-replay", 12);
    await expect(retireLegacyOwnership(sql, "persisted-legacy-replay", 12))
      .resolves.toBe(true);

    await sql`
      INSERT INTO sessions (
        session_id, status, termination_event_id, execution_generation,
        execution_manifest_id, execution_runtime_env_identity,
        execution_registration_id, execution_pid, execution_start_identity,
        execution_command_id, execution_lease_expires_at
      ) VALUES (
        'recorded-terminal', 'error', 3, 13,
        'manifest-13', 'runtime-13', 'registration-13', 413,
        'node-start-13', 'owner-13', '2026-08-29T00:05:00.000Z'
      )
    `;
    const applied = await sql<Array<{ applied: boolean }>>`
      SELECT session_retire_recorded_terminal_execution_identity(
        'recorded-terminal', 13, 'manifest-13', 'runtime-13',
        'registration-13', 413, 'node-start-13', 'owner-13', 3
      ) AS applied
    `;
    expect(applied).toEqual([{ applied: true }]);
    const [session] = await sql<Array<Record<string, unknown>>>`
      SELECT execution_generation, execution_manifest_id,
             execution_runtime_env_identity, execution_registration_id,
             execution_pid, execution_start_identity, execution_command_id,
             execution_lease_expires_at, status, termination_event_id
      FROM sessions WHERE session_id = 'recorded-terminal'
    `;
    expect(session).toEqual({
      execution_generation: "13",
      execution_manifest_id: null,
      execution_runtime_env_identity: null,
      execution_registration_id: null,
      execution_pid: null,
      execution_start_identity: null,
      execution_command_id: null,
      execution_lease_expires_at: null,
      status: "error",
      termination_event_id: 3,
    });
  });
});

async function createPost079Fixture(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      status TEXT,
      termination_event_id INTEGER,
      execution_generation BIGINT NOT NULL DEFAULT 0,
      execution_manifest_id TEXT,
      execution_runtime_env_identity TEXT,
      execution_registration_id TEXT,
      execution_pid INTEGER,
      execution_start_identity TEXT,
      execution_command_id TEXT,
      execution_lease_expires_at TIMESTAMPTZ
    );
    CREATE TABLE session_execution_ownerships (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      ownership_generation BIGINT NOT NULL,
      owner_kind TEXT NOT NULL,
      manifest_id TEXT NOT NULL,
      registration_id TEXT,
      pid INTEGER,
      start_identity TEXT,
      execution_command_id TEXT,
      phase TEXT NOT NULL,
      runner_fact TEXT,
      reservation_expires_at TIMESTAMPTZ,
      terminal_at TIMESTAMPTZ,
      failure_reason TEXT,
      PRIMARY KEY (session_id, ownership_generation)
    );
  `);
}

async function insertLegacyOwnership(
  sql: ReturnType<typeof postgres>,
  sessionId: string,
  generation: number,
): Promise<void> {
  await sql`INSERT INTO sessions (session_id, status) VALUES (${sessionId}, 'error')`;
  await sql`
    INSERT INTO session_execution_ownerships (
      session_id, ownership_generation, owner_kind, manifest_id,
      registration_id, pid, start_identity, execution_command_id, phase
    ) VALUES (
      ${sessionId}, ${generation}, 'runner_process', ${`manifest-${generation}`},
      ${`registration-${generation}`}, ${400 + generation},
      ${`node-start-${generation}`}, ${`owner-${generation}`}, 'active'
    )
  `;
}

async function retireLegacyOwnership(
  sql: ReturnType<typeof postgres>,
  sessionId: string,
  generation: number,
): Promise<boolean> {
  const rows = await sql<Array<{ applied: boolean }>>`
    SELECT session_retire_terminal_execution_ownership(
      ${sessionId}, ${generation}, ${`manifest-${generation}`},
      ${`registration-${generation}`}, ${400 + generation},
      ${`node-start-${generation}`}, ${`owner-${generation}`},
      'reaped', '2026-08-29T00:00:00.000Z'
    ) AS applied
  `;
  return rows[0]?.applied ?? false;
}
