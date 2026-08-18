import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";

import {
  hasTestDatabaseResource,
  provisionTestDatabase,
  type TestDatabaseLease,
} from "./database_test_harness.js";

import { makeTempDirSync } from "../helpers/temp_dir.js";

import { assertPostgresBackupPrerequisites } from
  "../../../packages/db-schema/scripts/postgres-backup-tools.mjs";
import { MIGRATION_LOCK_ID, MIGRATION_LOCK_NAMESPACE } from
  "../../../packages/db-schema/scripts/migration-contract.mjs";

const MIGRATE = fileURLToPath(
  new URL("../../../packages/db-schema/scripts/migrate.mjs", import.meta.url),
);
const RELEASE_EXECUTOR = fileURLToPath(
  new URL("../../../packages/db-schema/scripts/release-executor.mjs", import.meta.url),
);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_USER = "migration_runner_test";
const TEST_PASSWORD = "migration_runner_secret";
const TEST_DB = "migration_runner_test_db";

const databaseLeases: TestDatabaseLease[] = [];
const tempDirs: string[] = [];
const itWithDatabase = hasTestDatabaseResource()
  ? it
  : it.skip;

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const lease of databaseLeases.splice(0)) await lease.cleanup();
});

describe.sequential("versioned migration runner", () => {
  itWithDatabase("initializes fresh and bootstraps current databases without replaying 041 or 042", async () => {
    const url = await startPostgres();
    const cwd = environmentDirectory(url);
    const serviceEnvironment = { HANIEL_SERVICE_CWD: cwd };

    const prerequisites = await assertPostgresBackupPrerequisites({ databaseUrl: url });
    expect(prerequisites.server_major).toBeGreaterThanOrEqual(16);
    expect(prerequisites.pg_dump_major).toBeGreaterThanOrEqual(prerequisites.server_major);
    expect(prerequisites.pg_restore_major).toBeGreaterThanOrEqual(prerequisites.server_major);
    expect(prerequisites.restore_capability).toBe("verified");

    const fresh = runWithEnv(MIGRATE, REPOSITORY_ROOT, serviceEnvironment, "initialize");
    expect(fresh.status).toBe(0);
    expectNoSecret(fresh);

    const sql = postgres(url, { max: 1, idle_timeout: 1 });
    try {
      await seedCurrentTask(sql);
      await sql`DROP TABLE schema_migrations`;

      const backupDirectory = join(cwd, "backup");
      mkdirSync(backupDirectory, { recursive: true });
      const receiptPath = join(backupDirectory, "quiescence.json");
      const gatedEnvironment = {
        ...serviceEnvironment,
        HANIEL_BACKUP_DIR: backupDirectory,
        HANIEL_DATABASE_OPERATION: "upgrade",
        HANIEL_DATABASE_REQUIRED_SUBPHASES: "[]",
        HANIEL_DATABASE_WRITER_SERVICES: '["soulstream-orch-server"]',
        HANIEL_DEPLOYMENT_JOURNAL: join(backupDirectory, "haniel-deployment.json"),
        HANIEL_DEPLOY_REPO: "soulstream",
        HANIEL_DATABASE_CONTRACT_DIGEST: "b".repeat(64),
        HANIEL_MANIFEST_DIGEST: "a".repeat(64),
        HANIEL_PREVIOUS_HEAD: "1".repeat(40),
        HANIEL_QUIESCENCE_RECEIPT: receiptPath,
        HANIEL_RELEASE_ID: "fresh-install-test",
        HANIEL_REQUEST_ID: "migration-runner-test",
        HANIEL_TARGET_HEAD: "2".repeat(40),
      };
      const receipt = {
        request_id: gatedEnvironment.HANIEL_REQUEST_ID,
        repo: gatedEnvironment.HANIEL_DEPLOY_REPO,
        target_head: gatedEnvironment.HANIEL_TARGET_HEAD,
        owner_instance: "owner-1",
        quiescence_nonce: "nonce-1",
        stopped_services: ["soulstream-orch-server"],
        already_stopped_services: [],
        quiesced_services: ["soulstream-orch-server"],
      };
      writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");
      writeFileSync(gatedEnvironment.HANIEL_DEPLOYMENT_JOURNAL, JSON.stringify({
        repo: gatedEnvironment.HANIEL_DEPLOY_REPO,
        request_id: gatedEnvironment.HANIEL_REQUEST_ID,
        target_head: gatedEnvironment.HANIEL_TARGET_HEAD,
        operation: "upgrade",
        expected_operation: "upgrade",
        manifest_digest: gatedEnvironment.HANIEL_MANIFEST_DIGEST,
        database_journal_path: join(backupDirectory, "database-release.json"),
        state: "backing_up",
        quiescence_receipt: receipt,
      }), "utf8");
      const preflight = runWithEnv(
        RELEASE_EXECUTOR, REPOSITORY_ROOT, gatedEnvironment, "preflight",
      );
      expect(preflight.status).toBe(0);
      const backup = runWithEnv(RELEASE_EXECUTOR, REPOSITORY_ROOT, gatedEnvironment, "backup");
      expect(backup.status).toBe(0);
      expectNoSecret(backup);
      const verified = runWithEnv(
        RELEASE_EXECUTOR, REPOSITORY_ROOT, gatedEnvironment, "verify-backup",
      );
      expect(verified.status).toBe(0);
      expectNoSecret(verified);
      expect(JSON.parse(readFileSync(join(backupDirectory, "database-backup.json"), "utf8")))
        .toMatchObject({
          status: "verified",
          target_head: "2".repeat(40),
          destructive_pending: ["053_retire_supervisor.sql"],
          rollback_unsafe_pending: [
            "053_retire_supervisor.sql",
            "058_session_delete_ydoc_guard.sql",
            "059_scope_board_seed_items.sql",
          ],
        });
      expect(existsSync(join(backupDirectory, "database.dump"))).toBe(true);

      writeFileSync(gatedEnvironment.HANIEL_DEPLOYMENT_JOURNAL, JSON.stringify({
        ...JSON.parse(readFileSync(gatedEnvironment.HANIEL_DEPLOYMENT_JOURNAL, "utf8")),
        state: "migrating",
      }), "utf8");
      const first = runWithEnv(RELEASE_EXECUTOR, REPOSITORY_ROOT, gatedEnvironment, "apply");
      expect(first.status).toBe(0);
      expectNoSecret(first);

      const rows = await sql`
        SELECT
          (SELECT COUNT(*)::int FROM schema_migrations) AS migration_count,
          (SELECT COUNT(*)::int FROM task_operations WHERE id = 'operation-sentinel')
            AS operation_count,
          (SELECT COUNT(DISTINCT applied_kind)::int FROM schema_migrations)
            AS applied_kind_count,
          (SELECT MIN(applied_kind) FROM schema_migrations) AS applied_kind,
          (SELECT applied_kind FROM schema_migrations
            WHERE migration_id = '041_retire_task_tree.sql') AS migration_041_kind,
          (SELECT applied_kind FROM schema_migrations
            WHERE migration_id = '042_runbook_to_task.sql') AS migration_042_kind
      `;
      expect(rows[0]).toMatchObject({
        migration_count: 68,
        operation_count: 1,
        applied_kind_count: 2,
        applied_kind: "bootstrap",
        migration_041_kind: "bootstrap",
        migration_042_kind: "bootstrap",
      });

      const repeated = runWithEnv(RELEASE_EXECUTOR, REPOSITORY_ROOT, gatedEnvironment, "apply");
      expect(repeated.status).toBe(0);
      const afterRetry = await sql`
        SELECT COUNT(*)::int AS count FROM schema_migrations
      `;
      expect(afterRetry[0].count).toBe(68);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  itWithDatabase("revalidates backup, archive, plan and serializes recovery after the advisory wait", async () => {
    const url = await startPostgres();
    const cwd = environmentDirectory(url);
    const serviceEnvironment = { HANIEL_SERVICE_CWD: cwd };
    const initialized = runWithEnv(MIGRATE, REPOSITORY_ROOT, serviceEnvironment, "initialize");
    expect(initialized.status).toBe(0);
    const sql = postgres(url, { max: 1, idle_timeout: 1 });
    try {
      await sql`DROP TABLE schema_migrations`;
      const backupDirectory = join(cwd, "review-backup");
      mkdirSync(backupDirectory, { recursive: true });
      const receiptPath = join(backupDirectory, "quiescence.json");
      const deploymentPath = join(backupDirectory, "haniel-deployment.json");
      const environment = {
        ...serviceEnvironment,
        HANIEL_BACKUP_DIR: backupDirectory,
        HANIEL_DATABASE_OPERATION: "upgrade",
        HANIEL_DATABASE_REQUIRED_SUBPHASES: "[]",
        HANIEL_DATABASE_WRITER_SERVICES: '["soulstream-orch-server"]',
        HANIEL_DEPLOYMENT_JOURNAL: deploymentPath,
        HANIEL_DEPLOY_REPO: "soulstream",
        HANIEL_DATABASE_CONTRACT_DIGEST: "b".repeat(64),
        HANIEL_MANIFEST_DIGEST: "a".repeat(64),
        HANIEL_PREVIOUS_HEAD: "1".repeat(40),
        HANIEL_QUIESCENCE_RECEIPT: receiptPath,
        HANIEL_RELEASE_ID: "review-release",
        HANIEL_REQUEST_ID: "review-request",
        HANIEL_TARGET_HEAD: "2".repeat(40),
      };
      const receipt = {
        request_id: environment.HANIEL_REQUEST_ID,
        repo: environment.HANIEL_DEPLOY_REPO,
        target_head: environment.HANIEL_TARGET_HEAD,
        owner_instance: "owner-1",
        quiescence_nonce: "nonce-1",
        stopped_services: ["soulstream-orch-server"],
        already_stopped_services: [],
        quiesced_services: ["soulstream-orch-server"],
      };
      writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");
      const journalPath = join(backupDirectory, "database-release.json");
      writeFileSync(deploymentPath, JSON.stringify({
        repo: environment.HANIEL_DEPLOY_REPO,
        request_id: environment.HANIEL_REQUEST_ID,
        target_head: environment.HANIEL_TARGET_HEAD,
        operation: "upgrade",
        expected_operation: "upgrade",
        manifest_digest: environment.HANIEL_MANIFEST_DIGEST,
        database_journal_path: journalPath,
        state: "backing_up",
        quiescence_receipt: receipt,
      }), "utf8");
      expect(runWithEnv(RELEASE_EXECUTOR, REPOSITORY_ROOT, environment, "preflight").status)
        .toBe(0);
      expect(runWithEnv(RELEASE_EXECUTOR, REPOSITORY_ROOT, environment, "backup").status)
        .toBe(0);
      expect(runWithEnv(RELEASE_EXECUTOR, REPOSITORY_ROOT, environment, "verify-backup").status)
        .toBe(0);
      writeFileSync(deploymentPath, JSON.stringify({
        ...JSON.parse(readFileSync(deploymentPath, "utf8")), state: "migrating",
      }), "utf8");
      const metadataPath = join(backupDirectory, "database-backup.json");
      const dumpPath = join(backupDirectory, "database.dump");
      const metadata = readFileSync(metadataPath);
      const dump = readFileSync(dumpPath);

      const tamperCases: Array<{
        name: string;
        mutate: () => Promise<void> | void;
        restore: () => Promise<void> | void;
      }> = [
        {
          name: "metadata replacement",
          mutate: () => writeFileSync(metadataPath, JSON.stringify({
            ...JSON.parse(metadata.toString("utf8")), verified_at: "replaced",
          })),
          restore: () => writeFileSync(metadataPath, metadata),
        },
        {
          name: "metadata deletion",
          mutate: () => rmSync(metadataPath),
          restore: () => writeFileSync(metadataPath, metadata),
        },
        {
          name: "archive checksum change",
          mutate: () => writeFileSync(dumpPath, Buffer.concat([dump, Buffer.from("tampered")])),
          restore: () => writeFileSync(dumpPath, dump),
        },
        {
          name: "pending plan change",
          mutate: async () => {
            await sql.unsafe(`
              CREATE TABLE schema_migrations (
                migration_id TEXT PRIMARY KEY,
                checksum TEXT NOT NULL,
                release_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL UNIQUE,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                applied_kind TEXT NOT NULL
              )
            `);
            await sql`
              INSERT INTO schema_migrations (
                migration_id, checksum, release_id, ordinal, applied_kind
              ) VALUES (
                '001_initial.sql', ${"1".repeat(64)}, 'foreign-release', 1, 'migration'
              )
            `;
          },
          restore: () => undefined,
        },
      ];

      for (const [index, tamper] of tamperCases.entries()) {
        const lock = await holdMigrationLock(url);
        const priorRevision = JSON.parse(readFileSync(journalPath, "utf8")).revision;
        const applying = spawnWithEnv(RELEASE_EXECUTOR, REPOSITORY_ROOT, environment, "apply");
        await waitForJournal(journalPath, "apply_started", priorRevision + 1);
        await waitForMigrationLockWait(sql);
        await tamper.mutate();
        let recovering: ReturnType<typeof spawnWithEnv> | null = null;
        if (index === 0) {
          recovering = spawnWithEnv(RELEASE_EXECUTOR, REPOSITORY_ROOT, {
            ...environment,
            HANIEL_DATABASE_OPERATION: "recovery",
            HANIEL_FAILED_DATABASE_OPERATION: "upgrade",
          }, "recover");
          await new Promise((resolve) => setTimeout(resolve, 150));
          expect(recovering.done, "recovery must wait behind the apply phase lease").toBe(false);
        }
        lock.release();
        await lock.finished;
        const applyResult = await applying.result;
        expect(applyResult.status, tamper.name).toBe(1);
        expect(applyResult.stderr, tamper.name).toContain("JOURNAL_GATE_FAILED");
        if (recovering) {
          const recoveryResult = await recovering.result;
          expect(recoveryResult.status).toBe(1);
          expect(recoveryResult.stderr).toContain("RECOVERY_FORBIDDEN");
        }
        await tamper.restore();
      }
      const ledger = await sql`SELECT COUNT(*)::int AS count FROM schema_migrations`;
      expect(ledger[0].count).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});

async function seedCurrentTask(sql: ReturnType<typeof postgres>) {
  await sql`
    INSERT INTO folders (id, name, sort_order)
    VALUES ('folder-sentinel', 'Sentinel', 0)
  `;
  await sql`
    INSERT INTO board_items (
      id, folder_id, container_kind, container_id, item_type, item_id
    ) VALUES (
      'task:sentinel', 'folder-sentinel', 'folder', 'folder-sentinel',
      'task', 'task-sentinel'
    )
  `;
  await sql`
    INSERT INTO tasks (id, board_item_id, title)
    VALUES ('task-sentinel', 'task:sentinel', 'Sentinel task')
  `;
  await sql`
    INSERT INTO task_operations (
      id, task_id, target_kind, target_id, operation_type, actor_kind
    ) VALUES (
      'operation-sentinel', 'task-sentinel', 'task', 'task-sentinel',
      'create_task', 'system'
    )
  `;
}

function runWithEnv(
  script: string,
  cwd: string,
  extraEnvironment: Record<string, string>,
  ...args: string[]
) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ...extraEnvironment,
    },
    timeout: 60_000,
  });
}

function environmentDirectory(databaseUrl: string) {
  const directory = makeTempDirSync("soul-migration-runner-");
  tempDirs.push(directory);
  writeFileSync(
    join(directory, ".env.soul-server-ts"),
    `DATABASE_URL=${databaseUrl}\nSOULSTREAM_RELEASE_ID=integration-test\n`,
    "utf8",
  );
  return directory;
}

async function startPostgres() {
  const lease = await provisionTestDatabase({
    prefix: "migration_runner",
    dockerUser: TEST_USER,
    dockerPassword: TEST_PASSWORD,
    dockerDatabase: TEST_DB,
  });
  databaseLeases.push(lease);
  return lease.url;
}

function expectNoSecret(result: { stdout: string; stderr: string }) {
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(TEST_PASSWORD);
}

function spawnWithEnv(
  script: string,
  cwd: string,
  extraEnvironment: Record<string, string>,
  ...args: string[]
) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ...extraEnvironment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let done = false;
  const result = new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("close", (status) => {
        done = true;
        resolve({ status, stdout, stderr });
      });
    },
  );
  return { child, result, get done() { return done; } };
}

async function holdMigrationLock(databaseUrl: string) {
  const lockSql = postgres(databaseUrl, { max: 1, idle_timeout: 1 });
  let release!: () => void;
  let locked!: () => void;
  const acquired = new Promise<void>((resolve) => { locked = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const finished = lockSql.begin(async (transaction) => {
    await transaction`
      SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_ID})
    `;
    locked();
    await wait;
  }).finally(async () => await lockSql.end({ timeout: 5 }));
  await acquired;
  return { release, finished };
}

async function waitForJournal(path: string, status: string, minimumRevision: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const journal = JSON.parse(readFileSync(path, "utf8"));
    if (journal.status === status && journal.revision >= minimumRevision) return journal;
    if (Date.now() >= deadline) {
      throw new Error(`journal did not reach ${status} revision ${minimumRevision}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForMigrationLockWait(sql: ReturnType<typeof postgres>) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await sql`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%pg_advisory_xact_lock%'
    `;
    if (rows[0].count > 0) return;
    if (Date.now() >= deadline) throw new Error("apply did not wait on migration advisory lock");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
