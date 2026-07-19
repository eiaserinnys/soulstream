#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import dotenv from "dotenv";
import postgres from "postgres";

import {
  MIGRATION_LOCK_ID,
  MIGRATION_LOCK_NAMESPACE,
  assertLegacyBackupResolved,
  buildMigrationPlan,
  canonicalSchemaPath,
  deploymentEnvironmentPath,
  destructivePending,
  legacyRetirementPending,
  loadLegacyBackupContract,
  loadMigrationManifest,
  readDatabaseUrl,
  readReleaseId,
  rollbackUnsafePending,
  validateBackupGate,
} from "./migration-contract.mjs";
import { readVerifiedClusterWriteFence } from "./cluster-write-fence.mjs";
import { assertPostgresBackupPrerequisites } from "./postgres-backup-tools.mjs";

const MODES = new Set([
  "preflight",
  "apply",
  "verify",
  "fresh-install",
  "initialize",
  "recover",
]);

export async function inspectSchemaShape(sql) {
  const [relations, columns] = await Promise.all([
    sql`
      SELECT
        (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('sessions')) AS sessions,
        (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('tasks')) AS tasks,
        (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('task_sections'))
          AS task_sections,
        (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('runbooks')) AS runbooks,
        (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('runbook_items'))
          AS runbook_items,
        (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('task_items')) AS task_items,
        (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('task_operations'))
          AS task_operations,
        (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('runbook_operations'))
          AS runbook_operations
    `,
    sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'task_items'
        AND column_name IN ('parent_id', 'section_id')
    `,
  ]);
  const names = new Set(columns.map((row) => row.column_name));
  return {
    sessions: relations[0]?.sessions ?? null,
    tasks: relations[0]?.tasks ?? null,
    taskSections: relations[0]?.task_sections ?? null,
    runbooks: relations[0]?.runbooks ?? null,
    runbookItems: relations[0]?.runbook_items ?? null,
    taskItems: relations[0]?.task_items ?? null,
    taskOperations: relations[0]?.task_operations ?? null,
    runbookOperations: relations[0]?.runbook_operations ?? null,
    taskItemsHasParent: names.has("parent_id"),
    taskItemsHasSection: names.has("section_id"),
  };
}

export async function readMigrationLedger(sql) {
  const table = await sql`
    SELECT to_regclass('schema_migrations')::text AS name
  `;
  if (!table[0]?.name) return [];
  return await sql`
    SELECT migration_id, checksum, release_id, ordinal, applied_at, applied_kind
    FROM schema_migrations
    ORDER BY ordinal
  `;
}

export async function readMigrationPlan(sql, migrations = null) {
  const inventory = migrations ?? await loadMigrationManifest();
  const [ledger, shape] = await Promise.all([
    readMigrationLedger(sql),
    inspectSchemaShape(sql),
  ]);
  return {
    migrations: inventory,
    ledger,
    shape,
    ...buildMigrationPlan(inventory, ledger, shape),
  };
}

async function ensureLedger(sql) {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
      release_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL UNIQUE CHECK (ordinal > 0),
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_kind TEXT NOT NULL CHECK (
        applied_kind IN ('bootstrap', 'migration', 'fresh_install', 'recovery')
      )
    )
  `);
}

async function recordMigration(sql, migration, releaseId, appliedKind) {
  await sql`
    INSERT INTO schema_migrations (
      migration_id, checksum, release_id, ordinal, applied_kind
    ) VALUES (
      ${migration.id}, ${migration.sha256}, ${releaseId},
      ${migration.ordinal}, ${appliedKind}
    )
  `;
}

function planReport(mode, plan) {
  return {
    status: "ok",
    mode,
    schema_state: plan.state,
    ledger_count: plan.ledger.length,
    bootstrap: plan.bootstrap.map((item) => item.id),
    pending: plan.pending.map((item) => item.id),
    destructive_pending: destructivePending(plan).map((item) => item.id),
    rollback_unsafe_pending: rollbackUnsafePending(plan).map((item) => item.id),
  };
}

async function assertDestructivePreflight(plan) {
  if (!legacyRetirementPending(plan)) return;
  assertLegacyBackupResolved(await loadLegacyBackupContract());
}

export async function preflightPendingMigrations(
  plan,
  {
    env = process.env,
    backupPreflight = assertPostgresBackupPrerequisites,
    fencePreflight = readVerifiedClusterWriteFence,
  } = {},
) {
  const destructive = destructivePending(plan);
  const rollbackUnsafe = rollbackUnsafePending(plan);
  if (rollbackUnsafe.length === 0) {
    return {
      destructive_pending: [],
      rollback_unsafe_pending: [],
      backup_prerequisites: "not_required",
      cluster_write_fence: "not_required",
    };
  }
  await assertDestructivePreflight(plan);
  const fence = await fencePreflight(env);
  const prerequisites = await backupPreflight({
    databaseUrl: readDatabaseUrl(env),
    env,
  });
  return {
    destructive_pending: destructive.map((migration) => migration.id),
    rollback_unsafe_pending: rollbackUnsafe.map((migration) => migration.id),
    backup_prerequisites: prerequisites,
    cluster_write_fence: fence.status,
  };
}

async function readVerifiedBackupGate(env, plan) {
  const directory = env.HANIEL_BACKUP_DIR?.trim();
  if (!directory) throw new Error("HANIEL_BACKUP_DIR is required for destructive migration");
  const gate = JSON.parse(
    await readFile(resolve(directory, "database-backup.json"), "utf8"),
  );
  return validateBackupGate(
    gate,
    env,
    rollbackUnsafePending(plan).map((migration) => migration.id),
  );
}

export async function assertRollbackUnsafeApplyGates(
  plan,
  env = process.env,
  {
    fenceRead = readVerifiedClusterWriteFence,
    backupGateRead = readVerifiedBackupGate,
  } = {},
) {
  const rollbackUnsafe = rollbackUnsafePending(plan);
  if (rollbackUnsafe.length === 0) {
    return { rollback_unsafe_pending: [], gates: "not_required" };
  }
  await fenceRead(env);
  await backupGateRead(env, plan);
  return {
    rollback_unsafe_pending: rollbackUnsafe.map((migration) => migration.id),
    gates: "verified",
  };
}

async function applyPending(sql, migrations, releaseId, appliedKind) {
  return await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_ID})`;
    const plan = await readMigrationPlan(tx, migrations);
    if (plan.state === "empty") {
      throw new Error("normal migration cannot initialize an empty database; use fresh-install");
    }
    await ensureLedger(tx);
    for (const migration of plan.bootstrap) {
      await recordMigration(tx, migration, releaseId, "bootstrap");
    }
    for (const migration of plan.pending) {
      await tx.unsafe(migration.sql);
      await recordMigration(tx, migration, releaseId, appliedKind);
    }
    return plan;
  });
}

async function freshInstall(sql, migrations, releaseId) {
  return await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_ID})`;
    const plan = await readMigrationPlan(tx, migrations);
    if (plan.state !== "empty" || plan.ledger.length > 0) {
      throw new Error("fresh-install requires an empty database");
    }
    await tx.unsafe(await readFile(canonicalSchemaPath, "utf8"));
    await ensureLedger(tx);
    for (const migration of migrations) {
      await recordMigration(tx, migration, releaseId, "fresh_install");
    }
    return plan;
  });
}

export async function runMigrations(
  mode,
  { env = process.env, cwd = process.cwd(), sql: injectedSql = null } = {},
) {
  if (!MODES.has(mode)) throw new Error(`unknown migration mode: ${mode}`);
  dotenv.config({
    path: deploymentEnvironmentPath(env, cwd),
    override: true,
    processEnv: env,
  });
  const migrations = await loadMigrationManifest();
  const releaseId = readReleaseId(env, { required: mode !== "verify" });
  const sql = injectedSql ?? postgres(readDatabaseUrl(env), {
    max: 1,
    idle_timeout: 1,
    connect_timeout: 5,
  });

  try {
    const initial = await readMigrationPlan(sql, migrations);
    if (mode === "preflight") {
      const preflight = await preflightPendingMigrations(initial, { env });
      return { ...planReport(mode, initial), ...preflight };
    }
    if (mode === "verify") {
      if (initial.bootstrap.length > 0 || initial.pending.length > 0) {
        throw new Error(
          `migration ledger incomplete: bootstrap=${initial.bootstrap.length}, pending=${initial.pending.length}`,
        );
      }
      if (initial.state !== "current") {
        throw new Error(`migration ledger is complete but schema state is ${initial.state}`);
      }
      return planReport(mode, initial);
    }
    if (mode === "fresh-install" || (mode === "initialize" && initial.state === "empty")) {
      await freshInstall(sql, migrations, releaseId);
    } else {
      await assertDestructivePreflight(initial);
      await assertRollbackUnsafeApplyGates(initial, env);
      await applyPending(
        sql,
        migrations,
        releaseId,
        mode === "recover" ? "recovery" : "migration",
      );
    }
    const finalPlan = await readMigrationPlan(sql, migrations);
    if (finalPlan.bootstrap.length > 0 || finalPlan.pending.length > 0) {
      throw new Error("migration command returned with an incomplete ledger");
    }
    return planReport(mode, finalPlan);
  } finally {
    if (!injectedSql) await sql.end({ timeout: 5 });
  }
}

export function formatMigrationError(error, env = process.env) {
  let text = error instanceof Error ? error.stack ?? error.message : String(error);
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) text = text.split(databaseUrl).join("[redacted DATABASE_URL]");
  return text;
}

async function main() {
  const mode = process.argv[2];
  try {
    const report = await runMigrations(mode);
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(JSON.stringify({ status: "error", mode, message: formatMigrationError(error) }));
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) await main();
