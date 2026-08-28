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
  rollbackUnsafePending,
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

  it("enforces CENTRAL_NO_INLINE_MIGRATION_MUST_BE_NON_DESTRUCTIVE for the central manifest", () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(
      new URL("../../../deploy/release-manifest.json", import.meta.url),
    ), "utf8"));

    expect(manifest.environment_service).toBe("soulstream-orch-server");
    expect(
      manifest.migration.destructive,
      "CENTRAL_NO_INLINE_MIGRATION_MUST_BE_NON_DESTRUCTIVE: "
        + "central migration has no inline backup owner and must declare destructive=false",
    ).toBe(false);
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
      destructive: true,
      operation: "discover",
      result_contract: "soulstream.database-release.v1",
      preflight: {
        command: expect.stringContaining("--manifest deploy/release-manifest-standalone.json"),
      },
      backup: {
        command: expect.stringContaining("--manifest deploy/release-manifest-standalone.json"),
      },
      verify_backup: {
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

  it("loads the full-filename manifest in deterministic order with verified checksums", async () => {
    const migrations = await loadMigrationManifest();

    expect(migrations).toHaveLength(78);
    expect(migrations[0].id).toBe("001_list_sessions_folder_node_filter.sql");
    expect(migrations.at(-1)?.id).toBe(
      "077_ownerless_terminal_stale_event_cas.sql",
    );
    expect(migrations.map((item) => item.id)).toEqual(
      [...migrations.map((item) => item.id)].sort(),
    );
    expect(migrations.filter((item) => item.destructive).map((item) => item.id)).toEqual([
      "041_retire_task_tree.sql",
      "042_runbook_to_task.sql",
      "053_retire_supervisor.sql",
    ]);
    expect(migrations.slice(0, -36).every(
      (item) => item.rollback_compatibility === "bootstrap_only",
    )).toBe(true);
    expect(migrations.slice(-36).map((item) => item.rollback_compatibility)).toEqual([
      "restore_required",
      "restore_required",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "restore_required",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "restore_required",
      "restore_required",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "previous_release_safe",
      "restore_required",
      "previous_release_safe",
      "restore_required",
      "previous_release_safe",
      "previous_release_safe",
    ]);
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

    expect(migration?.rollback_compatibility).toBe("restore_required");
    expect(migration?.sql).toContain("BEFORE DELETE ON sessions");
    expect(migration?.sql).toContain("FROM board_yjs_catalog_cache cache");
    expect(migration?.sql).not.toContain("DELETE FROM board_items");
    expect(migration?.sql).not.toContain("DROP FUNCTION IF EXISTS board_delete_session_refs");
    expect(migration?.sql).not.toContain("DROP TRIGGER IF EXISTS board_delete_session_refs_trigger");
  });

  it("treats only explicit one-release compatibility as data-preserving rollback", () => {
    const plan = {
      pending: [
        {
          id: "043_expand.sql",
          destructive: false,
          rollback_compatibility: "previous_release_safe",
        },
        {
          id: "044_contract.sql",
          destructive: false,
          rollback_compatibility: "restore_required",
        },
      ],
    };

    expect(rollbackUnsafePending(plan).map((item) => item.id)).toEqual([
      "044_contract.sql",
    ]);
  });

  it("bootstraps an already-current database without scheduling DROP or rename", async () => {
    const migrations = await loadMigrationManifest();
    const plan = buildMigrationPlan(migrations, [], current);

    expect(plan.state).toBe("current");
    expect(plan.bootstrap).toHaveLength(44);
    expect(plan.pending.map((item) => item.id)).toEqual([
      "044_session_metadata_search.sql",
      "045_session_deliveries.sql",
      "046_claude_background_tasks.sql",
      "047_session_delivery_relation_consumptions.sql",
      "048_session_model_preset.sql",
      "049_external_llm_actor.sql",
      "050_session_id_search_indexed.sql",
      "051_session_digests.sql",
      "052_session_review_state_filter.sql",
      "053_retire_supervisor.sql",
      "054_event_ingress_receipts.sql",
      "055_session_effects_and_mutation_receipts.sql",
      "056_agent_profiles.sql",
      "057_source_task_item_integrity.sql",
      "058_session_delete_ydoc_guard.sql",
      "059_scope_board_seed_items.sql",
      "060_board_yjs_snapshot_revision.sql",
      "061_session_terminal_receipt.sql",
      "062_notification_outbox_hardening.sql",
      "063_session_rotate_claude_id.sql",
      "064_event_ingress_receipt_effect_encoding.sql",
      "065_completion_terminal_revision_fence.sql",
      "066_session_delivery_enqueue_sequence.sql",
      "067_execution_ownership_delivery_convergence.sql",
      "068_execution_owner_recovery_singleflight.sql",
      "069_execution_reservation_lease_60s.sql",
      "070_release_manifest_activation_receipts.sql",
      "071_execution_dead_owner_expiry.sql",
      "072_owner_null_backfill_identity_guard.sql",
      "073_sessions_execution_owner_v1.sql",
      "074_sessions_execution_owner_renew.sql",
      "075_sessions_execution_owner_release.sql",
      "076_ownerless_terminal_generation_cas.sql",
      "077_ownerless_terminal_stale_event_cas.sql",
    ]);
  });

  it("schedules only 041 and 042 for the pre-retirement physical state", async () => {
    const migrations = await loadMigrationManifest();
    const plan = buildMigrationPlan(migrations, [], legacyPre041);

    expect(plan.bootstrap.at(-1)?.id).toBe("040_session_predecessor.sql");
    expect(plan.pending.map((item) => item.id)).toEqual([
      "041_retire_task_tree.sql",
      "042_runbook_to_task.sql",
      "044_session_metadata_search.sql",
      "045_session_deliveries.sql",
      "046_claude_background_tasks.sql",
      "047_session_delivery_relation_consumptions.sql",
      "048_session_model_preset.sql",
      "049_external_llm_actor.sql",
      "050_session_id_search_indexed.sql",
      "051_session_digests.sql",
      "052_session_review_state_filter.sql",
      "053_retire_supervisor.sql",
      "054_event_ingress_receipts.sql",
      "055_session_effects_and_mutation_receipts.sql",
      "056_agent_profiles.sql",
      "057_source_task_item_integrity.sql",
      "058_session_delete_ydoc_guard.sql",
      "059_scope_board_seed_items.sql",
      "060_board_yjs_snapshot_revision.sql",
      "061_session_terminal_receipt.sql",
      "062_notification_outbox_hardening.sql",
      "063_session_rotate_claude_id.sql",
      "064_event_ingress_receipt_effect_encoding.sql",
      "065_completion_terminal_revision_fence.sql",
      "066_session_delivery_enqueue_sequence.sql",
      "067_execution_ownership_delivery_convergence.sql",
      "068_execution_owner_recovery_singleflight.sql",
      "069_execution_reservation_lease_60s.sql",
      "070_release_manifest_activation_receipts.sql",
      "071_execution_dead_owner_expiry.sql",
      "072_owner_null_backfill_identity_guard.sql",
      "073_sessions_execution_owner_v1.sql",
      "074_sessions_execution_owner_renew.sql",
      "075_sessions_execution_owner_release.sql",
      "076_ownerless_terminal_generation_cas.sql",
      "077_ownerless_terminal_stale_event_cas.sql",
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
      rollback_unsafe_pending: ["041_retire_task_tree.sql"],
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
