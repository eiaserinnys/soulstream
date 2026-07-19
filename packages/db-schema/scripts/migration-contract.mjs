import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LEDGER_TABLE = "schema_migrations";
export const MIGRATION_LOCK_NAMESPACE = 260719;
export const MIGRATION_LOCK_ID = 1;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const migrationDirectory = resolve(packageRoot, "sql/migrations");
export const migrationManifestPath = resolve(packageRoot, "migration-manifest.json");
export const canonicalSchemaPath = resolve(packageRoot, "sql/schema.sql");
export const legacyBackupContractPath = resolve(
  packageRoot,
  "legacy-task-tree-backup.json",
);

export function deploymentEnvironmentPath(env = process.env, cwd = process.cwd()) {
  const serviceCwd = env.HANIEL_SERVICE_CWD?.trim();
  return resolve(serviceCwd || cwd, ".env.soul-server-ts");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function readDatabaseUrl(env = process.env) {
  const value = env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  if (!value.startsWith("postgres://") && !value.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must be postgres:// or postgresql://");
  }
  return value;
}

export function readReleaseId(env = process.env, { required = true } = {}) {
  const value = (env.HANIEL_RELEASE_ID ?? env.SOULSTREAM_RELEASE_ID)?.trim();
  if (!value && required) {
    throw new Error("HANIEL_RELEASE_ID or SOULSTREAM_RELEASE_ID is required");
  }
  return value ?? null;
}

export async function loadMigrationManifest() {
  const parsed = JSON.parse(await readFile(migrationManifestPath, "utf8"));
  if (parsed?.schema_version !== "soulstream.migrations.v1") {
    throw new Error("migration manifest schema must be soulstream.migrations.v1");
  }
  if (!Array.isArray(parsed.migrations) || parsed.migrations.length === 0) {
    throw new Error("migration manifest must contain migrations");
  }

  const files = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const ids = parsed.migrations.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate migration ID");
  if (JSON.stringify(ids) !== JSON.stringify([...ids].sort())) {
    throw new Error("migration manifest order must be lexical by full filename");
  }
  if (JSON.stringify(ids) !== JSON.stringify(files)) {
    throw new Error("migration manifest must list every SQL file exactly once");
  }

  const migrations = [];
  for (const [ordinal, entry] of parsed.migrations.entries()) {
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(entry.id)) {
      throw new Error(`invalid full-filename migration ID: ${entry.id}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`invalid migration checksum: ${entry.id}`);
    }
    if (typeof entry.destructive !== "boolean") {
      throw new Error(`migration destructive flag missing: ${entry.id}`);
    }
    const path = resolve(migrationDirectory, entry.id);
    const sql = await readFile(path, "utf8");
    const actual = sha256(sql);
    if (actual !== entry.sha256) {
      throw new Error(
        `migration checksum differs for ${entry.id}: expected ${entry.sha256}, got ${actual}`,
      );
    }
    migrations.push({ ...entry, ordinal: ordinal + 1, path, sql });
  }
  return migrations;
}

export function validateLedger(migrations, rows) {
  if (!Array.isArray(rows)) throw new Error("migration ledger must be an array");
  if (rows.length > migrations.length) throw new Error("migration ledger is longer than manifest");

  for (const [index, row] of rows.entries()) {
    const expected = migrations[index];
    const ordinal = Number(row.ordinal);
    if (row.migration_id !== expected.id || ordinal !== expected.ordinal) {
      throw new Error(
        `migration ledger order differs at ordinal ${index + 1}: ${row.migration_id}`,
      );
    }
    if (row.checksum !== expected.sha256) {
      throw new Error(`applied migration checksum differs: ${row.migration_id}`);
    }
  }
  return migrations.slice(rows.length);
}

export function classifySchemaState(shape) {
  const table = (kind) => kind === "r" || kind === "p";
  if (
    !shape.sessions
    && !shape.tasks
    && !shape.taskSections
    && !shape.runbooks
    && !shape.runbookItems
    && !shape.taskItems
    && !shape.taskOperations
    && !shape.runbookOperations
  ) {
    return "empty";
  }
  if (
    table(shape.tasks)
    && table(shape.taskSections)
    && shape.runbooks === "v"
    && shape.runbookItems === "v"
    && table(shape.taskItems)
    && table(shape.taskOperations)
    && shape.runbookOperations === "v"
    && shape.taskItemsHasSection
    && !shape.taskItemsHasParent
  ) {
    return "current";
  }
  if (
    !shape.tasks
    && table(shape.runbooks)
    && table(shape.runbookItems)
    && table(shape.runbookOperations)
    && table(shape.taskItems)
    && shape.taskItemsHasParent
    && !shape.taskItemsHasSection
  ) {
    return "legacy_pre_041";
  }
  if (
    !shape.tasks
    && table(shape.runbooks)
    && table(shape.runbookItems)
    && table(shape.runbookOperations)
    && !shape.taskItems
    && !shape.taskOperations
  ) {
    return "legacy_post_041";
  }
  throw new Error(`ambiguous database schema state: ${JSON.stringify(shape)}`);
}

export function buildMigrationPlan(migrations, ledger, shape) {
  const state = classifySchemaState(shape);
  const pendingFromLedger = validateLedger(migrations, ledger);
  const currentBaselineCount = migrations.findIndex(
    (item) => item.id === "042_runbook_to_task.sql",
  ) + 1;
  if (currentBaselineCount === 0) throw new Error("current schema bootstrap boundary missing");
  if (ledger.length > 0) {
    if (ledger.length < currentBaselineCount) {
      throw new Error("partial pre-baseline migration ledger is not a supported state");
    }
    if (pendingFromLedger.length === 0 && state !== "current") {
      throw new Error(`complete migration ledger conflicts with ${state} schema`);
    }
    return { state, bootstrap: [], pending: pendingFromLedger };
  }

  let bootstrapCount = 0;
  if (state === "current") bootstrapCount = currentBaselineCount;
  if (state === "legacy_pre_041") {
    bootstrapCount = migrations.findIndex((item) => item.id === "041_retire_task_tree.sql");
  }
  if (state === "legacy_post_041") {
    bootstrapCount = migrations.findIndex((item) => item.id === "042_runbook_to_task.sql");
  }
  if (bootstrapCount < 0) throw new Error(`bootstrap boundary missing for ${state}`);
  return {
    state,
    bootstrap: migrations.slice(0, bootstrapCount),
    pending: migrations.slice(bootstrapCount),
  };
}

export function destructivePending(plan) {
  return plan.pending.filter((migration) => migration.destructive);
}

export function legacyRetirementPending(plan) {
  const ids = new Set(plan.pending.map((migration) => migration.id));
  return ids.has("041_retire_task_tree.sql") || ids.has("042_runbook_to_task.sql");
}

export async function loadLegacyBackupContract() {
  return JSON.parse(await readFile(legacyBackupContractPath, "utf8"));
}

export function assertLegacyBackupResolved(contract) {
  const stored = Number(contract.stored_operation_count);
  const observed = Number(contract.observed_pre_drop_operation_count);
  const missing = observed - stored;
  if (contract.status !== "resolved" || stored !== observed || missing !== 0) {
    throw new Error(
      `legacy Task Tree backup unresolved: stored=${stored}, observed=${observed}, missing=${missing}`,
    );
  }
}

export function validateBackupGate(gate, env = process.env, expectedDestructive = null) {
  if (gate?.schema_version !== "soulstream.database-backup.v1" || gate.status !== "verified") {
    throw new Error("verified database backup gate is required");
  }
  const releaseId = readReleaseId(env);
  if (gate.release_id !== releaseId) throw new Error("backup gate release ID differs");
  if (gate.target_head !== env.HANIEL_TARGET_HEAD) {
    throw new Error("backup gate target commit differs");
  }
  if (!/^[a-f0-9]{64}$/.test(gate.dump_sha256 ?? "")) {
    throw new Error("backup gate checksum is invalid");
  }
  if (
    expectedDestructive
    && JSON.stringify(gate.destructive_pending) !== JSON.stringify(expectedDestructive)
  ) {
    throw new Error("backup gate migration plan differs");
  }
  return gate;
}
