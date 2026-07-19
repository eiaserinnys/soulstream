import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateBackupArchive } from "../../../packages/db-schema/scripts/backup.mjs";
import {
  assertLegacyBackupResolved,
  buildMigrationPlan,
  classifySchemaState,
  deploymentEnvironmentPath,
  loadLegacyBackupContract,
  loadMigrationManifest,
  legacyRetirementPending,
  migrationSha256,
  validateBackupGate,
  validateLedger,
} from "../../../packages/db-schema/scripts/migration-contract.mjs";

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
};

describe("versioned migration contract", () => {
  it("uses the same migration checksum after a Windows CRLF checkout", () => {
    const lf = "SELECT 1;\nSELECT 2;\n";
    const crlf = lf.replaceAll("\n", "\r\n");

    expect(migrationSha256(crlf)).toBe(migrationSha256(lf));
  });

  it("keeps deployment-specific service keys and destructive restore out of the manifest", () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(
      new URL("../../../deploy/release-manifest.json", import.meta.url),
    ), "utf8"));

    expect(manifest).not.toHaveProperty("environment_service");
    expect(manifest.recovery).not.toHaveProperty("fallback");
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

  it("loads the full-filename manifest in deterministic order with verified checksums", async () => {
    const migrations = await loadMigrationManifest();

    expect(migrations).toHaveLength(44);
    expect(migrations[0].id).toBe("001_list_sessions_folder_node_filter.sql");
    expect(migrations.at(-1)?.id).toBe("042_runbook_to_task.sql");
    expect(migrations.map((item) => item.id)).toEqual(
      [...migrations.map((item) => item.id)].sort(),
    );
    expect(migrations.filter((item) => item.destructive).map((item) => item.id)).toEqual([
      "041_retire_task_tree.sql",
      "042_runbook_to_task.sql",
    ]);
  });

  it("bootstraps an already-current database without scheduling DROP or rename", async () => {
    const migrations = await loadMigrationManifest();
    const plan = buildMigrationPlan(migrations, [], current);

    expect(plan.state).toBe("current");
    expect(plan.bootstrap).toHaveLength(44);
    expect(plan.pending).toEqual([]);
  });

  it("schedules only 041 and 042 for the pre-retirement physical state", async () => {
    const migrations = await loadMigrationManifest();
    const plan = buildMigrationPlan(migrations, [], legacyPre041);

    expect(plan.bootstrap.at(-1)?.id).toBe("040_session_predecessor.sql");
    expect(plan.pending.map((item) => item.id)).toEqual([
      "041_retire_task_tree.sql",
      "042_runbook_to_task.sql",
    ]);
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

  it("keeps the 589 versus 592 evidence gap as an explicit destructive blocker", async () => {
    const contract = await loadLegacyBackupContract();

    expect(contract).toMatchObject({
      status: "unresolved",
      stored_operation_count: 589,
      observed_pre_drop_operation_count: 592,
      missing_operation_count: 3,
    });
    expect(() => assertLegacyBackupResolved(contract)).toThrow(
      "stored=589, observed=592, missing=3",
    );
    expect(legacyRetirementPending({
      pending: [{ id: "043_future_destructive.sql", destructive: true }],
    })).toBe(false);
  });

  it("accepts only a verified backup for the same release and target commit", () => {
    const gate = {
      schema_version: "soulstream.database-backup.v1",
      status: "verified",
      release_id: "release-1",
      target_head: "abc123",
      dump_sha256: "a".repeat(64),
      destructive_pending: ["041_retire_task_tree.sql"],
    };
    const env = { HANIEL_RELEASE_ID: "release-1", HANIEL_TARGET_HEAD: "abc123" };

    expect(validateBackupGate(gate, env, ["041_retire_task_tree.sql"])).toBe(gate);
    expect(() => validateBackupGate({ ...gate, target_head: "wrong" }, env)).toThrow(
      "target commit differs",
    );
    expect(() => validateBackupGate(gate, env, ["042_runbook_to_task.sql"])).toThrow(
      "migration plan differs",
    );
  });

  it("rejects a changed dump and a non-restorable archive listing", () => {
    const bytes = Buffer.from("database backup");
    const metadata = {
      dump_sha256: "8e0a5e1ba54ac547e1202e11dec2ecb425a3a5f4194353aab6261ebf5c268d95",
    };
    const toc = Array.from({ length: 10 }, (_, index) => (
      `${index + 1}; 0 0 TABLE public table_${index} owner`
    )).join("\n");

    expect(() => validateBackupArchive(metadata, bytes, toc)).not.toThrow();
    expect(() => validateBackupArchive(metadata, Buffer.from("changed"), toc)).toThrow(
      "checksum differs",
    );
    expect(() => validateBackupArchive(metadata, bytes, "; no entries")).toThrow(
      "credible database archive",
    );
  });
});
