import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/apply-schema.mjs", import.meta.url));
const MIGRATION_SCRIPT_PATH = fileURLToPath(new URL(
  "../../../packages/db-schema/scripts/migrate.mjs",
  import.meta.url,
));
const PAGE_MODEL_MIGRATION_PATH = fileURLToPath(new URL(
  "../../../packages/db-schema/sql/migrations/032_page_block_model.sql",
  import.meta.url,
));
const YAML_PATH = fileURLToPath(
  new URL("../../../install/haniel-soul-server-ts.example.yaml", import.meta.url),
);
const STANDALONE_YAML_PATH = fileURLToPath(
  new URL("../../../install/haniel-standalone.yaml.template", import.meta.url),
);
const INSTALLER_PATH = fileURLToPath(new URL("../../../install/install.ps1", import.meta.url));
const EIASERINNYS_FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/eiaserinnys-haniel-services.yaml", import.meta.url),
);

const TEST_DB_NAME = "apply_schema_test_db";
const TEST_USER = "apply_schema_test";
const TEST_PASSWORD = "apply_schema_secret";

const tempDirs: string[] = [];
const containers: string[] = [];
const itWithDocker = hasDockerBinary() ? it : it.skip;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const container of containers.splice(0)) {
    execFileSync("docker", ["stop", container], { stdio: "ignore" });
  }
});

describe("apply-schema.mjs", () => {
  itWithDocker("initializes a fresh database and is safe on a current database", async () => {
    const { url } = await startPostgres();
    const cwd = writeEnv(url);

    const first = runApplySchema(cwd);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("[apply-schema] schema applied");
    expectNoSecretLeak(first);

    const repeated = runApplySchema(cwd);
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toContain('"schema_state":"current"');
    expectNoSecretLeak(repeated);

    const notices: Array<{ severity?: string; code?: string }> = [];
    const sql = postgres(url, {
      max: 1,
      idle_timeout: 1,
      onnotice: (notice) => notices.push(notice),
    });
    try {
      const rows = await sql<Array<{
        heartbeat_table: string | null;
        transcript_table: string | null;
        transcript_function_count: string | number;
        migration_count: string | number;
      }>>`
        SELECT
          to_regclass('public.soulstream_node_heartbeats')::text AS heartbeat_table,
          to_regclass('public.claude_transcript_entries')::text AS transcript_table,
          (
            SELECT COUNT(*)::int
            FROM pg_proc
            WHERE proname = 'claude_transcript_append'
          ) AS transcript_function_count,
          (SELECT COUNT(*)::int FROM schema_migrations) AS migration_count
      `;

      expect(rows[0]).toMatchObject({
        heartbeat_table: "soulstream_node_heartbeats",
        transcript_table: "claude_transcript_entries",
        transcript_function_count: 1,
        migration_count: 48,
      });

      const pageModelTables = await sql<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('pages', 'blocks', 'block_operations', 'block_links')
        ORDER BY table_name
      `;
      expect(pageModelTables.map((row) => row.table_name)).toEqual([
        "block_links",
        "block_operations",
        "blocks",
        "pages",
      ]);

      const pageModelColumns = await sql<Array<{
        table_name: string;
        column_name: string;
        is_nullable: string;
        data_type: string;
        is_generated: string;
      }>>`
        SELECT table_name, column_name, is_nullable, data_type, is_generated
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('pages', 'blocks', 'block_operations', 'block_links')
        ORDER BY table_name, ordinal_position
      `;
      expect(columnNames(pageModelColumns, "pages")).toEqual([
        "id", "title", "title_key", "daily_date", "version", "archived", "metadata",
        "created_session_id", "created_event_id", "updated_session_id", "updated_event_id",
        "created_at", "updated_at",
      ]);
      expect(columnNames(pageModelColumns, "blocks")).toEqual([
        "id", "page_id", "parent_id", "position_key", "block_type", "text_plain",
        "properties", "collapsed", "created_session_id", "created_event_id",
        "updated_session_id", "updated_event_id", "created_at", "updated_at",
      ]);
      expect(columnNames(pageModelColumns, "block_operations")).toEqual([
        "id", "page_id", "target_block_id", "operation_type", "actor_kind",
        "actor_session_id", "actor_event_id", "actor_user_id", "idempotency_key",
        "expected_version", "result_version", "payload_json", "reason", "created_at",
      ]);
      expect(columnNames(pageModelColumns, "block_links")).toEqual([
        "id", "source_block_id", "link_kind", "ordinal", "source_start", "source_end",
        "target_page_id", "target_title", "target_title_key", "target_block_id",
        "target_block_ref", "created_at",
      ]);
      expect(pageModelColumns.find(
        (row) => row.table_name === "pages" && row.column_name === "title_key",
      )).toMatchObject({ is_generated: "ALWAYS", is_nullable: "YES" });

      const pageModelConstraints = await sql<Array<{ constraint_name: string }>>`
        SELECT con.conname AS constraint_name
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        WHERE ns.nspname = 'public'
          AND rel.relname IN ('pages', 'blocks', 'block_operations', 'block_links')
        ORDER BY con.conname
      `;
      expect(pageModelConstraints.map((row) => row.constraint_name)).toEqual(
        expect.arrayContaining([
          "pages_created_event_fkey",
          "pages_updated_event_fkey",
          "pages_title_check",
          "pages_version_check",
          "blocks_parent_same_page_fkey",
          "blocks_not_own_parent",
          "blocks_created_event_fkey",
          "blocks_updated_event_fkey",
          "block_operations_actor_event_fkey",
          "block_operations_agent_actor_check",
          "block_operations_user_actor_check",
          "block_operations_version_check",
          "block_links_target_shape_check",
          "uq_blocks_page_id_id",
          "uq_block_links_source_ordinal",
        ]),
      );

      const pageModelIndexes = await sql<Array<{ indexname: string }>>`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('pages', 'blocks', 'block_operations', 'block_links')
        ORDER BY indexname
      `;
      expect(pageModelIndexes.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          "uq_pages_title_key",
          "uq_pages_daily_date",
          "idx_pages_active_updated",
          "idx_blocks_tree",
          "idx_blocks_type",
          "uq_block_operations_idempotency",
          "idx_block_operations_page",
          "idx_block_operations_target",
          "idx_block_links_target_page",
          "idx_block_links_unresolved_page",
          "idx_block_links_target_block",
        ]),
      );

      await sql`
        INSERT INTO pages (id, title, daily_date)
        VALUES ('page-schema-1', '  Daily Note  ', DATE '2026-07-11')
      `;
      await expect(sql`
        INSERT INTO pages (id, title)
        VALUES ('page-schema-2', 'daily note')
      `).rejects.toMatchObject({ code: "23505" });
      await expect(sql`
        INSERT INTO pages (id, title, daily_date)
        VALUES ('page-schema-3', 'Another page', DATE '2026-07-11')
      `).rejects.toMatchObject({ code: "23505" });

      await sql`
        INSERT INTO blocks (id, page_id, position_key)
        VALUES ('block-schema-1', 'page-schema-1', 'V')
      `;
      await sql`
        INSERT INTO block_operations (
          id, page_id, operation_type, actor_kind, idempotency_key,
          expected_version, result_version
        ) VALUES (
          'operation-system', 'page-schema-1', 'create_block', 'system',
          'schema:system:1', 1, 2
        )
      `;
      await expect(sql`
        INSERT INTO block_operations (
          id, page_id, operation_type, actor_kind, idempotency_key,
          expected_version, result_version
        ) VALUES (
          'operation-agent-missing-session', 'page-schema-1', 'create_block', 'agent',
          'schema:agent:1', 2, 3
        )
      `).rejects.toMatchObject({ code: "23514" });
      await expect(sql`
        INSERT INTO block_operations (
          id, page_id, operation_type, actor_kind, idempotency_key,
          expected_version, result_version
        ) VALUES (
          'operation-user-missing-id', 'page-schema-1', 'create_block', 'user',
          'schema:user:1', 2, 3
        )
      `).rejects.toMatchObject({ code: "23514" });
      await expect(sql`
        INSERT INTO block_links (
          id, source_block_id, link_kind, ordinal, source_start, source_end
        ) VALUES (
          'link-invalid-shape', 'block-schema-1', 'inline_page', 0, 0, 8
        )
      `).rejects.toMatchObject({ code: "23514" });

      await sql.unsafe(`
        ALTER TABLE tasks DROP CONSTRAINT tasks_task_page_id_fkey;
        ALTER TABLE folders DROP CONSTRAINT folders_project_page_id_fkey;
        DROP TABLE checklist_task_projection_outbox;
        DROP TABLE block_links;
        DROP TABLE block_operations;
        DROP TABLE blocks;
        DROP TABLE pages;
      `);
      const pageModelMigration = readFileSync(PAGE_MODEL_MIGRATION_PATH, "utf8");
      await sql.unsafe(pageModelMigration);
      notices.length = 0;
      await sql.unsafe(pageModelMigration);
      expect(notices.length).toBeGreaterThan(0);
      expect(notices.every(
        (notice) => notice.severity === "NOTICE" && notice.code === "42P07",
      )).toBe(true);
      const migratedTables = await sql<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('pages', 'blocks', 'block_operations', 'block_links')
        ORDER BY table_name
      `;
      expect(migratedTables.map((row) => row.table_name)).toEqual([
        "block_links",
        "block_operations",
        "blocks",
        "pages",
      ]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  itWithDocker(
    "applies promoted runtime migrations once under the shared advisory lock",
    async () => {
      const { url } = await startPostgres();
      const cwd = writeEnv(url);
      expect(runApplySchema(cwd).status).toBe(0);

      const sql = postgres(url, { max: 2, idle_timeout: 1 });
      try {
        await resetToPreRuntimeMigrationState(sql);

        const [left, right] = await Promise.all([
          runMigrationAsync(cwd, "apply"),
          runMigrationAsync(cwd, "apply"),
        ]);
        expect(left.status).toBe(0);
        expect(right.status).toBe(0);
        expectNoSecretLeak(left);
        expectNoSecretLeak(right);

        const promoted = await sql<Array<{
          migration_id: string;
          ordinal: number;
          applied_kind: string;
        }>>`
          SELECT migration_id, ordinal, applied_kind
          FROM schema_migrations
          WHERE ordinal >= 45
          ORDER BY ordinal
        `;
        expect(promoted).toEqual([
          {
            migration_id: "043_session_deliveries.sql",
            ordinal: 45,
            applied_kind: "migration",
          },
          {
            migration_id: "044_session_metadata_search.sql",
            ordinal: 46,
            applied_kind: "migration",
          },
          {
            migration_id: "045_claude_background_tasks.sql",
            ordinal: 47,
            applied_kind: "migration",
          },
          {
            migration_id: "046_session_delivery_relation_consumptions.sql",
            ordinal: 48,
            applied_kind: "migration",
          },
        ]);

        const objects = await sql<Array<{
          deliveries: string | null;
          background_tasks: string | null;
          relation_consumptions: string | null;
        }>>`
          SELECT
            to_regclass('session_deliveries')::text AS deliveries,
            to_regclass('claude_background_tasks')::text AS background_tasks,
            to_regclass('session_delivery_relation_consumptions')::text
              AS relation_consumptions
        `;
        expect(objects[0]).toEqual({
          deliveries: "session_deliveries",
          background_tasks: "claude_background_tasks",
          relation_consumptions: "session_delivery_relation_consumptions",
        });

        const repeated = runMigration(cwd, "apply");
        expect(repeated.status).toBe(0);
        expect(repeated.stdout).toContain('"pending":[]');
        expectNoSecretLeak(repeated);

        const verified = runMigration(cwd, "verify");
        expect(verified.status).toBe(0);
        expect(verified.stdout).toContain('"ledger_count":48');
        expectNoSecretLeak(verified);
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
    90_000,
  );

  itWithDocker(
    "aborts the release migration transaction and blocks startup verification on DDL failure",
    async () => {
      const { url } = await startPostgres();
      const cwd = writeEnv(url);
      expect(runApplySchema(cwd).status).toBe(0);

      const sql = postgres(url, { max: 1, idle_timeout: 1 });
      try {
        await resetToPreRuntimeMigrationState(sql);
        await sql.unsafe(`
          CREATE VIEW session_deliveries AS
          SELECT 'incompatible-object'::text AS delivery_id
        `);

        const failed = runMigration(cwd, "apply");
        expect(failed.status).not.toBe(0);
        expect(failed.stderr).toContain('"status":"error"');
        expectNoSecretLeak(failed);

        const ledger = await sql<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count
          FROM schema_migrations
        `;
        expect(ledger[0]?.count).toBe(44);

        const startupVerify = runMigration(cwd, "verify");
        expect(startupVerify.status).not.toBe(0);
        expect(startupVerify.stderr).toContain("migration ledger incomplete");
        expectNoSecretLeak(startupVerify);
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
    90_000,
  );

  it("exits non-zero without leaking the DATABASE_URL when schema apply fails", () => {
    const cwd = writeEnv(
      `postgresql://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:1/${TEST_DB_NAME}`,
    );

    const result = runApplySchema(cwd);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("[apply-schema] failed");
    expect(result.stderr).toMatch(/Error:|PostgresError:|AggregateError:/);
    expect(result.stderr).toContain("at ");
    expectNoSecretLeak(result);
  });

  it("uses Haniel pre_start and install config for fail-closed schema gating", () => {
    const yaml = readFileSync(YAML_PATH, "utf8");
    const parsed = parseYaml(yaml) as HanielSoulServerTsExample;
    const service = parsed.services["soul-server-ts"];
    const envConfig = parsed.install.configs["soul-server-ts-env"];

    expect(parsed.repos["soulstream-server-src"].release_manifest).toBe(
      "deploy/release-manifest-worker.json",
    );
    expect(service.hooks.pre_start).toBe(
      "node src/soulstream/soul-server-ts/scripts/verify-migrations.mjs",
    );
    expect(service.hooks.post_pull).not.toContain("apply-schema.mjs");
    expect(envConfig.keys.map((entry) => entry.key)).toContain("DATABASE_URL");
  });

  it("keeps standalone initialization separate from normal service starts", () => {
    const yaml = readFileSync(STANDALONE_YAML_PATH, "utf8");
    const parsed = parseYaml(yaml) as HanielStandaloneTemplate;
    const service = parsed.services["soul-server-ts"];
    const installer = readFileSync(INSTALLER_PATH, "utf8");

    expect(parsed.repos.soulstream.release_manifest).toBe(
      "deploy/release-manifest-standalone.json",
    );
    expect(service.ready).toBe("http://127.0.0.1:__PORT__/health");
    expect(service.hooks.pre_start).toBe(
      "node soul-server-ts/scripts/verify-migrations.mjs",
    );
    expect(service.hooks.pre_start).not.toContain("apply-schema.mjs");
    expect(installer).toContain("Push-Location $monoRepoDir");
    expect(installer).toContain(
      'node "packages/db-schema/scripts/migrate.mjs" initialize',
    );
    expect(installer).toContain(
      '$env:SOULSTREAM_RELEASE_ID = "standalone-install-$installHead"',
    );
    expect(installer).toContain('Get-PostgresToolMajorVersion "pg_dump"');
    expect(installer).toContain('Get-PostgresToolMajorVersion "pg_restore"');
    expect(installer).toContain("PostgreSQL client 16+ required");
    expect(installer.trimEnd()).toMatch(/exit 0$/);
    expect(installer).toContain("-AuthBearerToken is required in non-interactive mode");
    expect(
      installer.indexOf('node "packages/db-schema/scripts/migrate.mjs" initialize'),
    ).toBeLessThan(installer.indexOf('Write-Step "Starting Soulstream service..."'));
  });

  it("pins release migration execution to the eiaserinnys orch authority", () => {
    const fixture = parseYaml(readFileSync(EIASERINNYS_FIXTURE_PATH, "utf8")) as {
      services: Record<string, { cwd: string; repo: string; hooks?: { pre_start?: string } }>;
    };
    const manifest = JSON.parse(readFileSync(
      fileURLToPath(new URL("../../../deploy/release-manifest.json", import.meta.url)),
      "utf8",
    ));

    expect(Object.keys(fixture.services)).toEqual([
      "soulstream-orch-server",
      "soulstream-soul-server-ts",
    ]);
    expect(fixture.services["soulstream-orch-server"].cwd).toBe("./services/soulstream");
    expect(fixture.services["soulstream-orch-server"].hooks?.pre_start).toContain(
      "verify-migrations.mjs",
    );
    expect(manifest.environment_service).toBe("soulstream-orch-server");
    expect(manifest.migration.apply.command).toBe(
      "node packages/db-schema/scripts/migrate.mjs apply",
    );
    expect(fixture.services["soulstream-soul-server-ts"].after).toEqual([
      "soulstream-orch-server",
    ]);
  });
});

function hasDockerBinary(): boolean {
  const result = spawnSync("docker", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

interface HanielSoulServerTsExample {
  repos: {
    "soulstream-server-src": {
      release_manifest: string;
    };
  };
  services: {
    "soul-server-ts": {
      hooks: {
        post_pull: string;
        pre_start: string;
      };
    };
  };
  install: {
    configs: {
      "soul-server-ts-env": {
        keys: Array<{ key: string }>;
      };
    };
  };
}

interface HanielStandaloneTemplate {
  repos: { soulstream: { release_manifest: string } };
  services: {
    "soul-server-ts": {
      ready: string;
      hooks: { pre_start: string };
    };
  };
}

function runApplySchema(cwd: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd,
    encoding: "utf8",
    env: minimalEnv(),
    timeout: 15_000,
  });
}

function runMigration(cwd: string, mode: "apply" | "verify") {
  return spawnSync(process.execPath, [MIGRATION_SCRIPT_PATH, mode], {
    cwd,
    encoding: "utf8",
    env: minimalEnv(),
    timeout: 30_000,
  });
}

async function runMigrationAsync(
  cwd: string,
  mode: "apply" | "verify",
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MIGRATION_SCRIPT_PATH, mode], {
      cwd,
      env: minimalEnv(),
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`migration ${mode} timed out`));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

async function resetToPreRuntimeMigrationState(
  sql: ReturnType<typeof postgres>,
): Promise<void> {
  await sql`
    DELETE FROM schema_migrations
    WHERE ordinal >= 45
  `;
  await sql.unsafe(`
    DROP TABLE IF EXISTS session_delivery_relation_consumptions CASCADE;
    DROP TABLE IF EXISTS claude_background_tasks CASCADE;
    DROP TABLE IF EXISTS session_delivery_notification_outbox CASCADE;
    DROP TABLE IF EXISTS session_deliveries CASCADE;
  `);
}

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
}

function writeEnv(databaseUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "soul-apply-schema-"));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, ".env.soul-server-ts"),
    `DATABASE_URL=${databaseUrl}\nSOULSTREAM_RELEASE_ID=fresh-install-test\n`,
    "utf8",
  );
  return dir;
}

async function startPostgres(): Promise<{ url: string }> {
  const containerId = execFileSync("docker", [
    "run",
    "--rm",
    "-d",
    "-e",
    `POSTGRES_USER=${TEST_USER}`,
    "-e",
    `POSTGRES_PASSWORD=${TEST_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${TEST_DB_NAME}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ], { encoding: "utf8" }).trim();
  containers.push(containerId);

  const port = dockerMappedPort(containerId);
  const url = `postgres://${TEST_USER}:${TEST_PASSWORD}@127.0.0.1:${port}/${TEST_DB_NAME}`;
  const sql = postgres(url, { max: 1, idle_timeout: 1 });
  try {
    await waitForPostgres(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return { url };
}

function dockerMappedPort(containerId: string): string {
  for (let i = 0; i < 30; i += 1) {
    const output = execFileSync("docker", ["port", containerId, "5432/tcp"], {
      encoding: "utf8",
    }).trim();
    const match = output.match(/:(\d+)$/);
    if (match) return match[1];
  }
  throw new Error("docker did not publish a PostgreSQL port");
}

async function waitForPostgres(sql: ReturnType<typeof postgres>): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function expectNoSecretLeak(result: { stdout: string; stderr: string }) {
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output).not.toContain(TEST_PASSWORD);
  expect(output).not.toContain(`${TEST_USER}:${TEST_PASSWORD}`);
  expect(output).not.toContain("DATABASE_URL=");
}

function columnNames(
  rows: Array<{ table_name: string; column_name: string }>,
  tableName: string,
): string[] {
  return rows
    .filter((row) => row.table_name === tableName)
    .map((row) => row.column_name);
}
