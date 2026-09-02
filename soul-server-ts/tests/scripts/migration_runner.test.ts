import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const migrationManifest = JSON.parse(readFileSync(
  new URL("../../../packages/db-schema/migration-manifest.json", import.meta.url),
  "utf8",
)) as { migrations?: Array<{ id: string }> };
if (!Array.isArray(migrationManifest.migrations)) {
  throw new Error("migration runner fixture requires a migration manifest");
}
const MANIFEST_MIGRATIONS = migrationManifest.migrations;
if (!MANIFEST_MIGRATIONS.at(-1)) {
  throw new Error("migration runner fixture requires at least one migration");
}
const MANIFEST_MIGRATION_COUNT = MANIFEST_MIGRATIONS.length;

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

    const fresh = runWithEnv(MIGRATE, REPOSITORY_ROOT, serviceEnvironment, "initialize");
    expect(fresh.status, fresh.stderr || fresh.stdout).toBe(0);
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
        state: "migrating",
        quiescence_receipt: receipt,
      }), "utf8");
      const preflight = runWithEnv(
        RELEASE_EXECUTOR, REPOSITORY_ROOT, gatedEnvironment, "preflight",
      );
      expect(preflight.status).toBe(0);
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
        migration_count: MANIFEST_MIGRATION_COUNT,
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
      expect(afterRetry[0].count).toBe(MANIFEST_MIGRATION_COUNT);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
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
