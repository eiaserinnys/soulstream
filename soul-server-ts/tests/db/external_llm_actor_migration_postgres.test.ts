import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("049 external LLM actor migration PostgreSQL", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("preserves existing custom views and backfills their actor provenance", async () => {
    await harness.sql`
      INSERT INTO folders (id, name, sort_order)
      VALUES ('folder-migration', 'Migration', 1)
    `;
    await harness.sql`
      INSERT INTO sessions (session_id, node_id, status, session_type, folder_id)
      VALUES ('sess-migration', 'node-test', 'completed', 'codex', 'folder-migration')
    `;
    await harness.sql`
      INSERT INTO board_items (
        id, folder_id, container_kind, container_id,
        membership_kind, item_type, item_id
      ) VALUES
        (
          'item-view-agent', 'folder-migration', 'folder', 'folder-migration',
          'primary', 'custom_view', 'view-agent'
        ),
        (
          'item-view-system', 'folder-migration', 'folder', 'folder-migration',
          'primary', 'custom_view', 'view-system'
        )
    `;
    await harness.sql`
      INSERT INTO board_custom_views (
        id, board_item_id, title, html,
        created_actor_kind, created_session_id,
        updated_actor_kind, updated_session_id
      ) VALUES
        (
          'view-agent', 'item-view-agent', 'Agent view', '<p>agent</p>',
          'agent', 'sess-migration', 'agent', 'sess-migration'
        ),
        (
          'view-system', 'item-view-system', 'System view', '<p>system</p>',
          'system', NULL, 'system', NULL
        )
    `;

    await harness.sql.unsafe(`
      ALTER TABLE tasks
        DROP CONSTRAINT tasks_completed_kind_check,
        ADD CONSTRAINT tasks_completed_kind_check
          CHECK (completed_kind IN ('agent','user'));
      ALTER TABLE task_items
        DROP CONSTRAINT task_items_completed_kind_check,
        ADD CONSTRAINT task_items_completed_kind_check
          CHECK (completed_kind IN ('agent','user'));
      ALTER TABLE task_operations
        DROP CONSTRAINT task_operations_actor_kind_check,
        ADD CONSTRAINT task_operations_actor_kind_check
          CHECK (actor_kind IN ('agent','user','system'));
      ALTER TABLE folder_project_operations
        DROP CONSTRAINT folder_project_operations_actor_kind_check,
        ADD CONSTRAINT folder_project_operations_actor_kind_check
          CHECK (actor_kind IN ('agent','user','system'));
      ALTER TABLE checklist_task_projection_outbox
        DROP CONSTRAINT checklist_task_projection_outbox_actor_kind_check,
        ADD CONSTRAINT checklist_task_projection_outbox_actor_kind_check
          CHECK (actor_kind IN ('agent','user','system'));
      ALTER TABLE checklist_task_projection_outbox
        DROP CONSTRAINT checklist_task_projection_outbox_actor_shape_check,
        ADD CONSTRAINT checklist_task_projection_outbox_actor_shape_check
          CHECK (
            (actor_kind = 'agent' AND actor_session_id IS NOT NULL AND actor_user_id IS NULL)
            OR (actor_kind = 'user' AND actor_user_id IS NOT NULL)
            OR (actor_kind = 'system' AND actor_user_id IS NULL)
          );
      ALTER TABLE block_operations
        DROP CONSTRAINT block_operations_actor_kind_check,
        ADD CONSTRAINT block_operations_actor_kind_check
          CHECK (actor_kind IN ('agent','user','system'));
      ALTER TABLE board_custom_views
        DROP COLUMN created_actor_kind,
        DROP COLUMN updated_actor_kind
    `);
    const migrationSql = readFileSync(
      fileURLToPath(
        new URL(
          "../../../packages/db-schema/sql/migrations/049_external_llm_actor.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    await harness.sql.unsafe(migrationSql);

    const rows = await harness.sql<Array<{
      id: string;
      created_actor_kind: string;
      updated_actor_kind: string;
    }>>`
      SELECT id, created_actor_kind, updated_actor_kind
      FROM board_custom_views
      ORDER BY id
    `;
    expect(rows).toEqual([
      {
        id: "view-agent",
        created_actor_kind: "agent",
        updated_actor_kind: "agent",
      },
      {
        id: "view-system",
        created_actor_kind: "system",
        updated_actor_kind: "system",
      },
    ]);

    await expect(harness.sql`
      INSERT INTO task_operations (
        id, target_kind, target_id, operation_type,
        actor_kind, actor_session_id, actor_user_id
      ) VALUES (
        'op-llm-migration', 'task', 'task-external',
        'external_write', 'llm', NULL, NULL
      )
    `).resolves.toBeDefined();
  });

  it("drops a differently named legacy CHECK instead of failing on it", async () => {
    // 042 renamed runbook_* to task_* and PostgreSQL kept the original
    // constraint names, so live carries runbooks_completed_kind_check on
    // tasks. The name-keyed DROP in the migration never matched it and the
    // survivor kept rejecting llm — this reproduces that exact shape.
    await harness.sql.unsafe(`
      ALTER TABLE tasks
        ADD CONSTRAINT runbooks_completed_kind_check
        CHECK (completed_kind IN ('agent','user'))
    `);

    const migrationSql = readFileSync(
      fileURLToPath(
        new URL(
          "../../../packages/db-schema/sql/migrations/049_external_llm_actor.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    await expect(harness.sql.unsafe(migrationSql)).resolves.toBeDefined();

    const survivors = await harness.sql`
      SELECT con.conname
      FROM pg_constraint con
      WHERE con.conrelid = to_regclass('tasks')
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) LIKE '%completed_kind%'
        AND pg_get_constraintdef(con.oid) NOT LIKE '%''llm''%'
    `;
    expect(survivors).toHaveLength(0);

    await expect(harness.sql`
      INSERT INTO tasks (id, title, status, completed_kind)
      VALUES ('task-legacy-swept', 'legacy swept', 'completed', 'llm')
    `).resolves.toBeDefined();
  });

  it("still fails explicitly when an llm-hostile CHECK is unreachable by the sweep", async () => {
    // The sweep and the guard share one predicate, so the guard is normally
    // unreachable. It stays as the backstop for shapes the sweep cannot see —
    // here a constraint added *after* the sweep would have run.
    await harness.sql.unsafe(`
      ALTER TABLE tasks
        ADD CONSTRAINT tasks_completed_kind_legacy_check
        CHECK (completed_kind = ANY (ARRAY['agent','user']))
    `);

    const guardOnly = readFileSync(
      fileURLToPath(
        new URL(
          "../../../packages/db-schema/sql/migrations/049_external_llm_actor.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    ).split("-- Fail the migration if a differently named legacy CHECK survived a")[1];

    await expect(
      harness.sql.unsafe(`-- guard\n${guardOnly}`),
    ).rejects.toThrow("left a legacy CHECK on tasks.completed_kind that rejects llm");

    await harness.sql.unsafe(`
      ALTER TABLE tasks
        DROP CONSTRAINT tasks_completed_kind_legacy_check
    `);
  });
});
