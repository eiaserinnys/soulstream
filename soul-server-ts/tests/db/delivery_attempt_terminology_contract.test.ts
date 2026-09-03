import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  loadMigrationManifest,
  migrationSha256,
} from "../../../packages/db-schema/scripts/migration-contract.mjs";
import {
  hasTestDatabaseResource,
  provisionTestDatabase,
  type TestDatabaseLease,
} from "../scripts/database_test_harness.js";
import {
  createPre086Fixture,
  readAttemptColumnShape,
  readFunctionBodies,
  readSentinelRows,
  readSupersededDelivery,
} from "./delivery_attempt_terminology_harness.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MIGRATION_ID = "086_delivery_attempt_terminology.sql";
const MIGRATION_PATH = join(
  REPOSITORY_ROOT,
  "packages/db-schema/sql/migrations",
  MIGRATION_ID,
);
const LOCK_ORDER_MIGRATION_PATH = join(
  REPOSITORY_ROOT,
  "packages/db-schema/sql/migrations/087_delivery_notification_lock_order.sql",
);
const SCHEMA_PATH = join(REPOSITORY_ROOT, "packages/db-schema/sql/schema.sql");

const DELIVERY_SOURCE_FILES = [
  "orch-server-ts/src/control_plane/persistence_host_routes.ts",
  "orch-server-ts/src/control_plane/repositories/session_delivery_attempt_repository.ts",
  "orch-server-ts/src/control_plane/repositories/session_delivery_notification_repository.ts",
  "orch-server-ts/src/control_plane/repositories/session_delivery_recovery_repository.ts",
  "orch-server-ts/src/control_plane/repositories/session_delivery_repository.ts",
  "orch-server-ts/src/execute/execute_proxy_payloads.ts",
  "orch-server-ts/src/production.ts",
  "orch-server-ts/src/runtime/live_execute_proxy_route_provider.ts",
  "orch-server-ts/src/session/session_action_command_payloads.ts",
  "soul-server-ts/src/control_plane/persistence_host_clients.ts",
  "soul-server-ts/src/task/completion_delivery_coordinator.ts",
  "soul-server-ts/src/task/completion_notifier.ts",
  "soul-server-ts/src/task/delivery_contract.ts",
  "soul-server-ts/src/task/delivery_row_intervention.ts",
  "soul-server-ts/src/task/notification_receipt_projection.ts",
  "soul-server-ts/src/task/queued_delivery_transcript_recovery.ts",
  "soul-server-ts/src/task/session_delivery_notification_recovery.ts",
  "soul-server-ts/src/task/task_delivery_ledger_gate.ts",
  "soul-server-ts/src/task/task_intervention_route.ts",
  "soul-server-ts/src/task/task_manager.ts",
  "soul-server-ts/src/task/task_models.ts",
] as const;

const DELIVERY_PATHMAPS = [
  "docs/pathmaps/delivery-ledger.md",
  "docs/pathmaps/message-to-terminal.md",
  "docs/pathmaps/restart-recovery.md",
  "docs/pathmaps/timers-inventory.md",
  "docs/notification-outbox-recovery.md",
] as const;

const RETIRED_DELIVERY_TERMS = [
  "DEFAULT_NOTIFICATION_LEASE_MS",
  "TRANSCRIPT_LEASE_MS",
  "deliveryLeaseOwner",
  "delivery_lease_owner",
  "requiredLeaseOwner",
  "attempt_lease_owner",
  "claimForTarget",
  "retryLeasedDelivery",
  "releaseExpiredDeliveryLeases",
  "releaseExpiredLeases",
  "claim_for_target",
  "retry_leased_delivery",
  "release_expired_delivery_leases",
  "release_expired_notification_leases",
  "delivery lease expired",
  "delivery lease",
  "notification lease",
  "dispatch lease",
  "admission lease",
  "claim lease",
  "leased delivery",
  "delivery ownership",
  "ownership collision",
  "ownership retries",
  "OWNERSHIP_CONFLICT_RETRY_MAX_DELAY_MS",
  "LEASE_OWNER",
  "delivery_lease_expires_at",
  "notification_lease_owner",
  "notification_lease_expires_at",
  "ms lease",
] as const;

const RETIRED_GENERIC_ATTEMPT_TERMS = [
  "leaseOwner",
  "leaseExpiresAt",
  "leaseMs",
] as const;

function findTerms(source: string, terms: readonly string[]): string[] {
  return terms.filter((term) => source.includes(term));
}

function readSources(directory: string): Array<{ path: string; source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readSources(path);
    if (!entry.isFile() || !/\.(?:ts|mjs)$/.test(entry.name)) return [];
    if (entry.name.startsWith("delivery_attempt_terminology_")) return [];
    return [{ path, source: readFileSync(path, "utf8") }];
  });
}

describe("Wave 4 delivery attempt terminology", () => {
  it("proves the retired-name detector catches an injected violation", () => {
    expect(findTerms("deliveryLeaseOwner leaseMs", [
      ...RETIRED_DELIVERY_TERMS,
      ...RETIRED_GENERIC_ATTEMPT_TERMS,
    ])).toEqual(["deliveryLeaseOwner", "leaseMs"]);
  });

  it("removes delivery lease and ownership terminology from runtime contracts", () => {
    const broadSources = [
      ...readSources(join(REPOSITORY_ROOT, "orch-server-ts/src")),
      ...readSources(join(REPOSITORY_ROOT, "orch-server-ts/tests")),
      ...readSources(join(REPOSITORY_ROOT, "soul-server-ts/src")),
      ...readSources(join(REPOSITORY_ROOT, "soul-server-ts/tests")),
      ...readSources(join(REPOSITORY_ROOT, "scripts/lab-node")),
      ...DELIVERY_PATHMAPS.map((path) => ({
        path: join(REPOSITORY_ROOT, path),
        source: readFileSync(join(REPOSITORY_ROOT, path), "utf8"),
      })),
    ];
    const retiredViolations = broadSources.flatMap(({ path, source }) =>
      findTerms(source, RETIRED_DELIVERY_TERMS).map((term) => ({ path, term }))
    );
    const genericViolations = DELIVERY_SOURCE_FILES.flatMap((path) => {
      const source = readFileSync(join(REPOSITORY_ROOT, path), "utf8");
      return findTerms(source, RETIRED_GENERIC_ATTEMPT_TERMS)
        .map((term) => ({ path, term }));
    });

    expect(retiredViolations).toEqual([]);
    expect(genericViolations).toEqual([]);
  });

  it("registers a checksum-pinned non-destructive 086 rename migration", async () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    const manifest = await loadMigrationManifest();
    const entry = manifest.find((item) => item.id === MIGRATION_ID);

    expect(entry).toMatchObject({
      id: MIGRATION_ID,
      sha256: migrationSha256(migration),
    });
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "id", "ordinal", "path", "sha256", "sql",
    ]);
    expect(migration.match(/RENAME COLUMN/g)).toHaveLength(5);
    expect(migration).not.toContain("DROP COLUMN");
    expect(migration).not.toContain("CREATE OR REPLACE FUNCTION");
    expect(migration).toContain(
      "DROP FUNCTION IF EXISTS session_discard_notification_projection_on_consumed()",
    );
    expect(migration).toContain(
      "CREATE FUNCTION session_discard_notification_projection_on_consumed()",
    );
    expect(migration).toContain(
      "DROP FUNCTION IF EXISTS session_record_execution_registration(",
    );
    expect(migration).toContain(
      "CREATE FUNCTION session_record_execution_registration(",
    );
    expect(migration).toContain(
      "DROP FUNCTION IF EXISTS session_apply_running_transition(",
    );
    expect(migration).toContain(
      "CREATE FUNCTION session_apply_running_transition(",
    );
  });

  it("keeps the canonical delivery schema on attempt terminology", () => {
    const schema = readFileSync(SCHEMA_PATH, "utf8");
    const deliverySchema = schema.slice(
      0,
      schema.indexOf("CREATE TABLE IF NOT EXISTS checklist_task_projection_outbox"),
    );

    expect(deliverySchema).not.toMatch(/\blease_owner\b|\blease_expires_at\b/);
    expect(deliverySchema).toContain("attempt_token");
    expect(deliverySchema).toContain("attempt_expires_at");
  });
});

const describeWithPostgres = hasTestDatabaseResource() ? describe : describe.skip;

describeWithPostgres.sequential("086 delivery attempt terminology migration", () => {
  let database: TestDatabaseLease;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    database = await provisionTestDatabase({
      prefix: "delivery_attempt_086",
      dockerUser: "delivery_attempt_test",
      dockerPassword: "delivery_attempt_test",
      dockerDatabase: "delivery_attempt_test_db",
    });
    sql = postgres(database.url, { max: 1, idle_timeout: 1 });
  }, 45_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await database?.cleanup();
  });

  it("preserves rows and makes fully migrated and fresh delivery schemas equivalent", async () => {
    await sql.unsafe("CREATE SCHEMA migrated; SET search_path TO migrated");
    await createPre086Fixture(sql);
    await sql.unsafe(readFileSync(MIGRATION_PATH, "utf8"));

    const migratedRows = await readSentinelRows(sql, "migrated");
    expect(migratedRows).toEqual({
      delivery: {
        attempt_token: "delivery-token",
        attempt_expires_at: new Date("2030-01-01T00:00:00.000Z"),
      },
      notification: {
        attempt_token: "notification-token",
        attempt_expires_at: new Date("2030-01-02T00:00:00.000Z"),
      },
      attempt: { attempt_token: "attempt-token" },
    });
    await sql.unsafe(readFileSync(LOCK_ORDER_MIGRATION_PATH, "utf8"));

    await sql.unsafe("CREATE SCHEMA fresh; SET search_path TO fresh");
    await sql.unsafe(readFileSync(SCHEMA_PATH, "utf8"));

    expect(await readAttemptColumnShape(sql, "migrated"))
      .toEqual(await readAttemptColumnShape(sql, "fresh"));
    expect(await readFunctionBodies(sql, "migrated"))
      .toEqual(await readFunctionBodies(sql, "fresh"));

    await sql.unsafe("SET search_path TO migrated");
    await sql`
      INSERT INTO sessions (
        session_id, status, termination_reason, termination_detail,
        review_state, last_assistant_text, termination_event_id,
        execution_registration_id, execution_command_id, updated_at, last_event_id
      ) VALUES (
        'source-1', 'completed', 'completed', 'done',
        'not_required', 'finished', 7,
        NULL, NULL, '2030-01-03T00:00:00.000Z', 7
      )
    `;
    await sql`
      UPDATE session_deliveries
      SET source_session_id = 'source-1',
          source = 'completion_notifier',
          producer_kind = 'child_session',
          producer_terminal_revision = '7'
      WHERE delivery_id = 'delivery-1'
    `;
    const [runningTransition] = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM session_apply_running_transition(
        'source-1', 'not_required', 7, TRUE, '2030-01-04T00:00:00.000Z'
      )
    `;
    expect(runningTransition).toMatchObject({ applied: true, status: "running" });
    expect(await readSupersededDelivery(sql)).toMatchObject({
      aggregate_state: "consumed",
      attempt_token: null,
      attempt_expires_at: null,
    });

    await sql`
      UPDATE sessions
      SET status = 'completed', termination_reason = 'completed',
          termination_detail = 'done again', termination_event_id = 8,
          execution_registration_id = NULL, execution_command_id = NULL
      WHERE session_id = 'source-1'
    `;
    await sql`
      UPDATE session_deliveries
      SET state = 'claimed', aggregate_state = 'pending',
          consumed_at = NULL, consumed_reason = NULL, superseded_at = NULL,
          superseded_terminal_revision = NULL,
          producer_terminal_revision = '8', attempt_token = 'second-token',
          attempt_expires_at = '2030-01-05T00:00:00.000Z'
      WHERE delivery_id = 'delivery-1'
    `;
    const [registrationTransition] = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM session_record_execution_registration(
        'source-1', 'registration-1', 'command-1', 'not_required',
        8, TRUE, '2030-01-06T00:00:00.000Z'
      )
    `;
    expect(registrationTransition).toMatchObject({
      applied: true,
      execution_registration_id: "registration-1",
      execution_command_id: "command-1",
      status: "running",
    });
    expect(await readSupersededDelivery(sql)).toMatchObject({
      aggregate_state: "consumed",
      attempt_token: null,
      attempt_expires_at: null,
    });

    const retiredProjectionTrigger = await sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM pg_trigger
      WHERE tgname = 'trg_session_discard_notification_projection'
        AND NOT tgisinternal
    `;
    expect(retiredProjectionTrigger).toEqual([{ count: 0 }]);

    const indexDefinitions = await sql<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'migrated'
        AND indexname IN (
          'idx_session_deliveries_recovery',
          'idx_session_delivery_notification_recovery'
        )
      ORDER BY indexname
    `;
    expect(indexDefinitions.map((row) => row.indexdef).join("\n"))
      .not.toContain("lease_expires_at");
    expect(indexDefinitions.map((row) => row.indexdef).join("\n"))
      .toContain("attempt_expires_at");
  }, 45_000);
});
