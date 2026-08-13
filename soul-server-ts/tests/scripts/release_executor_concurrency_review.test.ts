import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  databaseReleaseJournalPath,
  readDatabaseReleaseJournal,
  runDatabaseRelease,
} from "../../../packages/db-schema/scripts/release-executor.mjs";
import {
  acquireDatabaseReleaseLease,
  releaseDatabaseReleaseLease,
} from "../../../packages/db-schema/scripts/database-release-lock.mjs";

import { makeTempDirSync } from "../helpers/temp_dir.js";

const JOURNAL_MODULE = pathToFileURL(fileURLToPath(new URL(
  "../../../packages/db-schema/scripts/database-release-journal.mjs",
  import.meta.url,
))).href;
const EXECUTOR_MODULE = pathToFileURL(fileURLToPath(new URL(
  "../../../packages/db-schema/scripts/release-executor.mjs",
  import.meta.url,
))).href;
const EXECUTOR = fileURLToPath(new URL(
  "../../../packages/db-schema/scripts/release-executor.mjs",
  import.meta.url,
));
const TSX = fileURLToPath(new URL(
  "../../../orch-server-ts/node_modules/tsx/dist/cli.mjs",
  import.meta.url,
));
const BOARD_WRITER = fileURLToPath(new URL(
  "../../../orch-server-ts/scripts/migrate-board-yjs-runbook-residue.ts",
  import.meta.url,
));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function directory(prefix: string) {
  const value = makeTempDirSync(prefix);
  directories.push(value);
  return value;
}

function environment(backupDirectory: string, requestId = "request-1") {
  return {
    HANIEL_BACKUP_DIR: backupDirectory,
    HANIEL_DATABASE_OPERATION: "fresh_install",
    HANIEL_DATABASE_REQUIRED_SUBPHASES: '["board_yjs_runbook_residue"]',
    HANIEL_DATABASE_WRITER_SERVICES: '["soulstream-orch-server"]',
    HANIEL_DEPLOY_REPO: "soulstream",
    HANIEL_DEPLOYMENT_JOURNAL: join(backupDirectory, "haniel-deployment.json"),
    HANIEL_DATABASE_CONTRACT_DIGEST: "b".repeat(64),
    HANIEL_MANIFEST_DIGEST: "a".repeat(64),
    HANIEL_PREVIOUS_HEAD: "1".repeat(40),
    HANIEL_RELEASE_ID: "release-1",
    HANIEL_REQUEST_ID: requestId,
    HANIEL_TARGET_HEAD: "2".repeat(40),
  };
}

function inventory(fingerprint = "0".repeat(64), count = 0) {
  return {
    object_count: count,
    object_fingerprint: fingerprint,
    relation_count: count,
    routine_count: 0,
    type_count: 0,
    ledger_count: 0,
  };
}

function plan(pending = [migration()], ledger: Array<Record<string, unknown>> = []) {
  return { state: "empty", migrations: pending, bootstrap: [], pending, ledger };
}

function migration() {
  return {
    id: "001_initial.sql",
    migration_id: "001_initial.sql",
    ordinal: 1,
    sha256: "1".repeat(64),
    checksum: "1".repeat(64),
  };
}

async function prepareSqlAppliedRelease(backupDirectory: string) {
  const env = environment(backupDirectory);
  const pending = [migration()];
  let ledger: Array<Record<string, unknown>> = [];
  await runDatabaseRelease("preflight", {
    env,
    inventoryRead: async () => inventory(),
    planRead: async () => plan(pending, ledger),
  });
  writeFileSync(env.HANIEL_DEPLOYMENT_JOURNAL, JSON.stringify({
    repo: env.HANIEL_DEPLOY_REPO,
    request_id: env.HANIEL_REQUEST_ID,
    target_head: env.HANIEL_TARGET_HEAD,
    operation: "fresh_install",
    expected_operation: "fresh_install",
    manifest_digest: env.HANIEL_MANIFEST_DIGEST,
    database_journal_path: databaseReleaseJournalPath(env),
    state: "migrating",
  }), "utf8");
  await runDatabaseRelease("apply", {
    env,
    inventoryRead: async () => ledger.length ? inventory("1".repeat(64), 1) : inventory(),
    planRead: async () => plan(ledger.length ? [] : pending, ledger),
    migrationRun: async () => {
      ledger = pending.map((item) => ({ ...item, release_id: env.HANIEL_RELEASE_ID }));
    },
  });
  return env;
}

describe.sequential("database release cross-process and subphase boundaries", () => {
  it("serializes same and conflicting create identities in actual Node processes", async () => {
    const backupDirectory = directory("release-create-process-");
    mkdirSync(backupDirectory, { recursive: true });
    const base = environment(backupDirectory);
    const createSource = `
      import { createDatabaseReleaseJournal } from ${JSON.stringify(JOURNAL_MODULE)};
      const env = JSON.parse(process.env.RELEASE_ENV);
      const migration = { id: "001_initial.sql", sha256: "${"1".repeat(64)}" };
      try {
        const value = await createDatabaseReleaseJournal({
          env, operation: "fresh_install",
          plan: { pending: [migration] },
          inventory: { object_count: 0, object_fingerprint: "${"0".repeat(64)}",
            relation_count: 0, routine_count: 0, type_count: 0, ledger_count: 0 },
        });
        process.stdout.write(JSON.stringify({ ok: true, request: value.request_id }));
      } catch (error) {
        process.stderr.write(String(error)); process.exitCode = 1;
      }
    `;
    const same = await Promise.all([
      nodeChild(createSource, { RELEASE_ENV: JSON.stringify(base) }),
      nodeChild(createSource, { RELEASE_ENV: JSON.stringify(base) }),
    ]);
    expect(same.map((entry) => entry.code)).toEqual([0, 0]);
    let saved = await readDatabaseReleaseJournal(databaseReleaseJournalPath(base));
    expect(saved).toMatchObject({ revision: 1, request_id: "request-1" });
    expect(saved.history).toHaveLength(1);

    rmSync(databaseReleaseJournalPath(base));
    const left = environment(backupDirectory, "left");
    const right = environment(backupDirectory, "right");
    const conflict = await Promise.all([
      nodeChild(createSource, { RELEASE_ENV: JSON.stringify(left) }),
      nodeChild(createSource, { RELEASE_ENV: JSON.stringify(right) }),
    ]);
    expect(conflict.filter((entry) => entry.code === 0)).toHaveLength(1);
    expect(conflict.filter((entry) => entry.code === 1)).toHaveLength(1);
    expect(conflict.map((entry) => entry.stderr).join(" "))
      .toContain("JOURNAL_IDENTITY_CONFLICT");
    saved = await readDatabaseReleaseJournal(databaseReleaseJournalPath(base));
    const winner = conflict.find((entry) => entry.code === 0)!;
    expect(winner.stdout).toContain(saved.request_id);
  });

  it("uses one revision winner for actual cross-process transitions", async () => {
    const backupDirectory = directory("release-transition-process-");
    const env = environment(backupDirectory);
    await runDatabaseRelease("preflight", {
      env,
      inventoryRead: async () => inventory(),
      planRead: async () => plan(),
    });
    const transitionSource = `
      import { transitionDatabaseReleaseJournal } from ${JSON.stringify(JOURNAL_MODULE)};
      try {
        await transitionDatabaseReleaseJournal(process.env.JOURNAL_PATH, process.env.STATUS, {
          phase: "backup", expectedRevision: 1, expectedStatuses: ["preflight_complete"]
        });
      } catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
    `;
    const results = await Promise.all([
      nodeChild(transitionSource, {
        JOURNAL_PATH: databaseReleaseJournalPath(env), STATUS: "backup_created",
      }),
      nodeChild(transitionSource, {
        JOURNAL_PATH: databaseReleaseJournalPath(env), STATUS: "backup_failed",
      }),
    ]);
    expect(results.filter((entry) => entry.code === 0)).toHaveLength(1);
    expect(results.filter((entry) => entry.code === 1)).toHaveLength(1);
    expect(results.map((entry) => entry.stderr).join(" "))
      .toContain("JOURNAL_REVISION_CONFLICT");
    const saved = await readDatabaseReleaseJournal(databaseReleaseJournalPath(env));
    expect(saved).toMatchObject({ revision: 2 });
    expect(saved.history).toHaveLength(2);
  });

  it("recovers a stale Windows-compatible lease without treating a live lease as stale", async () => {
    const backupDirectory = directory("release-windows-lease-");
    const lockPath = join(backupDirectory, "database-release.lock");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      nonce: "stale",
      pid: 2_147_483_647,
      process_start_identity: null,
      acquired_at: "2000-01-01T00:00:00.000Z",
    }), "utf8");

    const lease = await acquireDatabaseReleaseLease(lockPath, {
      platform: "win32",
      timeoutMs: 100,
    });
    expect(lease.owner.pid).toBe(process.pid);
    utimesSync(lockPath, new Date(0), new Date(0));
    await expect(acquireDatabaseReleaseLease(lockPath, {
      platform: "win32",
      timeoutMs: 1,
    })).rejects.toThrow("RELEASE_LEASE_CONFLICT");
    await releaseDatabaseReleaseLease(lease);
  });

  it("atomically reclaims one stale generation across 24 actual Node processes", async () => {
    const backupDirectory = directory("release-stale-generation-");
    const lockPath = join(backupDirectory, "database-release.lock");
    const eventPath = join(backupDirectory, "critical-sections.jsonl");
    const readyPath = join(backupDirectory, "ready.jsonl");
    const startPath = join(backupDirectory, "start");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      nonce: "stale-generation",
      pid: 2_147_483_647,
      process_start_identity: null,
      acquired_at: "2000-01-01T00:00:00.000Z",
    }), "utf8");
    const worker = `
      import { appendFileSync, existsSync } from "node:fs";
      import {
        acquireDatabaseReleaseLease, releaseDatabaseReleaseLease,
      } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL(
        "../../../packages/db-schema/scripts/database-release-lock.mjs",
        import.meta.url,
      ))).href)};
      appendFileSync(process.env.READY_PATH, process.pid + "\\n");
      while (!existsSync(process.env.START_PATH)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const lease = await acquireDatabaseReleaseLease(process.env.LOCK_PATH, {
        timeoutMs: 30_000,
      });
      const start = Date.now();
      appendFileSync(process.env.EVENT_PATH,
        JSON.stringify({ type: "start", pid: process.pid, at: start }) + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      appendFileSync(process.env.EVENT_PATH,
        JSON.stringify({ type: "end", pid: process.pid, at: Date.now() }) + "\\n");
      await releaseDatabaseReleaseLease(lease);
    `;

    const resultPromises = Array.from({ length: 24 }, () => nodeChild(worker, {
      LOCK_PATH: lockPath,
      EVENT_PATH: eventPath,
      READY_PATH: readyPath,
      START_PATH: startPath,
    }));
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const ready = existsSync(readyPath)
        ? readFileSync(readyPath, "utf8").trim().split("\n").filter(Boolean).length
        : 0;
      if (ready === 24) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(readFileSync(readyPath, "utf8").trim().split("\n")).toHaveLength(24);
    writeFileSync(startPath, "start", "utf8");
    const results = await Promise.all(resultPromises);
    expect(results.every((entry) => entry.code === 0), JSON.stringify(results)).toBe(true);
    const events = readFileSync(eventPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { type: string; pid: number; at: number })
      .sort((left, right) => left.at - right.at || left.type.localeCompare(right.type));
    let concurrent = 0;
    let maximum = 0;
    for (const event of events) {
      concurrent += event.type === "start" ? 1 : -1;
      maximum = Math.max(maximum, concurrent);
    }
    expect(events).toHaveLength(48);
    expect(maximum).toBe(1);
    expect(concurrent).toBe(0);
  }, 60_000);

  it.each(["missing", "malformed"])(
    "bounds %s owner metadata recovery without an external timeout",
    (kind) => {
      const backupDirectory = directory(`release-${kind}-owner-`);
      const lockPath = join(backupDirectory, "database-release.lock");
      mkdirSync(lockPath, { recursive: true });
      if (kind === "malformed") writeFileSync(join(lockPath, "owner.json"), "{", "utf8");
      const source = `
        import {
          acquireDatabaseReleaseLease, releaseDatabaseReleaseLease,
        } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL(
          "../../../packages/db-schema/scripts/database-release-lock.mjs",
          import.meta.url,
        ))).href)};
        const lease = await acquireDatabaseReleaseLease(process.env.LOCK_PATH, {
          timeoutMs: 50,
        });
        await releaseDatabaseReleaseLease(lease);
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", LOCK_PATH: lockPath },
        timeout: 1_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("holds the phase lease across the actual subphase child and attaches terminal retry", async () => {
    const backupDirectory = directory("release-subphase-process-");
    const env = await prepareSqlAppliedRelease(backupDirectory);
    expect((await readDatabaseReleaseJournal(databaseReleaseJournalPath(env))).status)
      .toBe("sql_applied");

    const marker = join(backupDirectory, "child-marker.txt");
    const child = `
      import { writeFileSync } from "node:fs";
      import { assertDatabaseReleaseSubphaseGate } from ${JSON.stringify(EXECUTOR_MODULE)};
      await assertDatabaseReleaseSubphaseGate({
        env: process.env, subphase: "board_yjs_runbook_residue"
      });
      writeFileSync(${JSON.stringify(marker)}, "entered");
      process.stdout.write("child-json-one\\nchild-json-two\\n");
    `;
    const report = await runDatabaseRelease("run-subphase", {
      env,
      subphase: "board_yjs_runbook_residue",
      childCommand: [process.execPath, "--input-type=module", "-e", child],
    });
    expect(readFileSync(marker, "utf8")).toBe("entered");
    expect(report).toMatchObject({ status: "applied" });

    const runner = vi.fn();
    await expect(runDatabaseRelease("run-subphase", {
      env,
      subphase: "board_yjs_runbook_residue",
      subphaseRun: runner,
    })).resolves.toMatchObject({ status: "applied" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("recovers an orphan reclaim claim after the owning child exits", async () => {
    const backupDirectory = directory("release-orphan-reclaim-claim-");
    const lockPath = join(backupDirectory, "database-release.lock");
    const source = `
      import { acquireDatabaseReleaseLease } from ${JSON.stringify(pathToFileURL(
        fileURLToPath(new URL(
          "../../../packages/db-schema/scripts/database-release-lock.mjs",
          import.meta.url,
        )),
      ).href)};
      await acquireDatabaseReleaseLease(process.env.LOCK_PATH, {
        timeoutMs: 2_000,
        onReclaimClaimAcquired: () => process.exit(73),
      });
    `;
    const crashed = await nodeChild(source, { LOCK_PATH: lockPath });
    expect(crashed.code).toBe(73);
    expect(existsSync(`${lockPath}.reclaim-claim`)).toBe(true);

    const startedAt = Date.now();
    const lease = await acquireDatabaseReleaseLease(lockPath, { timeoutMs: 2_000 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(lease.owner.pid).toBe(process.pid);
    await releaseDatabaseReleaseLease(lease);
  });

  it("keeps an actual crashed board child incomplete and permits a gated retry", async () => {
    const backupDirectory = directory("release-subphase-crash-");
    const env = await prepareSqlAppliedRelease(backupDirectory);
    const failedChild = `
      import { assertDatabaseReleaseSubphaseGate } from ${JSON.stringify(EXECUTOR_MODULE)};
      await assertDatabaseReleaseSubphaseGate({
        env: process.env, subphase: "board_yjs_runbook_residue"
      });
      process.stderr.write("board mutation crashed");
      process.exit(17);
    `;
    await expect(runDatabaseRelease("run-subphase", {
      env,
      subphase: "board_yjs_runbook_residue",
      childCommand: [process.execPath, "--input-type=module", "-e", failedChild],
    })).rejects.toThrow("SUBPHASE_FAILED");
    expect(await readDatabaseReleaseJournal(databaseReleaseJournalPath(env))).toMatchObject({
      status: "subphase_started",
      active_subphase_token_digest: null,
      completed_subphases: [],
    });

    const marker = join(backupDirectory, "retried-board-child.txt");
    const retryChild = `
      import { writeFileSync } from "node:fs";
      import { assertDatabaseReleaseSubphaseGate } from ${JSON.stringify(EXECUTOR_MODULE)};
      await assertDatabaseReleaseSubphaseGate({
        env: process.env, subphase: "board_yjs_runbook_residue"
      });
      writeFileSync(${JSON.stringify(marker)}, "completed");
    `;
    await expect(runDatabaseRelease("run-subphase", {
      env,
      subphase: "board_yjs_runbook_residue",
      childCommand: [process.execPath, "--input-type=module", "-e", retryChild],
    })).resolves.toMatchObject({ status: "applied" });
    expect(readFileSync(marker, "utf8")).toBe("completed");
  });

  it("does not complete the journal when the actual board child rejects a non-central apply", async () => {
    const backupDirectory = directory("release-subphase-non-central-");
    const prepared = await prepareSqlAppliedRelease(backupDirectory);
    const env = {
      ...prepared,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      HANIEL_SERVICE_CWD: backupDirectory,
      SOULSTREAM_NODE_ID: "not-the-central-node",
    };

    await expect(runDatabaseRelease("run-subphase", {
      env,
      subphase: "board_yjs_runbook_residue",
      childCommand: [
        process.execPath,
        TSX,
        BOARD_WRITER,
        "--apply",
        "--quiesced",
        "--orch-health-url=http://127.0.0.1:9/api/health",
      ],
    })).rejects.toThrow("SUBPHASE_FAILED");
    expect(await readDatabaseReleaseJournal(databaseReleaseJournalPath(env))).toMatchObject({
      status: "subphase_started",
      completed_subphases: [],
      active_subphase_token_digest: null,
    });
  });

  it("emits one executor JSON result while suppressing child stdout", async () => {
    const source = readFileSync(EXECUTOR, "utf8");
    expect(source).toContain("run-subphase");
    expect(source).toContain("childCommand");
    const boardWrapper = readFileSync(fileURLToPath(new URL(
      "../../../orch-server-ts/scripts/deploy-board-yjs-runbook-residue.ts",
      import.meta.url,
    )), "utf8");
    expect(boardWrapper).toContain('encoding: "utf8"');
    expect(boardWrapper).not.toContain('stdio: "inherit"');
  });
});

function nodeChild(source: string, extraEnv: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { PATH: process.env.PATH ?? "", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
