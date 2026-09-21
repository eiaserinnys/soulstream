import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildMigrationPlan,
  classifySchemaState,
  deploymentEnvironmentPath,
  loadMigrationManifest,
  migrationSha256,
  validateLedger,
  readDatabaseUrl,
  releaseServiceEnvironmentPath,
} from "../../../packages/db-schema/scripts/migration-contract.mjs";
import {
  formatMigrationError,
} from "../../../packages/db-schema/scripts/migrate.mjs";

const empty = {
  sessions: null,
  tasks: null,
  taskSections: null,
  runbooks: null,
  runbookItems: null,
  taskItems: null,
  taskOperations: null,
  runbookOperations: null,
  taskItemsHasParent: false,
  taskItemsHasSection: false,
  deliveryAttemptTerminologyCurrent: false,
};

const current = {
  sessions: "r",
  tasks: "r",
  taskSections: "r",
  runbooks: "v",
  runbookItems: "v",
  taskItems: "r",
  taskOperations: "r",
  runbookOperations: "v",
  taskItemsHasParent: false,
  taskItemsHasSection: true,
  deliveryAttemptTerminologyCurrent: true,
};

const currentPre086 = {
  ...current,
  deliveryAttemptTerminologyCurrent: false,
};

const legacyPre041 = {
  sessions: "r",
  tasks: null,
  taskSections: null,
  runbooks: "r",
  runbookItems: "r",
  taskItems: "r",
  taskOperations: "r",
  runbookOperations: "r",
  taskItemsHasParent: true,
  taskItemsHasSection: false,
  deliveryAttemptTerminologyCurrent: false,
};

describe("versioned migration contract", () => {
  it("uses the same migration checksum after a Windows CRLF checkout", () => {
    const lf = "SELECT 1;\nSELECT 2;\n";
    const crlf = lf.replaceAll("\n", "\r\n");

    expect(migrationSha256(crlf)).toBe(migrationSha256(lf));
  });

  it("keeps the central manifest free of removed migration policy fields", () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(
      new URL("../../../deploy/release-manifest.json", import.meta.url),
    ), "utf8"));

    expect(manifest.environment_service).toBe("soulstream-orch-server");
    expect(manifest.migration).not.toHaveProperty("destructive");
    expect(manifest.migration).not.toHaveProperty("backup");
    expect(manifest.migration).not.toHaveProperty("verify_backup");
    expect(manifest.migration).toMatchObject({
      operation: "discover",
      result_contract: "soulstream.database-release.v1",
      provenance_probe: {
        prepare: expect.objectContaining({
          name: "prepare-database-release-probe",
          command: expect.stringContaining("--ignore-scripts"),
        }),
        probe: expect.objectContaining({
          command: expect.stringContaining("release-executor.mjs probe"),
        }),
      },
    });
    expect(manifest.recovery.command).toMatchObject({
      name: "recover-database-release",
      command: expect.stringContaining("release-executor.mjs recover"),
    });
  });

  it("keeps worker deployments database-free and standalone migration-authoritative", () => {
    const worker = JSON.parse(readFileSync(fileURLToPath(
      new URL("../../../deploy/release-manifest-worker.json", import.meta.url),
    ), "utf8"));
    const standalone = JSON.parse(readFileSync(fileURLToPath(
      new URL("../../../deploy/release-manifest-standalone.json", import.meta.url),
    ), "utf8"));
    const cluster = JSON.parse(readFileSync(fileURLToPath(
      new URL("../../../deploy/release-manifest.json", import.meta.url),
    ), "utf8"));
    const standaloneContract = JSON.parse(readFileSync(fileURLToPath(
      new URL("../../../deploy/database-release-standalone.json", import.meta.url),
    ), "utf8"));
    const centralContract = JSON.parse(readFileSync(fileURLToPath(
      new URL("../../../deploy/database-release-central.json", import.meta.url),
    ), "utf8"));

    expect(worker).not.toHaveProperty("environment_service");
    expect(worker).not.toHaveProperty("migration");
    expect(worker.post_start_verify).toEqual([{
      name: "verify-release-health",
      command: "node soul-server-ts/scripts/verify-release-health.mjs --scope cluster",
      timeout_seconds: 300,
    }]);
    expect(JSON.stringify(worker)).not.toMatch(/migrate|backup|DATABASE_URL/);

    expect(standalone.environment_service).toBe("soul-server-ts");
    expect(standalone.migration).toMatchObject({
      operation: "discover",
      result_contract: "soulstream.database-release.v1",
      preflight: {
        command: expect.stringContaining("--manifest deploy/release-manifest-standalone.json"),
      },
      apply: {
        name: "apply-migrations",
        command: "node packages/db-schema/scripts/release-executor.mjs apply "
          + "--manifest deploy/release-manifest-standalone.json "
          + "--database-contract deploy/database-release-standalone.json",
        timeout_seconds: 300,
      },
    });
    expect(standalone.migration).not.toHaveProperty("destructive");
    expect(standalone.migration).not.toHaveProperty("backup");
    expect(standalone.migration).not.toHaveProperty("verify_backup");
    expect(standaloneContract).toEqual({
      schema_version: "soulstream.database-release-manifest.v1",
      writer_services: ["soul-server-ts"],
      required_subphases: [],
    });
    expect(centralContract).toEqual({
      schema_version: "soulstream.database-release-manifest.v1",
      writer_services: ["soulstream-orch-server", "soulstream-soul-server-ts"],
      required_subphases: ["board_yjs_runbook_residue"],
    });
    expect(standalone.post_start_verify).toEqual(
      cluster.post_start_verify.slice(0, -1).map((command: { name: string }) => (
        command.name === "verify-release-health"
          ? { ...command, command: "node soul-server-ts/scripts/verify-release-health.mjs --scope standalone" }
          : command.name === "verify-migration-ledger"
            ? {
              ...command,
              command: "node packages/db-schema/scripts/release-executor.mjs verify "
                + "--manifest deploy/release-manifest-standalone.json "
                + "--database-contract deploy/database-release-standalone.json",
            }
          : command
      )),
    );
    expect(cluster.post_start_verify.at(-1)).toEqual({
      name: "verify-board-yjs-runbook-residue",
      command: "node orch-server-ts/node_modules/tsx/dist/cli.mjs "
        + "orch-server-ts/scripts/deploy-board-yjs-runbook-residue.ts --verify",
      timeout_seconds: 300,
    });
  });
  it("loads release settings from the declared Haniel service cwd", () => {
    expect(deploymentEnvironmentPath(
      { HANIEL_SERVICE_CWD: "/service-root" },
      "/repo-root",
    )).toBe(resolve("/service-root/.env.soul-server-ts"));
    expect(deploymentEnvironmentPath({}, "/repo-root")).toBe(
      resolve("/repo-root/.env.soul-server-ts"),
    );
  });

  it("prefers the migration credential so runtime roles need no DDL grant", () => {
    const runtime = "postgres://runtime@127.0.0.1:5432/soulstream";
    const migration = "postgres://admin@127.0.0.1:5432/soulstream?options=-c%20role%3Downer";

    expect(readDatabaseUrl({ DATABASE_URL: runtime })).toBe(runtime);
    expect(readDatabaseUrl({
      DATABASE_URL: runtime,
      MIGRATION_DATABASE_URL: migration,
    })).toBe(migration);
    // 비어 있거나 공백뿐이면 주지 않은 것으로 본다 — 기존 trim 규칙 그대로다.
    expect(readDatabaseUrl({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: "" })).toBe(runtime);
    expect(readDatabaseUrl({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: "   " }))
      .toBe(runtime);
    expect(() => readDatabaseUrl({})).toThrow("DATABASE_URL is required");
    expect(() => readDatabaseUrl({ MIGRATION_DATABASE_URL: "not-a-url" }))
      .toThrow("must be postgres:// or postgresql://");
  });

  it("hides both connection strings from a failed migration report", () => {
    // 마이그레이션 자격증명은 런타임보다 권한이 높을 수 있다. 실패 로그에
    // 평문으로 남으면 그 한 번으로 새어 나간다.
    const runtime = "postgres://runtime:pw@127.0.0.1:5432/soulstream";
    const migration = "postgres://admin:secret@127.0.0.1:5432/soulstream?options=-c%20role%3Downer";
    const env = { DATABASE_URL: runtime, MIGRATION_DATABASE_URL: migration };

    const text = formatMigrationError(
      new Error(`connect failed for ${migration} falling back to ${runtime}`),
      env,
    );

    expect(text).not.toContain("secret");
    expect(text).not.toContain(migration);
    expect(text).not.toContain(runtime);
    expect(text).toContain("[redacted MIGRATION_DATABASE_URL]");
    expect(text).toContain("[redacted DATABASE_URL]");
  });

  it("reads the release env snapshot Haniel hands over for migration tooling", () => {
    const snapshot = "/tmp/haniel-release-env-x/service.env";

    expect(releaseServiceEnvironmentPath({ HANIEL_SERVICE_ENV_FILE: snapshot }, "/repo-root"))
      .toBe(resolve(snapshot));

    // 서비스 cwd 가 함께 와도 스냅샷이 이긴다.
    expect(releaseServiceEnvironmentPath(
      { HANIEL_SERVICE_CWD: "/service-root", HANIEL_SERVICE_ENV_FILE: snapshot },
      "/repo-root",
    )).toBe(resolve(snapshot));

    // 넘어오지 않거나 공백뿐이면 워커 경로로 돌아간다.
    expect(releaseServiceEnvironmentPath({ HANIEL_SERVICE_ENV_FILE: "   " }, "/repo-root"))
      .toBe(resolve("/repo-root/.env.soul-server-ts"));
    expect(releaseServiceEnvironmentPath({ HANIEL_SERVICE_CWD: "/service-root" }, "/repo-root"))
      .toBe(resolve("/service-root/.env.soul-server-ts"));
  });

  it("keeps the worker env path blind to whichever service is being released", () => {
    // 회귀 가드. 이 함수가 스냅샷을 보게 되면 release health 가 orch 를 배포하는
    // 동안 orch 의 env 를 워커 것인 양 읽어 MCP_ENABLED 를 잃고
    // HOST/PORT/AUTH_BEARER_TOKEN 까지 orch 값으로 덮인다.
    expect(deploymentEnvironmentPath(
      {
        HANIEL_SERVICE_CWD: "/service-root",
        HANIEL_SERVICE_ENV_FILE: "/tmp/haniel-release-env-x/service.env",
      },
      "/repo-root",
    )).toBe(resolve("/service-root/.env.soul-server-ts"));

    expect(deploymentEnvironmentPath(
      { HANIEL_SERVICE_ENV_FILE: "/tmp/haniel-release-env-x/service.env" },
      "/repo-root",
    )).toBe(resolve("/repo-root/.env.soul-server-ts"));
  });

  it("loads the full-filename manifest in deterministic order with verified checksums", async () => {
    const migrations = await loadMigrationManifest();

    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations[0].id).toBe("001_list_sessions_folder_node_filter.sql");
    expect(migrations.at(-1)?.ordinal).toBe(migrations.length);
    expect(migrations.map((item) => item.id)).toEqual(
      [...migrations.map((item) => item.id)].sort(),
    );
    expect(migrations.every((item) => !Object.hasOwn(item, "destructive"))).toBe(true);
    expect(migrations.every((item) => !Object.hasOwn(item, "rollback_compatibility"))).toBe(true);
  });

  it("keeps terminal status and execution registration on the sessions-row canon", async () => {
    const migrations = await loadMigrationManifest();
    const addMigration = migrations.find((item) =>
      item.id === "085a_execution_registration_projection.sql"
    );
    const dropMigration = migrations.find((item) =>
      item.id === "085b_execution_ownership_projection_drop.sql"
    );
    const schema = readFileSync(fileURLToPath(
      new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url),
    ), "utf8");

    expect(addMigration?.sql).toContain("session_record_execution_registration(");
    expect(addMigration?.sql).toContain("execution_registration_id = NULL");
    expect(dropMigration?.sql).toContain(
      "DROP VIEW IF EXISTS session_owner_null_running_inventory",
    );
    expect(dropMigration?.sql.match(/DROP FUNCTION IF EXISTS/g)).toHaveLength(19);
    expect(schema).toContain("session_record_execution_registration(");
    expect(schema).toContain("execution_registration_id = NULL");
    expect(schema).not.toContain("session_execution_ownerships");
    expect(schema).not.toContain("session_release_execution_ownership(");
  });

  it("retires the consumed-projection trigger with a drop-only migration", async () => {
    const migration = (await loadMigrationManifest()).find((item) =>
      item.id === "087_delivery_notification_lock_order.sql"
    );
    const schema = readFileSync(fileURLToPath(
      new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url),
    ), "utf8");

    expect(migration?.sql).toContain(
      "DROP TRIGGER IF EXISTS trg_session_discard_notification_projection",
    );
    expect(migration?.sql).toContain(
      "DROP FUNCTION IF EXISTS session_discard_notification_projection_on_consumed()",
    );
    expect(migration?.sql).not.toMatch(/\b(?:CREATE|INSERT|UPDATE|DELETE|ALTER)\b/i);
    expect(schema).not.toContain("trg_session_discard_notification_projection");
    expect(schema).not.toContain("session_discard_notification_projection_on_consumed");
  });

  it("keeps source task item references relational and removes the legacy duplicate FK", async () => {
    const migration = (await loadMigrationManifest()).find((item) =>
      item.id === "057_source_task_item_integrity.sql"
    );
    const schema = readFileSync(fileURLToPath(
      new URL("../../../packages/db-schema/sql/schema.sql", import.meta.url),
    ), "utf8");

    expect(migration?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS board_items_source_runbook_item_id_fkey",
    );
    expect(migration?.sql).toContain(
      "ADD CONSTRAINT session_page_bindings_source_task_item_id_fkey",
    );
    expect(migration?.sql).toContain(
      "FOREIGN KEY (source_task_item_id) REFERENCES task_items(id) ON DELETE SET NULL",
    );
    expect(migration?.sql).not.toMatch(/SIMILAR TO|source_task_item_id\s*~/);
    expect(schema).toContain(
      "DROP CONSTRAINT IF EXISTS board_items_source_runbook_item_id_fkey",
    );
    expect(schema).toContain(
      "ADD CONSTRAINT session_page_bindings_source_task_item_id_fkey",
    );
  });

  it("requires canonical board-card removal before a session row can be deleted", async () => {
    const migration = (await loadMigrationManifest()).find((item) =>
      item.id === "058_session_delete_ydoc_guard.sql"
    );

    expect(migration?.sql).toContain("BEFORE DELETE ON sessions");
    expect(migration?.sql).toContain("FROM board_yjs_catalog_cache cache");
    expect(migration?.sql).not.toContain("DELETE FROM board_items");
    expect(migration?.sql).not.toContain("DROP FUNCTION IF EXISTS board_delete_session_refs");
    expect(migration?.sql).not.toContain("DROP TRIGGER IF EXISTS board_delete_session_refs_trigger");
  });

  it("bootstraps an already-current delivery-attempt schema through 086", async () => {
    const migrations = await loadMigrationManifest();
    const plan = buildMigrationPlan(migrations, [], current);
    const currentBaselineIndex = migrations.findIndex(
      (item) => item.id === "086_delivery_attempt_terminology.sql",
    );

    expect(plan.state).toBe("current");
    expect(currentBaselineIndex).toBeGreaterThanOrEqual(0);
    expect(plan.bootstrap).toHaveLength(currentBaselineIndex + 1);
    expect(plan.pending.map((item) => item.id)).toEqual(
      migrations.slice(currentBaselineIndex + 1).map((item) => item.id),
    );
  });

  it("replays post-042 migrations for a current pre-086 delivery schema", async () => {
    const migrations = await loadMigrationManifest();
    const plan = buildMigrationPlan(migrations, [], currentPre086);
    const taskBaselineIndex = migrations.findIndex(
      (item) => item.id === "042_runbook_to_task.sql",
    );

    expect(plan.state).toBe("current");
    expect(plan.bootstrap).toHaveLength(taskBaselineIndex + 1);
    expect(plan.pending.map((item) => item.id)).toEqual(
      migrations.slice(taskBaselineIndex + 1).map((item) => item.id),
    );
  });

  it("schedules only 041 and 042 for the pre-retirement physical state", async () => {
    const migrations = await loadMigrationManifest();
    const plan = buildMigrationPlan(migrations, [], legacyPre041);
    const retirementIndex = migrations.findIndex(
      (item) => item.id === "041_retire_task_tree.sql",
    );

    expect(retirementIndex).toBeGreaterThanOrEqual(0);
    expect(plan.bootstrap.at(-1)?.id).toBe("040_session_predecessor.sql");
    expect(plan.pending.map((item) => item.id)).toEqual(
      migrations.slice(retirementIndex).map((item) => item.id),
    );
  });

  it("rejects ambiguous physical schema and applied checksum drift", async () => {
    const migrations = await loadMigrationManifest();
    expect(() => classifySchemaState({ ...empty, sessions: "r" })).toThrow(
      "ambiguous database schema state",
    );
    expect(() => validateLedger(migrations, [{
      migration_id: migrations[0].id,
      checksum: "0".repeat(64),
      ordinal: 1,
    }])).toThrow("applied migration checksum differs");

    const partial = migrations.slice(0, 1).map((migration) => ({
      migration_id: migration.id,
      checksum: migration.sha256,
      ordinal: migration.ordinal,
    }));
    expect(() => buildMigrationPlan(migrations, partial, current)).toThrow(
      "partial pre-baseline migration ledger is not a supported state",
    );
    expect(() => buildMigrationPlan(migrations, partial, legacyPre041)).toThrow(
      "partial pre-baseline migration ledger is not a supported state",
    );
  });

});
