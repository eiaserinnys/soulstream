import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBackup,
  recoverPreviousReleaseData,
  verifyBackup,
} from "../../../packages/db-schema/scripts/backup.mjs";

import { makeTempDirSync } from "../helpers/temp_dir.js";
import {
  DEFAULT_POSTGRES_ARCHIVE_TIMEOUT_MS,
  DEFAULT_POSTGRES_COMMAND_TIMEOUT_MS,
  assertPostgresBackupPrerequisites,
  readPostgresArchiveTimeoutMs,
  runPostgresCommand,
} from "../../../packages/db-schema/scripts/postgres-backup-tools.mjs";
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
    const directory = makeTempDirSync("soul-backup-skip-");
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

describe("archive command timeout budget (R46)", () => {
  it("keeps the five-minute default for probes but lets archive callers pass their own budget", () => {
    const spawn = vi.fn(() => ({ error: null, status: 0, stdout: "", stderr: "" }));
    runPostgresCommand("pg_dump", ["--version"], { env: {} }, spawn);
    runPostgresCommand("pg_dump", ["--format", "custom"], { env: {}, timeout: 42_000 }, spawn);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ timeout: DEFAULT_POSTGRES_COMMAND_TIMEOUT_MS });
    expect(spawn.mock.calls[1]?.[2]).toMatchObject({ timeout: 42_000 });
  });

  it("reads the archive budget from HANIEL_POSTGRES_ARCHIVE_TIMEOUT_MS and rejects garbage", () => {
    expect(readPostgresArchiveTimeoutMs({})).toBe(DEFAULT_POSTGRES_ARCHIVE_TIMEOUT_MS);
    expect(DEFAULT_POSTGRES_ARCHIVE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_POSTGRES_COMMAND_TIMEOUT_MS);
    expect(readPostgresArchiveTimeoutMs({ HANIEL_POSTGRES_ARCHIVE_TIMEOUT_MS: "900000" })).toBe(900_000);
    expect(() => readPostgresArchiveTimeoutMs({ HANIEL_POSTGRES_ARCHIVE_TIMEOUT_MS: "soon" }))
      .toThrow("HANIEL_POSTGRES_ARCHIVE_TIMEOUT_MS");
    expect(() => readPostgresArchiveTimeoutMs({ HANIEL_POSTGRES_ARCHIVE_TIMEOUT_MS: "0" }))
      .toThrow("HANIEL_POSTGRES_ARCHIVE_TIMEOUT_MS");
  });

  it("dumps the whole database with the archive budget, not the probe budget", async () => {
    const directory = makeTempDirSync("soul-backup-timeout-");
    tempDirs.push(directory);
    const spawn = vi.fn((command: string, args: string[]) => {
      if (args.includes("--file")) {
        const target = args[args.indexOf("--file") + 1]!;
        require("node:fs").writeFileSync(target, "PGDMP");
      }
      return { error: null, status: 0, stdout: "", stderr: "" };
    });
    await createBackup({
      env: { ...backupEnvironment(directory), HANIEL_POSTGRES_ARCHIVE_TIMEOUT_MS: "1200000" },
      spawn,
      planRead: async () => ({
        state: "current",
        bootstrap: [],
        pending: [{ id: "085b_drop.sql", rollback_compatibility: "restore_required", destructive: true }],
      }),
    });
    const dumpCall = spawn.mock.calls.find(([command, args]) => command === "pg_dump" && args.includes("--format"));
    expect(dumpCall?.[2]).toMatchObject({ timeout: 1_200_000 });
  });
});
