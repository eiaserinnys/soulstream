import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBackup,
  validateClusterWriteFence,
  verifyBackup,
} from "../../../packages/db-schema/scripts/backup.mjs";
import { assertPostgresBackupPrerequisites } from
  "../../../packages/db-schema/scripts/postgres-backup-tools.mjs";
import { preflightPendingMigrations } from
  "../../../packages/db-schema/scripts/migrate.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function backupEnvironment(directory: string) {
  return {
    DATABASE_URL: "postgresql://release:secret@127.0.0.1:5432/release_test",
    HANIEL_BACKUP_DIR: directory,
    HANIEL_TARGET_HEAD: "target-head",
    HANIEL_RELEASE_ID: "release-1",
  };
}

describe("pending destructive backup contract", () => {
  it("skips dump and restore tooling when the actual plan has no destructive pending", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-backup-skip-"));
    tempDirs.push(directory);
    const spawn = vi.fn();
    const planRead = vi.fn(async () => ({ state: "current", pending: [] }));

    const created = await createBackup({
      env: backupEnvironment(directory),
      spawn,
      planRead,
    });
    const verified = await verifyBackup({
      env: backupEnvironment(directory),
      spawn,
      planRead,
    });

    expect(created.status).toBe("not_required");
    expect(verified.status).toBe("verified_not_required");
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(directory, "database-backup.json"), "utf8")))
      .toMatchObject({ status: "verified_not_required", destructive_pending: [] });
  });

  it("does not inspect PostgreSQL CLI tools for a non-destructive pending plan", async () => {
    const backupPreflight = vi.fn();

    await preflightPendingMigrations(
      { pending: [{ id: "043_safe.sql", destructive: false }] },
      { backupPreflight },
    );

    expect(backupPreflight).not.toHaveBeenCalled();
  });

  it("checks PostgreSQL backup prerequisites for an actual destructive pending plan", async () => {
    const backupPreflight = vi.fn(async () => ({ restore_capability: "verified" }));

    await preflightPendingMigrations(
      { pending: [{ id: "043_destructive.sql", destructive: true }] },
      {
        env: backupEnvironment("C:/backup"),
        backupPreflight,
      },
    );

    expect(backupPreflight).toHaveBeenCalledWith(expect.objectContaining({
      databaseUrl: expect.stringContaining("release_test"),
    }));
  });

  it("fails before handover when pg_dump is absent on Windows", async () => {
    const missing = Object.assign(new Error("spawn pg_dump ENOENT"), { code: "ENOENT" });
    const spawn = vi.fn(() => ({ error: missing, status: null, stdout: "", stderr: "" }));

    await expect(assertPostgresBackupPrerequisites({
      databaseUrl: "postgresql://release:secret@127.0.0.1:5432/release_test",
      spawn,
      serverVersionRead: async () => 160014,
      restoreCapabilityRead: async () => ({ ok: true, reason: null }),
    })).rejects.toThrow("pg_dump is required");
  });

  it("fails before handover when pg_restore is absent on Windows", async () => {
    const missing = Object.assign(new Error("spawn pg_restore ENOENT"), { code: "ENOENT" });
    const spawn = vi.fn((command: string) => command === "pg_dump"
      ? { error: null, status: 0, stdout: "pg_dump (PostgreSQL) 16.14", stderr: "" }
      : { error: missing, status: null, stdout: "", stderr: "" });

    await expect(assertPostgresBackupPrerequisites({
      databaseUrl: "postgresql://release:secret@127.0.0.1:5432/release_test",
      spawn,
      serverVersionRead: async () => 160014,
      restoreCapabilityRead: async () => ({ ok: true, reason: null }),
    })).rejects.toThrow("pg_restore is required");
  });

  it("fails before handover when the database role cannot restore the schema", async () => {
    const spawn = vi.fn(() => ({
      error: null,
      status: 0,
      stdout: "pg_dump (PostgreSQL) 16.14",
      stderr: "",
    }));

    await expect(assertPostgresBackupPrerequisites({
      databaseUrl: "postgresql://release:secret@127.0.0.1:5432/release_test",
      spawn,
      serverVersionRead: async () => 160014,
      restoreCapabilityRead: async () => ({ ok: false, reason: "objects have another owner" }),
    })).rejects.toThrow("objects have another owner");
  });

  it("rejects destructive restore while any cluster writer is unfenced", () => {
    const fence = {
      schema_version: "soulstream.cluster-write-fence.v1",
      status: "verified",
      release_id: "release-1",
      target_head: "target-head",
      writer_nodes: ["eiaserinnys", "eias-linegames", "eias-linegames-wsl"],
      fenced_nodes: ["eiaserinnys", "eias-linegames-wsl"],
      active_writer_count: 1,
    };

    expect(() => validateClusterWriteFence(
      fence,
      backupEnvironment("C:/backup"),
    )).toThrow("cluster writers are not fully fenced");
  });

  it("requires an explicit cluster fence path before restore", async () => {
    const directory = mkdtempSync(join(tmpdir(), "soul-restore-fence-"));
    tempDirs.push(directory);
    writeFileSync(join(directory, "database-backup.json"), JSON.stringify({
      schema_version: "soulstream.database-backup.v1",
      status: "verified",
      release_id: "release-1",
      target_head: "target-head",
      dump_file: "database.dump",
      dump_sha256: "a".repeat(64),
      destructive_pending: ["043_destructive.sql"],
    }));
    const spawn = vi.fn();

    await expect(import("../../../packages/db-schema/scripts/backup.mjs").then(
      ({ restoreBackup }) => restoreBackup({ env: backupEnvironment(directory), spawn }),
    )).rejects.toThrow("SOULSTREAM_CLUSTER_WRITE_FENCE_PATH is required");
    expect(spawn).not.toHaveBeenCalled();
  });
});
