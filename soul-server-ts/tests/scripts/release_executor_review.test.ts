import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDatabaseReleaseJournal,
  readDatabaseReleaseJournal,
  transitionDatabaseReleaseJournal,
  writeDatabaseReleaseJournal,
} from "../../../packages/db-schema/scripts/database-release-journal.mjs";
import {
  databaseReleaseJournalPath,
  runDatabaseRelease,
} from "../../../packages/db-schema/scripts/release-executor.mjs";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function environment(directory: string, requestId = "request-1", operation = "upgrade") {
  return {
    HANIEL_BACKUP_DIR: directory,
    HANIEL_DATABASE_OPERATION: operation,
    HANIEL_DATABASE_REQUIRED_SUBPHASES: "[]",
    HANIEL_DATABASE_WRITER_SERVICES:
      '["soulstream-orch-server","soulstream-soul-server-ts"]',
    HANIEL_DEPLOY_REPO: "soulstream",
    HANIEL_DEPLOYMENT_JOURNAL: join(directory, "haniel-deployment.json"),
    HANIEL_DATABASE_CONTRACT_DIGEST: "b".repeat(64),
    HANIEL_MANIFEST_DIGEST: "a".repeat(64),
    HANIEL_PREVIOUS_HEAD: "1".repeat(40),
    HANIEL_RELEASE_ID: "release-1",
    HANIEL_REQUEST_ID: requestId,
    HANIEL_TARGET_HEAD: "2".repeat(40),
  };
}

function inventory(fingerprint = "0".repeat(64), objectCount = 1) {
  return {
    object_count: objectCount,
    object_fingerprint: fingerprint,
    relation_count: objectCount,
    routine_count: 0,
    type_count: 0,
    ledger_count: 0,
  };
}

function migration(id = "061_contract.sql") {
  return {
    id,
    migration_id: id,
    ordinal: 61,
    sha256: "1".repeat(64),
    checksum: "1".repeat(64),
    release_id: "release-1",
  };
}

function plan(pending = [migration()], ledger: Array<Record<string, unknown>> = []) {
  return {
    state: "current",
    ledger,
    migrations: pending,
    bootstrap: [],
    pending,
  };
}

function tempDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function createJournal(env: ReturnType<typeof environment>, operation = "upgrade") {
  await mkdir(env.HANIEL_BACKUP_DIR, { recursive: true });
  return await createDatabaseReleaseJournal({
    env,
    operation,
    plan: plan(),
    inventory: inventory(),
  });
}

async function writeHanielEvidence(env: ReturnType<typeof environment>) {
  const receiptPath = join(env.HANIEL_BACKUP_DIR, "soulstream.quiescence.json");
  const receipt = {
    request_id: env.HANIEL_REQUEST_ID,
    repo: env.HANIEL_DEPLOY_REPO,
    target_head: env.HANIEL_TARGET_HEAD,
    owner_instance: "owner-1",
    quiescence_nonce: "nonce-1",
    stopped_services: ["soulstream-orch-server", "soulstream-soul-server-ts"],
    already_stopped_services: [],
    quiesced_services: ["soulstream-orch-server", "soulstream-soul-server-ts"],
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
  await writeFile(env.HANIEL_DEPLOYMENT_JOURNAL, `${JSON.stringify({
    repo: env.HANIEL_DEPLOY_REPO,
    request_id: env.HANIEL_REQUEST_ID,
    target_head: env.HANIEL_TARGET_HEAD,
    operation: "upgrade",
    expected_operation: "upgrade",
    manifest_digest: env.HANIEL_MANIFEST_DIGEST,
    database_journal_path: databaseReleaseJournalPath(env),
    state: "backing_up",
    quiescence_receipt: receipt,
  })}\n`, "utf8");
  return { ...env, HANIEL_QUIESCENCE_RECEIPT: receiptPath };
}

describe.sequential("database release review regressions", () => {
  it("rejects a concurrent different-identity journal create without replacing the winner", async () => {
    const directory = tempDirectory("release-journal-identity-");
    const left = environment(directory, "left");
    const right = environment(directory, "right");
    const settled = await Promise.allSettled([createJournal(left), createJournal(right)]);

    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((entry) => entry.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    expect(String((rejected as PromiseRejectedResult).reason))
      .toContain("JOURNAL_IDENTITY_CONFLICT");
    const saved = await readDatabaseReleaseJournal(databaseReleaseJournalPath(left));
    expect(["left", "right"]).toContain(saved.request_id);
  });

  it("rotates only a different-identity terminal journal and preserves the archive", async () => {
    const directory = tempDirectory("release-journal-rotation-");
    const firstEnv = environment(directory, "request-first");
    const first = await createJournal(firstEnv);
    const terminal = {
      ...first,
      revision: first.revision + 1,
      status: "verified",
      last_committed_phase: "verify",
    };
    await writeDatabaseReleaseJournal(databaseReleaseJournalPath(firstEnv), terminal);
    const terminalBytes = await readFile(databaseReleaseJournalPath(firstEnv), "utf8");

    const sameRetry = await createJournal(firstEnv);
    expect(sameRetry).toMatchObject({ request_id: "request-first", status: "verified" });
    expect((await readdir(directory)).filter((name) => name.includes("archive")))
      .toHaveLength(0);

    const secondEnv = {
      ...environment(directory, "request-second"),
      HANIEL_TARGET_HEAD: "3".repeat(40),
    };
    const second = await createJournal(secondEnv);
    expect(second).toMatchObject({
      request_id: "request-second",
      target_head: "3".repeat(40),
      revision: 1,
      status: "preflight_complete",
    });
    const archives = (await readdir(directory))
      .filter((name) => name.startsWith("database-release.archive-"));
    expect(archives).toHaveLength(1);
    expect(await readFile(join(directory, archives[0]), "utf8")).toBe(terminalBytes);
    expect(JSON.parse(terminalBytes)).toMatchObject({
      request_id: "request-first",
      target_head: "2".repeat(40),
      status: "verified",
    });

    await expect(createJournal({
      ...environment(directory, "request-third"),
      HANIEL_TARGET_HEAD: "4".repeat(40),
    })).rejects.toThrow("JOURNAL_IDENTITY_CONFLICT");
  });

  it("reclassifies a different-identity release after a terminal fresh install", async () => {
    const directory = tempDirectory("release-sequential-operation-");
    const firstEnv = environment(directory, "request-fresh", "fresh_install");
    const firstPending = [migration("001_initial.sql")];
    let firstLedger: Array<Record<string, unknown>> = [];
    await runDatabaseRelease("preflight", {
      env: firstEnv,
      inventoryRead: async () => inventory("0".repeat(64), 0),
      planRead: async () => plan(firstPending, firstLedger),
    });
    await runDatabaseRelease("apply", {
      env: firstEnv,
      inventoryRead: async () => firstLedger.length
        ? inventory("1".repeat(64), 1)
        : inventory("0".repeat(64), 0),
      planRead: async () => plan(firstLedger.length ? [] : firstPending, firstLedger),
      migrationRun: async () => {
        firstLedger = firstPending.map((entry) => ({
          ...entry,
          release_id: firstEnv.HANIEL_RELEASE_ID,
        }));
      },
    });
    await runDatabaseRelease("verify", {
      env: firstEnv,
      inventoryRead: async () => inventory("1".repeat(64), 1),
      planRead: async () => ({ ...plan([], firstLedger), state: "current" }),
    });
    const firstPath = databaseReleaseJournalPath(firstEnv);
    const firstTerminalBytes = await readFile(firstPath, "utf8");

    const secondEnv = {
      ...environment(directory, "request-upgrade", "upgrade"),
      HANIEL_PREVIOUS_HEAD: firstEnv.HANIEL_TARGET_HEAD,
      HANIEL_TARGET_HEAD: "3".repeat(40),
    };
    const secondReport = await runDatabaseRelease("preflight", {
      env: secondEnv,
      inventoryRead: async () => inventory("2".repeat(64), 1),
      planRead: async () => plan([migration("062_upgrade.sql")], firstLedger),
    });

    expect(secondReport).toMatchObject({
      operation: "upgrade",
      status: "preflight_complete",
      request_id: "request-upgrade",
      target_head: "3".repeat(40),
    });
    const current = await readDatabaseReleaseJournal(firstPath);
    expect(current).toMatchObject({
      request_id: "request-upgrade",
      operation: "upgrade",
      status: "preflight_complete",
    });
    const archives = (await readdir(directory))
      .filter((name) => name.startsWith("database-release.archive-"));
    expect(archives).toHaveLength(1);
    expect(await readFile(join(directory, archives[0]), "utf8")).toBe(firstTerminalBytes);
  });

  it("uses revision CAS and monotonic expected states for concurrent transitions", async () => {
    const directory = tempDirectory("release-journal-cas-");
    const env = environment(directory);
    const created = await createJournal(env);
    expect(created.revision).toBe(1);

    const settled = await Promise.allSettled([
      transitionDatabaseReleaseJournal(databaseReleaseJournalPath(env), "backup_created", {
        phase: "backup",
        details: { winner: "left" },
        expectedRevision: 1,
        expectedStatuses: ["preflight_complete"],
      }),
      transitionDatabaseReleaseJournal(databaseReleaseJournalPath(env), "backup_failed", {
        phase: "backup",
        details: { winner: "right" },
        expectedRevision: 1,
        expectedStatuses: ["preflight_complete"],
      }),
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    const saved = await readDatabaseReleaseJournal(databaseReleaseJournalPath(env));
    expect(saved.revision).toBe(2);
    expect(saved.history).toHaveLength(2);
    expect([Boolean(saved.winner === "left"), Boolean(saved.winner === "right")])
      .toContain(true);

    await expect(transitionDatabaseReleaseJournal(
      databaseReleaseJournalPath(env),
      "preflight_complete",
      {
        phase: "preflight",
        expectedRevision: 2,
        expectedStatuses: [saved.status],
      },
    )).rejects.toThrow("JOURNAL_STATE_CONFLICT");
  });

  it("durably syncs the parent directory after replace and cleans temporary files", async () => {
    const directory = tempDirectory("release-journal-durable-");
    const path = join(directory, "database-release.json");
    const events: string[] = [];
    const adapter = {
      open: async (target: string, flags: string, mode?: number) => {
        const handle = await open(target, flags, mode);
        const isDirectory = target === dirname(path);
        return {
          writeFile: async (...args: Parameters<typeof handle.writeFile>) => {
            events.push("file-write");
            return await handle.writeFile(...args);
          },
          sync: async () => {
            events.push(isDirectory ? "directory-sync" : "file-sync");
            return await handle.sync();
          },
          close: async () => await handle.close(),
        };
      },
      rename: async (source: string, target: string) => {
        events.push("rename");
        await rename(source, target);
      },
    };

    await writeDatabaseReleaseJournal(path, {
      schema_version: "soulstream.database-release.v1",
    }, { fileSystem: adapter, platform: "linux" });

    expect(events).toEqual(["file-write", "file-sync", "rename", "directory-sync"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schema_version: "soulstream.database-release.v1",
    });
  });

  it("cleans a unique temporary journal after rename failure", async () => {
    const directory = tempDirectory("release-journal-temp-cleanup-");
    const path = join(directory, "database-release.json");
    const removed: string[] = [];
    let temporary = "";
    const adapter = {
      open: async (target: string) => {
        temporary = target;
        return {
          writeFile: async () => undefined,
          sync: async () => undefined,
          close: async () => undefined,
        };
      },
      rename: async () => {
        throw new Error("simulated rename failure");
      },
      unlink: async (target: string) => {
        removed.push(target);
      },
    };

    await expect(writeDatabaseReleaseJournal(path, {
      schema_version: "soulstream.database-release.v1",
    }, { fileSystem: adapter, platform: "linux" })).rejects.toThrow("rename failure");
    expect(temporary).toMatch(/database-release\.json\.\d+\.[^.]+\.tmp$/);
    expect(removed).toEqual([temporary]);
  });

  it("uses the explicit Windows durability branch without opening the parent directory", async () => {
    const directory = tempDirectory("release-journal-windows-");
    const path = join(directory, "database-release.json");
    const opened: string[] = [];
    const adapter = {
      open: async (target: string, flags: string, mode?: number) => {
        opened.push(target);
        return await open(target, flags, mode);
      },
      rename,
    };

    await writeDatabaseReleaseJournal(path, {
      schema_version: "soulstream.database-release.v1",
    }, { fileSystem: adapter, platform: "win32" });

    expect(opened).toHaveLength(1);
    expect(opened[0]).not.toBe(dirname(path));
  });

  it("rejects a synthetic receipt that is not linked from the Haniel journal", async () => {
    const directory = tempDirectory("release-quiescence-evidence-");
    const env = environment(directory);
    await createJournal(env);
    const receiptPath = join(directory, "synthetic.json");
    await writeFile(receiptPath, JSON.stringify({
      request_id: env.HANIEL_REQUEST_ID,
      repo: env.HANIEL_DEPLOY_REPO,
      target_head: env.HANIEL_TARGET_HEAD,
      owner_instance: "owner-1",
      quiescence_nonce: "nonce-1",
      stopped_services: ["writer"],
      already_stopped_services: [],
      quiesced_services: ["writer"],
    }), "utf8");

    const backupCreate = vi.fn();
    await expect(runDatabaseRelease("backup", {
      env: { ...env, HANIEL_QUIESCENCE_RECEIPT: receiptPath },
      backupCreate,
    })).rejects.toThrow("QUIESCENCE_REQUIRED");
    expect(backupCreate).not.toHaveBeenCalled();
  });

  it("accepts only exact Haniel-linked owner, nonce, operation, manifest and service evidence", async () => {
    const directory = tempDirectory("release-haniel-evidence-");
    const baseEnv = environment(directory);
    await createJournal(baseEnv);
    const env = await writeHanielEvidence(baseEnv);
    const backupCreate = vi.fn(async () => ({
      status: "created",
      release_id: env.HANIEL_RELEASE_ID,
      target_head: env.HANIEL_TARGET_HEAD,
      pending_migrations: ["061_contract.sql"],
      rollback_unsafe_pending: ["061_contract.sql"],
    }));

    await expect(runDatabaseRelease("backup", { env, backupCreate }))
      .resolves.toMatchObject({ status: "backup_created" });
    expect(backupCreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing journal", async (env: ReturnType<typeof environment>) => {
      await unlink(env.HANIEL_DEPLOYMENT_JOURNAL);
    }],
    ["request", async (env: ReturnType<typeof environment>) => {
      await mutateJson(env.HANIEL_DEPLOYMENT_JOURNAL, (value) => { value.request_id = "other"; });
    }],
    ["repo", async (env: ReturnType<typeof environment>) => {
      await mutateJson(env.HANIEL_DEPLOYMENT_JOURNAL, (value) => { value.repo = "other"; });
    }],
    ["target", async (env: ReturnType<typeof environment>) => {
      await mutateJson(env.HANIEL_DEPLOYMENT_JOURNAL, (value) => { value.target_head = "f".repeat(40); });
    }],
    ["operation", async (env: ReturnType<typeof environment>) => {
      await mutateJson(env.HANIEL_DEPLOYMENT_JOURNAL, (value) => { value.operation = "fresh_install"; });
    }],
    ["expected operation", async (env: ReturnType<typeof environment>) => {
      await mutateJson(env.HANIEL_DEPLOYMENT_JOURNAL, (value) => { value.expected_operation = "fresh_install"; });
    }],
    ["manifest", async (env: ReturnType<typeof environment>) => {
      await mutateJson(env.HANIEL_DEPLOYMENT_JOURNAL, (value) => { value.manifest_digest = "f".repeat(64); });
    }],
    ["linked journal", async (env: ReturnType<typeof environment>) => {
      await mutateJson(env.HANIEL_DEPLOYMENT_JOURNAL, (value) => { value.database_journal_path = "/other"; });
    }],
    ["owner", async (env: ReturnType<typeof environment>) => {
      await mutateJson(env.HANIEL_DEPLOYMENT_JOURNAL, (value) => {
        (value.quiescence_receipt as Record<string, unknown>).owner_instance = "other";
      });
    }],
    ["nonce", async (env: ReturnType<typeof environment>) => {
      await mutateJson(env.HANIEL_DEPLOYMENT_JOURNAL, (value) => {
        (value.quiescence_receipt as Record<string, unknown>).quiescence_nonce = "other";
      });
    }],
    ["stopped service set", async (env: ReturnType<typeof environment>) => {
      await mutateJson(env.HANIEL_DEPLOYMENT_JOURNAL, (value) => {
        (value.quiescence_receipt as Record<string, unknown>).stopped_services = ["other"];
      });
    }],
    ["quiesced service set", async (env: ReturnType<typeof environment>) => {
      await mutateJson(env.HANIEL_QUIESCENCE_RECEIPT, (value) => {
        value.quiesced_services = ["other"];
      });
    }],
  ])("rejects %s Haniel evidence before backup and apply", async (_name, mutate) => {
    const directory = tempDirectory("release-haniel-evidence-mismatch-");
    const baseEnv = environment(directory);
    await createJournal(baseEnv);
    const env = await writeHanielEvidence(baseEnv);
    await mutate(env);
    const backupCreate = vi.fn();
    const migrationRun = vi.fn();

    await expect(runDatabaseRelease("backup", { env, backupCreate }))
      .rejects.toThrow("QUIESCENCE_REQUIRED");
    await expect(runDatabaseRelease("apply", { env, migrationRun })).rejects.toThrow();
    expect(backupCreate).not.toHaveBeenCalled();
    expect(migrationRun).not.toHaveBeenCalled();
  });

  it("attaches terminal apply and recovery retries without repeating side effects", async () => {
    const directory = tempDirectory("release-terminal-attach-");
    const fresh = environment(directory, "request-1", "fresh_install");
    const pending = [migration("001_initial.sql")];
    let ledger: Array<Record<string, unknown>> = [];
    const migrationRun = vi.fn(async () => {
      ledger = pending.map((entry) => ({ ...entry, release_id: fresh.HANIEL_RELEASE_ID }));
    });
    await runDatabaseRelease("preflight", {
      env: fresh,
      inventoryRead: async () => inventory("0".repeat(64), 0),
      planRead: async () => plan(pending, ledger),
    });
    await runDatabaseRelease("apply", {
      env: fresh,
      inventoryRead: async () => ledger.length
        ? inventory("1".repeat(64), 1)
        : inventory("0".repeat(64), 0),
      planRead: async () => plan(ledger.length ? [] : pending, ledger),
      migrationRun,
    });
    await runDatabaseRelease("verify", {
      env: fresh,
      planRead: async () => ({ ...plan([], ledger), state: "current" }),
      inventoryRead: async () => inventory("1".repeat(64), 1),
    });
    await expect(runDatabaseRelease("apply", {
      env: fresh,
      inventoryRead: async () => inventory("1".repeat(64), 1),
      planRead: async () => plan([], ledger),
      migrationRun,
    })).resolves.toMatchObject({ status: "verified" });
    expect(migrationRun).toHaveBeenCalledTimes(1);
  });

  it("attaches a recovered retry without invoking restore again", async () => {
    const directory = tempDirectory("release-recovered-attach-");
    const env = environment(directory);
    let journal = await createJournal(env, "upgrade");
    const path = databaseReleaseJournalPath(env);
    journal = await transitionDatabaseReleaseJournal(path, "backup_created", {
      phase: "backup",
      expectedRevision: journal.revision,
      expectedStatuses: [journal.status],
      details: { backup: { metadata: { status: "created" }, verified_at: null } },
    });
    journal = await transitionDatabaseReleaseJournal(path, "backup_verified", {
      phase: "verify_backup",
      expectedRevision: journal.revision,
      expectedStatuses: [journal.status],
      details: {
        backup: {
          metadata: { status: "verified", verified_at: "2026-08-09T00:00:00Z" },
          verified_at: "2026-08-09T00:00:00Z",
        },
      },
    });
    journal = await transitionDatabaseReleaseJournal(path, "apply_started", {
      phase: "apply",
      expectedRevision: journal.revision,
      expectedStatuses: [journal.status],
    });
    await transitionDatabaseReleaseJournal(path, "recovered", {
      phase: "recovery",
      expectedRevision: journal.revision,
      expectedStatuses: [journal.status],
    });
    const backupRecover = vi.fn();
    await expect(runDatabaseRelease("recover", {
      env: {
        ...env,
        HANIEL_DATABASE_OPERATION: "recovery",
        HANIEL_FAILED_DATABASE_OPERATION: "upgrade",
      },
      backupRecover,
    })).resolves.toMatchObject({ status: "recovered", recovered: true });
    expect(backupRecover).not.toHaveBeenCalled();
  });

});

async function mutateJson(
  path: string,
  mutate: (value: Record<string, unknown>) => void,
) {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(value);
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}
