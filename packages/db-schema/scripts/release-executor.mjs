#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { runDatabaseReleaseCli } from "./database-release-cli.mjs";
import { resolveDatabaseReleaseContext } from "./database-release-context.mjs";
import {
  DATABASE_RELEASE_SCHEMA_VERSION,
  assertDatabaseReleaseIdentity,
  classifyLedgerReconciliation,
  createDatabaseReleaseJournal,
  databaseReleaseJournalPath,
  inspectUserObjectInventory,
  journalIdentity,
  readDatabaseReleaseJournal,
  transitionDatabaseReleaseJournal,
} from "./database-release-journal.mjs";
import {
  databaseReleasePhaseLockPath,
  withDatabaseReleaseLease,
} from "./database-release-lock.mjs";
import { readHanielReleaseEvidence } from "./database-release-evidence.mjs";
import {
  assertDatabaseReleaseSubphaseGate,
  executeDatabaseReleaseSubphase,
} from "./database-release-subphase.mjs";
import { prepareLegacyInitializeEnvironment } from "./database-release-legacy.mjs";
import {
  classifyDatabaseOperation,
  discoverDatabaseOperation,
  probeDatabaseOperation,
} from "./database-release-operation.mjs";
import {
  databaseReleaseErrorCode, databaseReleaseFailure, databaseReleaseSuccess,
  formatDatabaseReleaseError, sanitizeDatabaseReleaseResult,
  serializeDatabaseReleaseResult,
} from "./database-release-result.mjs";

export {
  DATABASE_RELEASE_SCHEMA_VERSION, databaseReleaseJournalPath, inspectUserObjectInventory,
  readDatabaseReleaseJournal, databaseReleaseErrorCode, formatDatabaseReleaseError,
  assertDatabaseReleaseSubphaseGate, classifyDatabaseOperation, databaseReleaseFailure,
  sanitizeDatabaseReleaseResult, serializeDatabaseReleaseResult,
};

const COMMANDS = new Set([
  "probe", "preflight", "apply", "verify", "recover",
  "initialize", "run-subphase",
]);
function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for database release`);
  return value;
}

function stableError(code, error) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.includes(code) ? message : `${code}: ${message}`);
}

export async function runDatabaseRelease(command, options = {}) {
  if (!COMMANDS.has(command)) throw new Error(`unknown database release command: ${command}`);
  if (command === "initialize") await prepareLegacyInitializeEnvironment(options);
  const context = await resolveDatabaseReleaseContext(options, command);
  try {
    if (command === "probe") return await probe(context);
    await mkdir(required(context.env, "HANIEL_BACKUP_DIR"), { recursive: true });
    return await withDatabaseReleaseLease(
      databaseReleasePhaseLockPath(context.env),
      async () => await dispatch(command, context, options),
    );
  } finally {
    if (context.ownsSql) await context.sql.end({ timeout: 5 });
  }
}

async function dispatch(command, context, options) {
  if (command === "initialize") return await initialize(context, options);
  if (command === "preflight") return await preflight(context, options);
  if (command === "apply") return await apply(context, options);
  if (command === "verify") return await verify(context);
  if (command === "run-subphase") return await runSubphase(context, options);
  return await recover(context, options);
}

export async function planDatabaseRelease({ expectedOperation, env = process.env, ...options }) {
  const releaseEnv = { ...env, HANIEL_EXPECTED_DATABASE_OPERATION: expectedOperation };
  return await runDatabaseRelease("probe", { ...options, env: releaseEnv });
}

export async function executeDatabaseReleasePhase(phase, options = {}) {
  return await runDatabaseRelease(phase, options);
}

async function initialize(context, options) {
  try {
    const { journal, path } = await currentJournal(context);
    const currentPlan = await context.planRead();
    if (
      ["applied", "applied_reconciled", "verified"].includes(journal.status)
      && currentPlan.state === "current"
      && currentPlan.pending.length === 0
    ) {
      return result(context, journal.operation, path, journal.status, "initialize", {
        schema_state: "current",
      });
    }
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
  }
  const report = await preflight(context, options);
  const journal = await readDatabaseReleaseJournal(report.journal_path);
  if (journal.operation === "fresh_install") return await apply(context, options);
  if (journal.pending_migrations.length > 0) {
    throw new Error("UPGRADE_REQUIRES_HANIEL_HANDOVER");
  }
  await transitionFrom(report.journal_path, journal, "applied_reconciled", {
    phase: "apply",
    details: { applied_ledger: [] },
  });
  return result(context, "upgrade", report.journal_path, "applied_reconciled", "initialize");
}

async function probe(context) {
  return await probeDatabaseOperation(context, databaseReleaseSuccess);
}

async function preflight(context, options) {
  const path = databaseReleaseJournalPath(context.env);
  let existing = null;
  try {
    existing = await readDatabaseReleaseJournal(path);
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ENOENT") throw error;
  }
  const operationSource = inheritedOperationJournal(context, existing);
  const { inventory, operation } = await discoverDatabaseOperation(context, operationSource);
  const plan = await context.planRead();
  await mkdir(required(context.env, "HANIEL_BACKUP_DIR"), { recursive: true });
  let journal = await createDatabaseReleaseJournal({
    env: context.env,
    operation,
    plan,
    inventory,
    now: options.now,
  });
  if (["apply_started", "apply_failed"].includes(journal.status)) {
    const reconciliation = classifyLedgerReconciliation(journal, plan, inventory);
    if (reconciliation === "ambiguous") throw new Error("AMBIGUOUS_COMMIT_STATE");
    if (reconciliation === "full") {
      const status = journal.required_subphases.length > 0 ? "sql_applied" : "applied_reconciled";
      journal = await transitionFrom(
        databaseReleaseJournalPath(context.env),
        journal,
        status,
        { phase: "apply", details: { applied_ledger: journal.planned_migrations } },
      );
    }
  } else if (![
    "applied", "applied_reconciled", "verified", "recovered",
  ].includes(journal.status)) {
    const pending = plan.pending.map((item) => ({ id: item.id, checksum: item.sha256 }));
    const bootstrap = (plan.bootstrap ?? []).map((item) => ({ id: item.id, checksum: item.sha256 }));
    if (
      JSON.stringify(pending) !== JSON.stringify(journal.pending_migrations)
      || JSON.stringify(bootstrap) !== JSON.stringify(journal.bootstrap_migrations ?? [])
    ) {
      throw new Error("JOURNAL_IDENTITY_CONFLICT: migration plan differs");
    }
  }
  return result(context, operation, path, journal.status, "preflight");
}

function inheritedOperationJournal(context, existing) {
  if (!existing || !["verified", "recovered"].includes(existing.status)) return existing;
  try {
    assertDatabaseReleaseIdentity(
      existing,
      journalIdentity(context.env, existing.operation),
    );
    return existing;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("JOURNAL_IDENTITY_CONFLICT:")) {
      return null;
    }
    throw error;
  }
}

async function currentJournal(context, operation = null) {
  const path = databaseReleaseJournalPath(context.env);
  const journal = await readDatabaseReleaseJournal(path);
  assertDatabaseReleaseIdentity(
    journal,
    journalIdentity(context.env, operation ?? journal.operation),
  );
  return { journal, path };
}

async function transitionFrom(path, current, status, options = {}) {
  return await transitionDatabaseReleaseJournal(path, status, {
    ...options,
    expectedRevision: current.revision,
    expectedStatuses: [current.status],
  });
}

async function apply(context, options) {
  let { journal, path } = await currentJournal(context);
  if (["applied", "applied_reconciled", "verified"].includes(journal.status)) {
    return result(context, journal.operation, path, journal.status, "apply");
  }
  if (["sql_applied", "subphase_started", "subphase_complete"].includes(journal.status)) {
    return result(context, journal.operation, path, journal.status, "apply");
  }
  const plan = await context.planRead();
  const inventory = await context.inventoryRead();
  let retryableNone = false;
  if (journal.status === "apply_started" || journal.status === "apply_failed") {
    const state = classifyLedgerReconciliation(journal, plan, inventory);
    if (state === "full") {
      const reconciledStatus = journal.required_subphases.length > 0
        ? "sql_applied"
        : "applied_reconciled";
      journal = await transitionFrom(path, journal, reconciledStatus, {
        phase: "apply",
        details: { applied_ledger: journal.planned_migrations },
      });
      return result(context, journal.operation, path, reconciledStatus, "apply");
    }
    if (state === "ambiguous") throw new Error("AMBIGUOUS_COMMIT_STATE");
    retryableNone = true;
  }
  const allowed = journal.status === "preflight_complete" || retryableNone;
  if (!allowed) throw new Error("JOURNAL_GATE_FAILED: release phases are incomplete");
  let evidence = null;
  if (journal.operation === "upgrade") {
    evidence = await readHanielReleaseEvidence({
      env: context.env,
      journal,
      phase: "apply",
    });
  }
  journal = await transitionFrom(path, journal, "apply_started", {
    phase: "apply",
    details: {
      apply_started_at: new Date().toISOString(),
      ...(evidence ? {
        quiescence_receipt_digest: evidence.receipt_digest,
        quiescence_owner_instance: evidence.owner_instance,
        quiescence_nonce: evidence.quiescence_nonce,
      } : {}),
    },
  });
  context.env.HANIEL_DATABASE_JOURNAL_REVISION = String(journal.revision);
  const mode = journal.operation === "fresh_install" ? "fresh-install" : "apply";
  try {
    await context.migrationRun(mode, { env: context.env, journalPath: path });
  } catch (error) {
    let failedPlan;
    let failedInventory;
    try {
      failedPlan = await context.planRead();
      failedInventory = await context.inventoryRead();
    } catch {
      journal = await readDatabaseReleaseJournal(path);
      await transitionFrom(path, journal, "apply_failed", {
        phase: "apply",
        error: { code: databaseReleaseErrorCode(error) },
      });
      throw error;
    }
    journal = await readDatabaseReleaseJournal(path);
    const reconciliation = classifyLedgerReconciliation(journal, failedPlan, failedInventory);
    if (reconciliation === "full") {
      const reconciledStatus = journal.required_subphases.length > 0
        ? "sql_applied"
        : "applied_reconciled";
      journal = await transitionFrom(path, journal, reconciledStatus, {
        phase: "apply",
        details: { applied_ledger: journal.planned_migrations },
      });
      return result(context, journal.operation, path, reconciledStatus, "apply");
    }
    await transitionFrom(path, journal, "apply_failed", {
      phase: "apply",
      error: { code: reconciliation === "ambiguous" ? "AMBIGUOUS_COMMIT_STATE" : "APPLY_FAILED" },
    });
    if (reconciliation === "ambiguous") throw new Error("AMBIGUOUS_COMMIT_STATE");
    throw stableError("APPLY_FAILED", error);
  }
  if (options.afterApplyCommit) await options.afterApplyCommit();
  const finalPlan = await context.planRead();
  const finalInventory = await context.inventoryRead();
  journal = await readDatabaseReleaseJournal(path);
  if (classifyLedgerReconciliation(journal, finalPlan, finalInventory) !== "full") {
    throw new Error("AMBIGUOUS_COMMIT_STATE");
  }
  const committedStatus = journal.required_subphases.length > 0 ? "sql_applied" : "applied";
  journal = await transitionFrom(path, journal, committedStatus, {
    phase: "apply",
    details: {
      apply_committed_at: new Date().toISOString(),
      applied_ledger: journal.planned_migrations,
    },
  });
  return result(context, journal.operation, path, committedStatus, "apply");
}

async function verify(context) {
  let { journal, path } = await currentJournal(context);
  if (journal.status === "verified") {
    return result(context, journal.operation, path, "verified", "verify");
  }
  if (!["applied", "applied_reconciled", "verified"].includes(journal.status)) {
    throw new Error("POST_VERIFY_FAILED: applied database release phase is required");
  }
  const plan = await context.planRead();
  if (plan.pending.length > 0 || plan.state !== "current") {
    throw new Error("POST_VERIFY_FAILED: migration ledger is incomplete");
  }
  journal = await transitionFrom(path, journal, "verified", { phase: "verify" });
  return result(context, journal.operation, path, "verified", "verify");
}

async function recover(context) {
  let { journal, path } = await currentJournal(context);
  if (journal.status === "recovered") {
    return result(context, "recovery", path, "recovered", "recovery", {
      failed_operation: "upgrade",
      recovered: true,
    });
  }
  if (journal.operation !== "upgrade") {
    throw new Error("RECOVERY_FORBIDDEN: fresh_install has no recovery path");
  }
  if (
    context.env.HANIEL_DATABASE_OPERATION !== "recovery"
    || context.env.HANIEL_FAILED_DATABASE_OPERATION !== journal.operation
  ) {
    throw new Error("RECOVERY_FORBIDDEN: failed operation identity differs");
  }
  try {
    await readHanielReleaseEvidence({ env: context.env, journal, phase: "recovery" });
  } catch (error) {
    throw stableError("RECOVERY_FORBIDDEN", error);
  }
  journal = await transitionFrom(path, journal, "recovered", {
    phase: "recovery",
    details: { failed_operation: "upgrade" },
  });
  return result(context, "recovery", path, "recovered", "recovery", {
    failed_operation: "upgrade",
    recovered: true,
  });
}

async function runSubphase(context, options) {
  const subphase = options.subphase?.trim();
  if (!subphase) throw new Error("SUBPHASE_FAILED: --subphase is required");
  const journal = await executeDatabaseReleaseSubphase({
    env: context.env,
    subphase,
    command: options.childCommand,
    timeoutMs: options.timeoutMs,
    runner: options.subphaseRun,
  });
  return result(context, journal.operation, databaseReleaseJournalPath(context.env),
    journal.status, `subphase:${subphase}`, {
      completed_subphases: journal.completed_subphases,
    });
}

function result(context, operation, journalPath, status, phase, extra = {}) {
  return databaseReleaseSuccess(context.env, { operation, phase, journalPath, status, extra });
}

async function main() {
  process.exitCode = await runDatabaseReleaseCli(runDatabaseRelease);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) await main();
