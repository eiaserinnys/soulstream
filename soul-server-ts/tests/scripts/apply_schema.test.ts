import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/apply-schema.mjs", import.meta.url));
const PAGE_MODEL_MIGRATION_PATH = fileURLToPath(new URL(
  "../../../packages/db-schema/sql/migrations/032_page_block_model.sql",
  import.meta.url,
));
const YAML_PATH = fileURLToPath(
  new URL("../../../install/haniel-soul-server-ts.example.yaml", import.meta.url),
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
  itWithDocker("applies schema idempotently to an already-applied database", async () => {
    const { url } = await startPostgres();
    const cwd = writeEnv(url);

    const first = runApplySchema(cwd);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("[apply-schema] schema applied");
    expectNoSecretLeak(first);

    await seedLegacyBoardItem(url);

    const second = runApplySchema(cwd);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("[apply-schema] schema applied");
    expectNoSecretLeak(second);

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
        board_yjs_cache_count: string | number;
      }>>`
        SELECT
          to_regclass('public.soulstream_node_heartbeats')::text AS heartbeat_table,
          to_regclass('public.claude_transcript_entries')::text AS transcript_table,
          (
            SELECT COUNT(*)::int
            FROM pg_proc
            WHERE proname = 'claude_transcript_append'
          ) AS transcript_function_count,
          (
            SELECT COUNT(*)::int
            FROM board_yjs_catalog_cache
            WHERE container_kind = 'folder'
              AND container_id = 'folder-schema'
          ) AS board_yjs_cache_count
      `;

      expect(rows[0]).toMatchObject({
        heartbeat_table: "soulstream_node_heartbeats",
        transcript_table: "claude_transcript_entries",
        transcript_function_count: 1,
        board_yjs_cache_count: 1,
      });
      const cacheRows = await sql<Array<{
        board_items: Array<Record<string, unknown>>;
        markdown_documents: Array<Record<string, unknown>>;
      }>>`
        SELECT board_items, markdown_documents
        FROM board_yjs_catalog_cache
        WHERE container_kind = 'folder'
          AND container_id = 'folder-schema'
      `;
      expect(cacheRows[0].board_items).toEqual([
        expect.objectContaining({
          id: "markdown:doc-schema",
          folderId: "folder-schema",
          containerKind: "folder",
          containerId: "folder-schema",
          itemType: "markdown",
          itemId: "doc-schema",
          x: 10,
          y: 20,
          metadata: expect.objectContaining({ title: "Schema doc" }),
        }),
      ]);
      expect(cacheRows[0].markdown_documents).toEqual([
        expect.objectContaining({
          id: "doc-schema",
          title: "Schema doc",
          body: "body",
        }),
      ]);

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
        ALTER TABLE runbooks DROP CONSTRAINT runbooks_task_page_id_fkey;
        ALTER TABLE folders DROP CONSTRAINT folders_project_page_id_fkey;
        DROP TABLE checklist_runbook_projection_outbox;
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

    expect(service.hooks.pre_start).toBe(
      "node src/soulstream/soul-server-ts/scripts/apply-schema.mjs",
    );
    expect(service.hooks.post_pull).not.toContain("apply-schema.mjs");
    expect(envConfig.keys.map((entry) => entry.key)).toContain("DATABASE_URL");
  });
});

function hasDockerBinary(): boolean {
  const result = spawnSync("docker", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

interface HanielSoulServerTsExample {
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

function runApplySchema(cwd: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd,
    encoding: "utf8",
    env: minimalEnv(),
    timeout: 15_000,
  });
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
  writeFileSync(join(dir, ".env.soul-server-ts"), `DATABASE_URL=${databaseUrl}\n`, "utf8");
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

async function seedLegacyBoardItem(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, idle_timeout: 1 });
  try {
    await sql`
      INSERT INTO folders (id, name, sort_order)
      VALUES ('folder-schema', 'Schema folder', 0)
    `;
    await sql`
      INSERT INTO markdown_documents (id, title, body)
      VALUES ('doc-schema', 'Schema doc', 'body')
    `;
    await sql`
      INSERT INTO board_items (id, folder_id, item_type, item_id, x, y, metadata)
      VALUES (
        'markdown:doc-schema',
        'folder-schema',
        'markdown',
        'doc-schema',
        10,
        20,
        '{"title":"Schema doc"}'::jsonb
      )
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
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
