import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBackup,
  recoverPreviousReleaseData,
  verifyBackup,
} from "../../../packages/db-schema/scripts/backup.mjs";
import { assertPostgresBackupPrerequisites } from
  "../../../packages/db-schema/scripts/postgres-backup-tools.mjs";
import { assertRollbackUnsafeApplyGates, preflightPendingMigrations } from
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
  it("skips dump and restore tooling when the actual plan is previous-release safe", async () => {
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
      .toMatchObject({
        status: "verified_not_required",
        rollback_unsafe_pending: [],
      });

    const recovered = await recoverPreviousReleaseData({
      env: backupEnvironment(directory),
      spawn,
    });
    expect(recovered).toMatchObject({
      status: "verified_not_required",
      recovery_action: "preserve_data_for_previous_release",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not inspect PostgreSQL CLI tools for a non-destructive pending plan", async () => {
    const backupPreflight = vi.fn();

    await preflightPendingMigrations(
      {
        pending: [{
          id: "043_safe.sql",
          destructive: false,
          rollback_compatibility: "previous_release_safe",
        }],
      },
      { backupPreflight },
    );

    expect(backupPreflight).not.toHaveBeenCalled();
  });

  it("checks backup tools and records central service quiescence for a rollback-unsafe plan", async () => {
    const backupPreflight = vi.fn(async () => ({ restore_capability: "verified" }));

    const report = await preflightPendingMigrations(
      {
        pending: [{
          id: "043_destructive.sql",
          destructive: true,
          rollback_compatibility: "restore_required",
        }],
      },
      {
        env: backupEnvironment("C:/backup"),
        backupPreflight,
      },
    );

    expect(backupPreflight).toHaveBeenCalledWith(expect.objectContaining({
      databaseUrl: expect.stringContaining("release_test"),
    }));
    expect(report.writer_quiescence).toBe("central_service_stop");
  });

  it("revalidates the backup gate before applying rollback-unsafe DDL", async () => {
    const events: string[] = [];
    const backupGateRead = vi.fn(async () => events.push("backup"));

    await expect(assertRollbackUnsafeApplyGates(
      {
        pending: [{
          id: "043_contract.sql",
          destructive: false,
          rollback_compatibility: "restore_required",
        }],
      },
      backupEnvironment("C:/backup"),
      { backupGateRead },
    )).resolves.toMatchObject({
      gates: "verified",
      writer_quiescence: "central_service_stop",
    });
    expect(events).toEqual(["backup"]);
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

});
