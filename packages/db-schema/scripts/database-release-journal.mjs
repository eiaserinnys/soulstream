import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  open as fsOpen,
  readFile,
  rename as fsRename,
  unlink as fsUnlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  databaseReleaseJournalLockPath,
  withDatabaseReleaseLease,
} from "./database-release-lock.mjs";
import {
  fingerprintInventory,
  inspectUserObjectInventory,
} from "./database-release-inventory.mjs";
import { readHanielReleaseEvidence, readStringList } from "./database-release-evidence.mjs";

export { fingerprintInventory, inspectUserObjectInventory };
export const DATABASE_RELEASE_SCHEMA_VERSION = "soulstream.database-release.v1";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for database release`);
  return value;
}

function optionalList(env, name) {
  const raw = env[name]?.trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw.split(",").map((value) => value.trim()).filter(Boolean);
  }
  if (!Array.isArray(parsed)
    || !parsed.every((value) => typeof value === "string" && value.trim())) {
    throw new Error(`${name} must be a string array`);
  }
  const normalized = [...new Set(parsed.map((value) => value.trim()))].sort();
  if (normalized.length !== parsed.length) throw new Error(`${name} contains duplicates`);
  return normalized;
}

export function databaseReleaseJournalPath(env = process.env) {
  return resolve(required(env, "HANIEL_BACKUP_DIR"), "database-release.json");
}

function archiveToken(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function journalDigest(journal) {
  return createHash("sha256").update(JSON.stringify(journal)).digest("hex");
}

export function databaseReleaseJournalArchivePath(path, journal) {
  return resolve(
    dirname(path),
    `database-release.archive-${archiveToken(journal.request_id)}`
      + `-${archiveToken(journal.target_head)}-r${journal.revision}.json`,
  );
}

export function journalIdentity(env, operation) {
  return {
    request_id: required(env, "HANIEL_REQUEST_ID"),
    repo: required(env, "HANIEL_DEPLOY_REPO"),
    release_id: required(env, "HANIEL_RELEASE_ID"),
    operation,
    previous_head: required(env, "HANIEL_PREVIOUS_HEAD"),
    target_head: required(env, "HANIEL_TARGET_HEAD"),
    manifest_checksum: required(env, "HANIEL_MANIFEST_DIGEST"),
    database_contract_checksum: required(env, "HANIEL_DATABASE_CONTRACT_DIGEST"),
    haniel_journal_path: required(env, "HANIEL_DEPLOYMENT_JOURNAL"),
    writer_services: readStringList(env, "HANIEL_DATABASE_WRITER_SERVICES"),
    required_subphases: optionalList(env, "HANIEL_DATABASE_REQUIRED_SUBPHASES"),
  };
}

function migrationIdentity(item) {
  return {
    id: item.id ?? item.migration_id,
    checksum: item.sha256 ?? item.checksum,
  };
}

function ledgerIdentity(item) {
  return {
    migration_id: item.migration_id,
    checksum: item.checksum,
    release_id: item.release_id,
    ordinal: Number(item.ordinal),
    applied_kind: item.applied_kind ?? null,
  };
}

function planIdentity(plan) {
  return {
    bootstrap: (plan.bootstrap ?? []).map(migrationIdentity),
    pending: plan.pending.map(migrationIdentity),
    ledger: (plan.ledger ?? []).map(ledgerIdentity),
  };
}

function inventoryObjectCount(inventory) {
  return Number(inventory.object_count ?? (
    Number(inventory.relation_count) + Number(inventory.routine_count)
    + Number(inventory.type_count) + Number(inventory.ledger_count)
  ));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function readDatabaseReleaseJournal(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value?.schema_version !== DATABASE_RELEASE_SCHEMA_VERSION) {
    throw new Error("JOURNAL_GATE_FAILED: database release journal schema differs");
  }
  if (!Number.isInteger(value.revision) || value.revision < 1) {
    throw new Error("JOURNAL_GATE_FAILED: database release journal revision is invalid");
  }
  return value;
}

const DEFAULT_FILE_SYSTEM = {
  open: fsOpen,
  rename: fsRename,
  unlink: fsUnlink,
};

async function syncJournalDirectory(path, fileSystem, platform) {
  if (platform === "win32") return;
  const directory = await fileSystem.open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function writeDatabaseReleaseJournal(
  path,
  journal,
  { fileSystem = DEFAULT_FILE_SYSTEM, platform = process.platform } = {},
) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await fileSystem.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporary, path);
    await syncJournalDirectory(path, fileSystem, platform);
    return journal;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await (fileSystem.unlink ?? fsUnlink)(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function rotateTerminalJournal(
  path,
  current,
  { fileSystem = DEFAULT_FILE_SYSTEM, platform = process.platform } = {},
) {
  const archivePath = databaseReleaseJournalArchivePath(path, current);
  try {
    const archived = await readDatabaseReleaseJournal(archivePath);
    assertDatabaseReleaseIdentity(archived, journalIdentityFromJournal(current));
    if (journalDigest(archived) !== journalDigest(current)) {
      throw new Error("JOURNAL_IDENTITY_CONFLICT: terminal archive content differs");
    }
    await fileSystem.unlink(path);
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
    await fileSystem.rename(path, archivePath);
  }
  await syncJournalDirectory(path, fileSystem, platform);
  return archivePath;
}

function journalIdentityFromJournal(journal) {
  return {
    request_id: journal.request_id,
    repo: journal.repo,
    release_id: journal.release_id,
    operation: journal.operation,
    previous_head: journal.previous_head,
    target_head: journal.target_head,
    manifest_checksum: journal.manifest_checksum,
    database_contract_checksum: journal.database_contract_checksum,
    haniel_journal_path: journal.haniel_journal_path,
    writer_services: journal.writer_services,
    required_subphases: journal.required_subphases,
  };
}

function matchesOuterAttemptIdentity(attempt, identity) {
  return attempt?.request_id === identity.request_id
    && attempt.repo === identity.repo
    && attempt.release_id === identity.release_id
    && attempt.previous_head === identity.previous_head
    && attempt.target_head === identity.target_head
    && attempt.manifest_digest === identity.manifest_checksum
    && attempt.expected_operation === identity.operation;
}

function matchesFreshOuterAttempt(outer, identity) {
  return matchesOuterAttemptIdentity(outer, identity)
    && outer.state === "preflight"
    && outer.recovered === false;
}

function matchesRecoveredOuterAttempt(attempt, journal, path) {
  return matchesOuterAttemptIdentity(attempt, journalIdentityFromJournal(journal))
    && attempt.operation === journal.operation
    && resolve(attempt.database_journal_path ?? "") === resolve(path)
    && attempt.state === "failed"
    && attempt.recovered === true;
}

function assertUnchangedReleasePlanAndInventory(journal, plan, inventory) {
  const expectedPlan = planIdentity(plan);
  const bootstrap = expectedPlan.bootstrap;
  const pending = expectedPlan.pending;
  if (
    journal.pre_schema_fingerprint !== fingerprintInventory(inventory)
    || journal.pre_object_count !== inventoryObjectCount(inventory)
    || !sameJson(journal.bootstrap_migrations, bootstrap)
    || !sameJson(journal.pending_migrations, pending)
    || !sameJson(journal.planned_migrations, [...bootstrap, ...pending])
    || !sameJson(journal.pre_migration_plan, expectedPlan)
  ) {
    throw new Error("JOURNAL_GATE_FAILED: migration plan or database inventory changed");
  }
}

function assertUnchangedZeroEffectPreflight(journal, plan, inventory) {
  const history = journal.history;
  if (
    journal.revision !== 1
    || journal.status !== "preflight_complete"
    || journal.last_committed_phase !== "preflight"
    || journal.failed_operation !== null
    || journal.backup !== null
    || journal.apply_started_at !== null
    || journal.apply_committed_at !== null
    || journal.quiescence_receipt_digest !== null
    || journal.quiescence_owner_instance !== null
    || journal.quiescence_nonce !== null
    || !Array.isArray(journal.completed_subphases)
    || journal.completed_subphases.length !== 0
    || !Array.isArray(journal.applied_ledger)
    || journal.applied_ledger.length !== 0
    || journal.error !== null
    || !Array.isArray(history)
    || history.length !== 1
    || history[0].phase !== "preflight"
    || history[0].status !== "preflight_complete"
    || typeof history[0].occurred_at !== "string"
    || journal.updated_at !== history[0].occurred_at
  ) {
    throw new Error("JOURNAL_IDENTITY_CONFLICT: preflight journal has effects or unknown fields");
  }
  try {
    assertUnchangedReleasePlanAndInventory(journal, plan, inventory);
  } catch {
    throw new Error("JOURNAL_IDENTITY_CONFLICT: preflight plan or inventory changed");
  }
}

async function retireRecoveredPreflightJournal({ path, current, identity, plan, inventory, now }) {
  if (
    current.repo !== identity.repo
    || current.operation !== identity.operation
    || current.database_contract_checksum !== identity.database_contract_checksum
    || current.haniel_journal_path !== identity.haniel_journal_path
    || !sameJson(current.writer_services, identity.writer_services)
    || !sameJson(current.required_subphases, identity.required_subphases)
  ) {
    throw new Error("JOURNAL_IDENTITY_CONFLICT: database release contract differs");
  }
  let outer;
  try {
    outer = JSON.parse(await readFile(identity.haniel_journal_path, "utf8"));
  } catch {
    throw new Error("JOURNAL_IDENTITY_CONFLICT: outer release evidence is unavailable");
  }
  if (!matchesFreshOuterAttempt(outer, identity)) {
    throw new Error("JOURNAL_IDENTITY_CONFLICT: fresh outer attempt differs");
  }
  const matches = Array.isArray(outer.previous_attempts)
    ? outer.previous_attempts.filter((attempt) => matchesRecoveredOuterAttempt(attempt, current, path))
    : [];
  if (matches.length !== 1) {
    throw new Error("JOURNAL_IDENTITY_CONFLICT: recovered outer attempt differs");
  }
  assertUnchangedZeroEffectPreflight(current, plan, inventory);
  const observed = await readDatabaseReleaseJournal(path);
  if (observed.revision !== current.revision || journalDigest(observed) !== journalDigest(current)) {
    throw new Error("JOURNAL_REVISION_CONFLICT: database release journal changed");
  }
  const occurredAt = now().toISOString();
  const recovered = {
    ...current,
    revision: current.revision + 1,
    status: "recovered",
    last_committed_phase: "recovery",
    history: [
      ...current.history,
      { phase: "recovery", status: "recovered", occurred_at: occurredAt },
    ],
    updated_at: occurredAt,
  };
  await writeDatabaseReleaseJournal(path, recovered);
  await rotateTerminalJournal(path, recovered);
}

export async function createDatabaseReleaseJournal({
  env,
  operation,
  plan,
  inventory,
  now = () => new Date(),
}) {
  const path = databaseReleaseJournalPath(env);
  return await withDatabaseReleaseLease(databaseReleaseJournalLockPath(path), async () => {
    const identity = journalIdentity(env, operation);
    try {
      const current = await readDatabaseReleaseJournal(path);
      try {
        assertDatabaseReleaseIdentity(current, identity);
        return current;
      } catch {
        if (TERMINAL.has(current.status)) {
          await rotateTerminalJournal(path, current);
        } else {
          await retireRecoveredPreflightJournal({
            path,
            current,
            identity,
            plan,
            inventory,
            now,
          });
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
    }
    const occurredAt = now().toISOString();
    const bootstrap = (plan.bootstrap ?? []).map(migrationIdentity);
    const pending = plan.pending.map(migrationIdentity);
    const journal = {
      schema_version: DATABASE_RELEASE_SCHEMA_VERSION,
      revision: 1,
      ...identity,
      failed_operation: null,
      pre_schema_fingerprint: fingerprintInventory(inventory),
      pre_object_count: inventoryObjectCount(inventory),
      bootstrap_migrations: bootstrap,
      pending_migrations: pending,
      planned_migrations: [...bootstrap, ...pending],
      pre_migration_plan: planIdentity(plan),
      applied_ledger: [],
      quiescence_receipt_digest: null,
      quiescence_owner_instance: null,
      quiescence_nonce: null,
      backup: null,
      completed_subphases: [],
      status: "preflight_complete",
      last_committed_phase: "preflight",
      apply_started_at: null,
      apply_committed_at: null,
      error: null,
      history: [{ phase: "preflight", status: "preflight_complete", occurred_at: occurredAt }],
      updated_at: occurredAt,
    };
    await writeDatabaseReleaseJournal(path, journal);
    return journal;
  });
}

const TERMINAL = new Set(["verified", "recovered"]);
const ALLOWED_TRANSITIONS = new Map([
  ["preflight_complete", new Set(["backup_created", "backup_failed", "apply_started", "applied_reconciled"])],
  ["backup_failed", new Set(["backup_created", "backup_failed"])],
  ["backup_created", new Set(["backup_verified", "backup_verify_failed"])],
  ["backup_verify_failed", new Set(["backup_verified", "backup_verify_failed"])],
  ["backup_verified", new Set(["apply_started"])],
  ["apply_started", new Set(["apply_failed", "sql_applied", "applied", "applied_reconciled", "recovered"])],
  ["apply_failed", new Set(["apply_started", "applied_reconciled", "recovered"])],
  ["sql_applied", new Set(["subphase_started", "applied"])],
  ["subphase_started", new Set(["subphase_started", "subphase_complete"])],
  ["subphase_complete", new Set(["subphase_started", "applied"])],
  ["applied", new Set(["verified", "recovered"])],
  ["applied_reconciled", new Set(["verified", "recovered"])],
]);

function assertTransition(current, status, expectedRevision, expectedStatuses) {
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    throw new Error("JOURNAL_REVISION_CONFLICT: database release journal changed");
  }
  if (expectedStatuses && !expectedStatuses.includes(current.status)) {
    throw new Error("JOURNAL_STATE_CONFLICT: database release status differs");
  }
  if (TERMINAL.has(current.status) || !ALLOWED_TRANSITIONS.get(current.status)?.has(status)) {
    throw new Error(`JOURNAL_STATE_CONFLICT: ${current.status} cannot transition to ${status}`);
  }
}

export async function transitionDatabaseReleaseJournal(
  path,
  status,
  {
    phase,
    details = {},
    error = null,
    now = () => new Date(),
    expectedRevision,
    expectedStatuses,
  } = {},
) {
  return await withDatabaseReleaseLease(databaseReleaseJournalLockPath(path), async () => {
    const current = await readDatabaseReleaseJournal(path);
    assertTransition(current, status, expectedRevision, expectedStatuses);
    const occurredAt = now().toISOString();
    const next = {
      ...current,
      ...details,
      revision: current.revision + 1,
      status,
      last_committed_phase: phase ?? current.last_committed_phase,
      error,
      history: [
        ...current.history,
        { phase: phase ?? current.last_committed_phase, status, occurred_at: occurredAt },
      ],
      updated_at: occurredAt,
    };
    await writeDatabaseReleaseJournal(path, next);
    return next;
  });
}

export function assertDatabaseReleaseIdentity(journal, identity) {
  for (const [key, expected] of Object.entries(identity)) {
    if (JSON.stringify(journal[key]) !== JSON.stringify(expected)) {
      throw new Error(`JOURNAL_IDENTITY_CONFLICT: ${key} differs`);
    }
  }
  return journal;
}

export function classifyLedgerReconciliation(journal, plan, inventory) {
  const expected = journal.planned_migrations ?? journal.pending_migrations;
  const ledger = new Map(plan.ledger.map((row) => [row.migration_id, row]));
  if (expected.length === 0) {
    return fingerprintInventory(inventory) === journal.pre_schema_fingerprint ? "full" : "ambiguous";
  }
  const present = expected.filter((item) => ledger.has(item.id));
  if (present.length === 0) {
    return fingerprintInventory(inventory) === journal.pre_schema_fingerprint
      ? "none"
      : "ambiguous";
  }
  if (present.length !== expected.length) return "ambiguous";
  const exact = expected.every((item) => {
    const row = ledger.get(item.id);
    return row?.checksum === item.checksum && row?.release_id === journal.release_id;
  });
  return exact ? "full" : "ambiguous";
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function pendingIds(plan) {
  return plan.pending.map((migration) => migration.id ?? migration.migration_id);
}

async function assertCurrentBackup({ env, journal, plan }) {
  const metadataPath = resolve(required(env, "HANIEL_BACKUP_DIR"), "database-backup.json");
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`JOURNAL_GATE_FAILED: backup metadata is unavailable: ${error.message}`);
  }
  if (
    JSON.stringify(metadata) !== JSON.stringify(journal.backup?.metadata)
    || metadata.release_id !== journal.release_id
    || metadata.target_head !== journal.target_head
    || !new Set(["verified", "verified_not_required"]).has(metadata.status)
    || JSON.stringify(metadata.pending_migrations ?? []) !== JSON.stringify(pendingIds(plan))
  ) {
    throw new Error("JOURNAL_GATE_FAILED: current backup metadata differs");
  }
  if (metadata.status === "verified") {
    const dumpPath = resolve(required(env, "HANIEL_BACKUP_DIR"), metadata.dump_file ?? "");
    if (!metadata.dump_file || await sha256File(dumpPath) !== metadata.dump_sha256) {
      throw new Error("JOURNAL_GATE_FAILED: current backup archive differs");
    }
  }
  return metadata;
}

export async function assertDatabaseReleaseApplyGate({ env, operation, plan, inventory }) {
  const path = databaseReleaseJournalPath(env);
  const journal = await readDatabaseReleaseJournal(path);
  try {
    assertDatabaseReleaseIdentity(journal, journalIdentity(env, operation));
  } catch (error) {
    throw new Error(`JOURNAL_GATE_FAILED: ${error.message}`);
  }
  if (journal.status !== "apply_started") {
    throw new Error("JOURNAL_GATE_FAILED: apply_started phase is required");
  }
  const expectedRevision = Number(env.HANIEL_DATABASE_JOURNAL_REVISION);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== journal.revision) {
    throw new Error("JOURNAL_GATE_FAILED: journal revision differs");
  }
  if (operation === "upgrade") {
    const noInlineBackup = journal.backup === null
      && typeof journal.quiescence_receipt_digest === "string"
      && typeof journal.quiescence_owner_instance === "string"
      && typeof journal.quiescence_nonce === "string";
    if (!noInlineBackup && !journal.backup?.verified_at) {
      throw new Error("JOURNAL_GATE_FAILED: verified backup phase is required");
    }
    const evidence = await readHanielReleaseEvidence({ env, journal, phase: "apply" });
    if (
      evidence.receipt_digest !== journal.quiescence_receipt_digest
      || evidence.owner_instance !== journal.quiescence_owner_instance
      || evidence.quiescence_nonce !== journal.quiescence_nonce
    ) {
      throw new Error("JOURNAL_GATE_FAILED: quiescence evidence changed");
    }
    if (noInlineBackup) {
      assertNoInlineDatabaseReleaseGate({ journal, plan, inventory });
    } else {
      await assertCurrentBackup({ env, journal, plan });
    }
  }
  if (fingerprintInventory(inventory) !== journal.pre_schema_fingerprint) {
    throw new Error("JOURNAL_GATE_FAILED: database inventory changed after preflight");
  }
  const currentPending = plan.pending.map(migrationIdentity);
  const currentBootstrap = (plan.bootstrap ?? []).map(migrationIdentity);
  if (
    JSON.stringify(currentPending) !== JSON.stringify(journal.pending_migrations)
    || JSON.stringify(currentBootstrap) !== JSON.stringify(journal.bootstrap_migrations ?? [])
    || JSON.stringify(planIdentity(plan)) !== JSON.stringify(journal.pre_migration_plan)
  ) {
    throw new Error("JOURNAL_GATE_FAILED: migration plan differs");
  }
  return journal;
}

export function assertNoInlineDatabaseReleaseGate({ journal, plan, inventory }) {
  if (journal.operation !== "upgrade" || journal.backup !== null) {
    throw new Error("JOURNAL_GATE_FAILED: no-inline upgrade evidence differs");
  }
  if (!Array.isArray(plan.pending)
    || plan.pending.some((migration) => migration.destructive !== false)) {
    throw new Error("JOURNAL_GATE_FAILED: no-inline migration is destructive or unclassified");
  }
  assertUnchangedReleasePlanAndInventory(journal, plan, inventory);
  return journal;
}

export function releaseJournalDirectory(env = process.env) {
  return dirname(databaseReleaseJournalPath(env));
}
