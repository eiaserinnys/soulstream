import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasTestDatabaseResource,
  provisionTestDatabase,
  type TestDatabaseLease,
} from "./database_test_harness.js";

import {
  DATABASE_RELEASE_SCHEMA_VERSION,
  classifyDatabaseOperation,
  databaseReleaseJournalPath,
  executeDatabaseReleasePhase,
  inspectUserObjectInventory,
  planDatabaseRelease,
  readDatabaseReleaseJournal,
  runDatabaseRelease,
} from "../../../packages/db-schema/scripts/release-executor.mjs";

const directories: string[] = [];
const databaseLeases: TestDatabaseLease[] = [];
const itWithDatabase = hasTestDatabaseResource()
  ? it
  : it.skip;

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const lease of databaseLeases.splice(0)) await lease.cleanup();
});
function environment(directory: string, operation = "upgrade") {
  return {
    HANIEL_BACKUP_DIR: directory,
    HANIEL_DATABASE_OPERATION: operation,
    HANIEL_DATABASE_REQUIRED_SUBPHASES: "[]",
    HANIEL_DATABASE_WRITER_SERVICES: '["writer"]',
    HANIEL_DEPLOY_REPO: "soulstream",
    HANIEL_DEPLOYMENT_JOURNAL: join(directory, "haniel-deployment.json"),
    HANIEL_DATABASE_CONTRACT_DIGEST: "b".repeat(64),
    HANIEL_MANIFEST_DIGEST: "a".repeat(64),
    HANIEL_PREVIOUS_HEAD: "1".repeat(40),
    HANIEL_RELEASE_ID: "release-1",
    HANIEL_REQUEST_ID: "request-1",
    HANIEL_TARGET_HEAD: "2".repeat(40),
  };
}
function plan({ ledger = [], pending = [] as Array<Record<string, unknown>> } = {}) {
  return {
    state: ledger.length > 0 ? "current" : "legacy_pre_041",
    ledger,
    migrations: pending,
    bootstrap: [],
    pending,
  };
}
function migration(id: string, ordinal: number, releaseId?: string) {
  return {
    id,
    migration_id: id,
    ordinal,
    sha256: String(ordinal % 10).repeat(64),
    checksum: String(ordinal % 10).repeat(64),
    release_id: releaseId,
    destructive: true,
    rollback_compatibility: "restore_required",
  };
}
function emptyInventory() {
  return { relation_count: 0, routine_count: 0, type_count: 0, ledger_count: 0 };
}
function populatedInventory() {
  return { ...emptyInventory(), relation_count: 1 };
}
async function preflight(env: ReturnType<typeof environment>, pending = [
  migration("061_contract.sql", 61),
]) {
  return await executeDatabaseReleasePhase("preflight", {
    env,
    inventoryRead: async () => populatedInventory(),
    planRead: async () => plan({ pending }),
  });
}

async function writeReceipt(env: ReturnType<typeof environment>) {
  const receiptPath = join(env.HANIEL_BACKUP_DIR, "quiescence.json");
  const receipt = {
    request_id: env.HANIEL_REQUEST_ID,
    repo: "soulstream",
    target_head: env.HANIEL_TARGET_HEAD,
    owner_instance: "owner-1",
    quiescence_nonce: "nonce-1",
    stopped_services: ["writer"],
    already_stopped_services: [],
    quiesced_services: ["writer"],
  };
  await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
  await writeFile(env.HANIEL_DEPLOYMENT_JOURNAL, JSON.stringify({
    repo: env.HANIEL_DEPLOY_REPO,
    request_id: env.HANIEL_REQUEST_ID,
    target_head: env.HANIEL_TARGET_HEAD,
    operation: "upgrade",
    expected_operation: "upgrade",
    manifest_digest: env.HANIEL_MANIFEST_DIGEST,
    database_journal_path: databaseReleaseJournalPath(env),
    state: "backing_up",
    quiescence_receipt: receipt,
  }), "utf8");
  return { ...env, HANIEL_QUIESCENCE_RECEIPT: receiptPath };
}

async function setHanielState(env: ReturnType<typeof environment>, state: string) {
  const journal = JSON.parse(readFileSync(env.HANIEL_DEPLOYMENT_JOURNAL, "utf8"));
  await writeFile(env.HANIEL_DEPLOYMENT_JOURNAL, JSON.stringify({ ...journal, state }), "utf8");
}

describe("database release executor", () => {
  it("routes every known DB writer through the executor and pins paired Haniel", () => {
    const files = {
      applySchema: readFileSync(new URL("../../scripts/apply-schema.mjs", import.meta.url), "utf8"),
      boardWrapper: readFileSync(new URL(
        "../../../orch-server-ts/scripts/deploy-board-yjs-runbook-residue.ts",
        import.meta.url,
      ), "utf8"),
      migrate: readFileSync(new URL(
        "../../../packages/db-schema/scripts/migrate.mjs",
        import.meta.url,
      ), "utf8"),
      workflow: readFileSync(new URL(
        "../../../.github/workflows/test-install.yml",
        import.meta.url,
      ), "utf8"),
    };

    expect(files.applySchema).toContain("release-executor.mjs");
    expect(files.applySchema).not.toContain("runMigrations");
    expect(files.boardWrapper).toContain("release-executor.mjs");
    expect(files.boardWrapper).not.toContain("packages/db-schema/scripts/migrate.mjs");
    expect(files.migrate).toContain("assertDatabaseReleaseApplyGate");
    expect(files.migrate).toContain('import("./release-executor.mjs")');
    expect(files.workflow).toContain("3d02d57eb4a78b2eca18acb69c9f099424537c6e");
  });

  it("classifies fresh_install only from a complete zero user-object inventory", () => {
    expect(classifyDatabaseOperation(emptyInventory())).toBe("fresh_install");
    for (const key of ["relation_count", "routine_count", "type_count", "ledger_count"] as const) {
      expect(classifyDatabaseOperation({ ...emptyInventory(), [key]: 1 })).toBe("upgrade");
    }
  });

  it("returns the Haniel probe identity without creating a live journal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-probe-"));
    directories.push(directory);
    const env = {
      ...environment(directory, "fresh_install"),
      HANIEL_EXPECTED_DATABASE_OPERATION: "fresh_install",
      HANIEL_STAGING_PROBE: "1",
    };
    const report = await planDatabaseRelease({
      expectedOperation: "fresh_install",
      env,
      inventoryRead: async () => emptyInventory(),
    });

    expect(report).toEqual(expect.objectContaining({
      ok: true,
      operation: "fresh_install",
      phase: "probe",
      request_id: "request-1",
      release_id: "release-1",
      journal_path: null,
      error: null,
      target_head: env.HANIEL_TARGET_HEAD,
      manifest_digest: env.HANIEL_MANIFEST_DIGEST,
    }));
    expect(existsSync(databaseReleaseJournalPath(env))).toBe(false);
  });

  it("writes an identity-bound atomic journal during preflight", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-journal-"));
    directories.push(directory);
    const env = environment(directory);
    const report = await preflight(env);
    const journal = await readDatabaseReleaseJournal(report.journal_path);

    expect(report).toMatchObject({
      schema_version: DATABASE_RELEASE_SCHEMA_VERSION,
      ok: true,
      operation: "upgrade",
      journal_path: databaseReleaseJournalPath(env),
    });
    expect(journal).toMatchObject({
      schema_version: DATABASE_RELEASE_SCHEMA_VERSION,
      request_id: "request-1",
      release_id: "release-1",
      operation: "upgrade",
      previous_head: env.HANIEL_PREVIOUS_HEAD,
      target_head: env.HANIEL_TARGET_HEAD,
      manifest_checksum: env.HANIEL_MANIFEST_DIGEST,
      database_contract_checksum: env.HANIEL_DATABASE_CONTRACT_DIGEST,
      haniel_journal_path: env.HANIEL_DEPLOYMENT_JOURNAL,
      status: "preflight_complete",
      pending_migrations: [{ id: "061_contract.sql", checksum: "1".repeat(64) }],
    });
    expect(existsSync(`${report.journal_path}.tmp`)).toBe(false);
  });

  it("rejects backup before a matching quiescence receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-quiescence-"));
    directories.push(directory);
    const env = environment(directory);
    const backupCreate = vi.fn();
    await preflight(env);

    await expect(runDatabaseRelease("backup", { env, backupCreate }))
      .rejects.toThrow("QUIESCENCE_REQUIRED");
    expect(backupCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["create", "BACKUP_CREATE_FAILED"],
    ["verify", "BACKUP_VERIFY_FAILED"],
  ])("keeps apply at zero when backup %s fails", async (failure, code) => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-backup-"));
    directories.push(directory);
    const env = await writeReceipt(environment(directory));
    const migrationRun = vi.fn();
    await preflight(env);

    if (failure === "create") {
      await expect(runDatabaseRelease("backup", {
        env,
        backupCreate: async () => { throw new Error("dump failed"); },
      })).rejects.toThrow(code);
    } else {
      await runDatabaseRelease("backup", {
        env,
        backupCreate: async () => ({ status: "created", dump_sha256: "b".repeat(64) }),
      });
      await expect(runDatabaseRelease("verify-backup", {
        env,
        backupVerify: async () => { throw new Error("archive invalid"); },
      })).rejects.toThrow(code);
    }
    await expect(runDatabaseRelease("apply", {
      env,
      inventoryRead: async () => populatedInventory(),
      planRead: async () => plan({ pending: [migration("061_contract.sql", 61)] }),
      migrationRun,
    })).rejects.toThrow("JOURNAL_GATE_FAILED");
    expect(migrationRun).not.toHaveBeenCalled();
  });

  it("does not require dump or restore for an empty fresh_install", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-fresh-"));
    directories.push(directory);
    const env = environment(directory, "fresh_install");
    const all = [migration("001_initial.sql", 1)];
    const backupCreate = vi.fn();
    const backupRecover = vi.fn();
    const migrationRun = vi.fn(async () => ({ status: "ok" }));
    let ledger: Array<Record<string, unknown>> = [];
    await runDatabaseRelease("preflight", {
      env,
      inventoryRead: async () => emptyInventory(),
      planRead: async () => plan({ pending: all }),
    });
    await runDatabaseRelease("apply", {
      env,
      inventoryRead: async () => emptyInventory(),
      planRead: async () => plan({ ledger, pending: ledger.length ? [] : all }),
      migrationRun: async (...args) => {
        ledger = all.map((item) => ({ ...item, release_id: env.HANIEL_RELEASE_ID }));
        return await migrationRun(...args);
      },
    });

    expect(backupCreate).not.toHaveBeenCalled();
    expect(backupRecover).not.toHaveBeenCalled();
    expect(migrationRun).toHaveBeenCalledTimes(1);
  });

  it("reconciles a commit that completed before the journal update", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-reconcile-"));
    directories.push(directory);
    const env = environment(directory, "fresh_install");
    const all = [migration("001_initial.sql", 1)];
    let ledger: Array<Record<string, unknown>> = [];
    const migrationRun = vi.fn(async () => {
      ledger = all.map((item) => ({ ...item, release_id: env.HANIEL_RELEASE_ID }));
    });
    await runDatabaseRelease("preflight", {
      env,
      inventoryRead: async () => emptyInventory(),
      planRead: async () => plan({ pending: all }),
    });
    await expect(runDatabaseRelease("apply", {
      env,
      inventoryRead: async () => emptyInventory(),
      planRead: async () => plan({ ledger, pending: ledger.length ? [] : all }),
      migrationRun,
      afterApplyCommit: async () => { throw new Error("simulated journal crash"); },
    })).rejects.toThrow("simulated journal crash");
    const retried = await runDatabaseRelease("apply", {
      env,
      inventoryRead: async () => populatedInventory(),
      planRead: async () => plan({ ledger, pending: [] }),
      migrationRun,
    });
    expect(retried).toMatchObject({ ok: true, status: "applied_reconciled" });
    expect(migrationRun).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade a committed release when the deepest caller reports late failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-late-error-"));
    directories.push(directory);
    const env = environment(directory, "fresh_install");
    const pending = [migration("001_initial.sql", 1)];
    let ledger: Array<Record<string, unknown>> = [];
    await runDatabaseRelease("preflight", {
      env,
      inventoryRead: async () => emptyInventory(),
      planRead: async () => plan({ pending }),
    });
    const report = await runDatabaseRelease("apply", {
      env,
      inventoryRead: async () => ledger.length ? populatedInventory() : emptyInventory(),
      planRead: async () => plan({ ledger, pending: ledger.length ? [] : pending }),
      migrationRun: async () => {
        ledger = pending.map((item) => ({ ...item, release_id: env.HANIEL_RELEASE_ID }));
        throw new Error("late caller failure");
      },
    });
    expect(report).toMatchObject({ status: "applied_reconciled" });
  });

  it("keeps completed journal retries idempotent after the pending plan becomes empty", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-applied-retry-"));
    directories.push(directory);
    const env = environment(directory, "fresh_install");
    const pending = [migration("001_initial.sql", 1)];
    let ledger: Array<Record<string, unknown>> = [];
    let installed = false;
    await runDatabaseRelease("preflight", {
      env,
      inventoryRead: async () => emptyInventory(),
      planRead: async () => plan({ pending }),
    });
    await runDatabaseRelease("apply", {
      env,
      inventoryRead: async () => installed ? populatedInventory() : emptyInventory(),
      planRead: async () => plan({ ledger, pending: ledger.length ? [] : pending }),
      migrationRun: async () => {
        ledger = pending.map((item) => ({ ...item, release_id: env.HANIEL_RELEASE_ID }));
        installed = true;
      },
    });

    await expect(runDatabaseRelease("preflight", {
      env,
      inventoryRead: async () => populatedInventory(),
      planRead: async () => plan({ ledger, pending: [] }),
    })).resolves.toMatchObject({ status: "applied" });
  });

  itWithDatabase("reconciles a real PostgreSQL commit after journal update loss", async () => {
    const testDatabaseUrl = await startIsolatedPostgres();
    const sql = postgres(testDatabaseUrl, { max: 1, idle_timeout: 1 });
    expect(await inspectUserObjectInventory(sql)).toMatchObject(emptyInventory());
    await sql.end({ timeout: 5 });
    const directory = mkdtempSync(join(tmpdir(), "soul-release-db-crash-"));
    directories.push(directory);
    const env = {
      ...environment(directory, "fresh_install"),
      TEST_DATABASE_URL: requireSafeTestDatabaseUrl(testDatabaseUrl),
      DATABASE_URL: requireSafeTestDatabaseUrl(testDatabaseUrl),
    };

    await runDatabaseRelease("preflight", { env });
    await expect(runDatabaseRelease("apply", {
      env,
      afterApplyCommit: async () => { throw new Error("simulated journal update loss"); },
    })).rejects.toThrow("simulated journal update loss");
    const committed = await readDatabaseReleaseJournal(databaseReleaseJournalPath(env));
    expect(committed.status).toBe("apply_started");

    const retried = await runDatabaseRelease("apply", { env });
    expect(retried).toMatchObject({ status: "applied_reconciled" });
    const verifySql = postgres(testDatabaseUrl, { max: 1, idle_timeout: 1 });
    const [count] = await verifySql`SELECT COUNT(*)::int AS count FROM schema_migrations`;
    expect(count.count).toBe(64);
    await verifySql.end({ timeout: 5 });
  }, 90_000);

  it("fails closed on a partial or foreign-release ledger", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-ambiguous-"));
    directories.push(directory);
    const env = environment(directory, "fresh_install");
    const all = [migration("001_initial.sql", 1), migration("002_more.sql", 2)];
    await runDatabaseRelease("preflight", {
      env,
      inventoryRead: async () => emptyInventory(),
      planRead: async () => plan({ pending: all }),
    });
    await expect(runDatabaseRelease("apply", {
      env,
      inventoryRead: async () => populatedInventory(),
      planRead: async () => plan({
        ledger: [{ ...all[0], release_id: "other-release" }],
        pending: [all[1]],
      }),
      migrationRun: vi.fn(),
    })).rejects.toThrow("AMBIGUOUS_COMMIT_STATE");
  });

  it("permits recovery only after a verified upgrade reaches apply", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-recovery-"));
    directories.push(directory);
    const env = await writeReceipt(environment(directory));
    const recoveryEnv = {
      ...env,
      HANIEL_DATABASE_OPERATION: "recovery",
      HANIEL_FAILED_DATABASE_OPERATION: "upgrade",
    };
    const pending = [migration("061_contract.sql", 61)];
    const backupRecover = vi.fn(async () => ({ status: "restored" }));
    await preflight(env, pending);
    await expect(executeDatabaseReleasePhase("restore", { env: recoveryEnv, backupRecover }))
      .rejects.toThrow("RECOVERY_FORBIDDEN");
    await runDatabaseRelease("backup", {
      env,
      backupCreate: async () => ({ status: "created", dump_sha256: "b".repeat(64) }),
    });
    await runDatabaseRelease("verify-backup", {
      env,
      backupVerify: async () => ({ status: "verified", verified_at: "2026-08-09T00:00:00Z" }),
    });
    await setHanielState(env, "migrating");
    await expect(runDatabaseRelease("apply", {
      env,
      inventoryRead: async () => populatedInventory(),
      planRead: async () => plan({ pending }),
      migrationRun: async () => { throw new Error("migration failed"); },
    })).rejects.toThrow("APPLY_FAILED");
    await setHanielState(env, "recovering");
    await expect(executeDatabaseReleasePhase("restore", { env: recoveryEnv, backupRecover }))
      .resolves.toMatchObject({ operation: "recovery", recovered: true, phase: "recovery" });
    expect(backupRecover).toHaveBeenCalledTimes(1);
  });

  it("refuses the deepest writer without an apply_started journal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-gate-"));
    directories.push(directory);
    const env = environment(directory);
    const pending = [migration("061_contract.sql", 61)];
    await preflight(env, pending);
    const { assertDatabaseReleaseApplyGate } = await import(
      "../../../packages/db-schema/scripts/database-release-journal.mjs"
    );

    await expect(assertDatabaseReleaseApplyGate({
      env,
      operation: "upgrade",
      plan: plan({ pending }),
      inventory: populatedInventory(),
    })).rejects.toThrow("JOURNAL_GATE_FAILED");
  });
  it("persists only bounded structured journal data", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-release-bounded-"));
    directories.push(directory);
    const env = environment(directory);
    await preflight(env, []);
    const raw = readFileSync(databaseReleaseJournalPath(env), "utf8");
    expect(raw.length).toBeLessThan(64_000);
    expect(raw).not.toContain("DATABASE_URL");
  });
});

function requireSafeTestDatabaseUrl(value: string) {
  const url = new URL(value);
  const database = url.pathname.slice(1);
  if (!database.includes("test") || database.includes("soulstream")) {
    throw new Error(`unsafe TEST_DATABASE_URL database name: ${database}`);
  }
  return value;
}

async function startIsolatedPostgres() {
  const lease = await provisionTestDatabase({
    prefix: "release_executor",
    dockerUser: "release_executor_test",
    dockerPassword: "release_executor_secret",
    dockerDatabase: "release_executor_test_db",
  });
  databaseLeases.push(lease);
  return requireSafeTestDatabaseUrl(lease.url);
}
