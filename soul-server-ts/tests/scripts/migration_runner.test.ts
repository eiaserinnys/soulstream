import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";

import { assertPostgresBackupPrerequisites } from
  "../../../packages/db-schema/scripts/postgres-backup-tools.mjs";

const MIGRATE = fileURLToPath(
  new URL("../../../packages/db-schema/scripts/migrate.mjs", import.meta.url),
);
const BACKUP = fileURLToPath(
  new URL("../../../packages/db-schema/scripts/backup.mjs", import.meta.url),
);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_USER = "migration_runner_test";
const TEST_PASSWORD = "migration_runner_secret";
const TEST_DB = "migration_runner_test_db";

const containers: string[] = [];
const tempDirs: string[] = [];
const itWithDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0
  ? it
  : it.skip;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const container of containers.splice(0)) {
    execFileSync("docker", ["stop", container], { stdio: "ignore" });
  }
});

describe.sequential("versioned migration runner", () => {
  itWithDocker("initializes fresh and bootstraps current databases without replaying 041 or 042", async () => {
    const url = await startPostgres();
    const cwd = environmentDirectory(url);
    const serviceEnvironment = { HANIEL_SERVICE_CWD: cwd };

    const prerequisites = await assertPostgresBackupPrerequisites({ databaseUrl: url });
    expect(prerequisites).toMatchObject({
      server_major: 16,
      pg_dump_major: 16,
      pg_restore_major: 16,
      restore_capability: "verified",
    });

    const fresh = runWithEnv(MIGRATE, REPOSITORY_ROOT, serviceEnvironment, "initialize");
    expect(fresh.status).toBe(0);
    expectNoSecret(fresh);

    const sql = postgres(url, { max: 1, idle_timeout: 1 });
    try {
      await seedCurrentTask(sql);
      await sql`DROP TABLE schema_migrations`;

      const first = runWithEnv(MIGRATE, REPOSITORY_ROOT, serviceEnvironment, "apply");
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
        migration_count: 44,
        operation_count: 1,
        applied_kind_count: 1,
        applied_kind: "bootstrap",
        migration_041_kind: "bootstrap",
        migration_042_kind: "bootstrap",
      });

      const repeated = runWithEnv(MIGRATE, REPOSITORY_ROOT, serviceEnvironment, "apply");
      expect(repeated.status).toBe(0);
      const afterRetry = await sql`
        SELECT COUNT(*)::int AS count FROM schema_migrations
      `;
      expect(afterRetry[0].count).toBe(44);

      const backupDirectory = join(cwd, "backup");
      const backupEnvironment = {
        ...serviceEnvironment,
        HANIEL_BACKUP_DIR: backupDirectory,
        HANIEL_TARGET_HEAD: "integration-test-head",
      };
      const backup = runWithEnv(BACKUP, REPOSITORY_ROOT, backupEnvironment, "create");
      expect(backup.status).toBe(0);
      expectNoSecret(backup);
      const verified = runWithEnv(BACKUP, REPOSITORY_ROOT, backupEnvironment, "verify");
      expect(verified.status).toBe(0);
      expectNoSecret(verified);
      expect(JSON.parse(readFileSync(join(backupDirectory, "database-backup.json"), "utf8")))
        .toMatchObject({
          status: "verified_not_required",
          target_head: "integration-test-head",
          destructive_pending: [],
        });
      expect(existsSync(join(backupDirectory, "database.dump"))).toBe(false);
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
  const directory = mkdtempSync(join(tmpdir(), "soul-migration-runner-"));
  tempDirs.push(directory);
  writeFileSync(
    join(directory, ".env.soul-server-ts"),
    `DATABASE_URL=${databaseUrl}\nSOULSTREAM_RELEASE_ID=integration-test\n`,
    "utf8",
  );
  return directory;
}

async function startPostgres() {
  const container = execFileSync("docker", [
    "run", "--rm", "-d",
    "-e", `POSTGRES_USER=${TEST_USER}`,
    "-e", `POSTGRES_PASSWORD=${TEST_PASSWORD}`,
    "-e", `POSTGRES_DB=${TEST_DB}`,
    "-p", "127.0.0.1::5432",
    "postgres:16-alpine",
  ], { encoding: "utf8" }).trim();
  containers.push(container);
  const port = dockerPort(container);
  const url = `postgres://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${port}/${TEST_DB}`;
  const sql = postgres(url, { max: 1, idle_timeout: 1 });
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      try {
        await sql`SELECT 1`;
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return url;
}

function dockerPort(container: string) {
  const output = execFileSync("docker", ["port", container, "5432/tcp"], {
    encoding: "utf8",
  }).trim();
  const match = output.match(/:(\d+)$/);
  if (!match) throw new Error("docker did not publish PostgreSQL port");
  return match[1];
}

function expectNoSecret(result: { stdout: string; stderr: string }) {
  expect(`${result.stdout}\n${result.stderr}`).not.toContain(TEST_PASSWORD);
}
