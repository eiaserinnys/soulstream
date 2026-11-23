import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { makeTempDirSync } from "../helpers/temp_dir.js";

import { runDatabaseReleaseCli } from
  "../../../packages/db-schema/scripts/database-release-cli.mjs";
import {
  assertInstallerQuiescence,
  resolveDatabaseReleaseAuthority,
  systemctlExecutable,
} from "../../../packages/db-schema/scripts/database-release-installer.mjs";
import {
  assertDatabaseReleaseApplyGate,
  readDatabaseReleaseJournal,
} from "../../../packages/db-schema/scripts/database-release-journal.mjs";
import {
  databaseReleaseJournalPath,
  runDatabaseRelease,
  type DatabaseReleaseOptions,
} from "../../../packages/db-schema/scripts/release-executor.mjs";

function repositoryFile(path: string) {
  return fileURLToPath(new URL(`../../../${path}`, import.meta.url));
}

const INSTALLER_MANIFEST = repositoryFile("install/release-manifest-installer.json");
const INSTALLER_CONTRACT = repositoryFile("install/database-release-installer.json");
const STANDALONE_MANIFEST = repositoryFile("deploy/release-manifest-standalone.json");
const STANDALONE_CONTRACT = repositoryFile("deploy/database-release-standalone.json");
const UNITS = ["soulstream-orch.service", "soulstream-worker.service"];
const HEAD = "4f0c2d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e";
const LOCAL_DATABASE_URL = "postgresql://soulstream:installer-secret@127.0.0.1:9/soulstream";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory(prefix: string) {
  const directory = makeTempDirSync(prefix);
  directories.push(directory);
  return directory;
}

/** The identity U11b setup_schema passes after checkout, rooted in a temp install. */
function installerEnvironment(root: string, serviceEnv = `DATABASE_URL=${LOCAL_DATABASE_URL}\n`) {
  const releaseId = `clean-${HEAD.slice(0, 12)}`;
  const serviceEnvFile = join(root, ".env.orch");
  writeFileSync(serviceEnvFile, serviceEnv, "utf8");
  return {
    HANIEL_SERVICE_ENV_FILE: serviceEnvFile,
    HANIEL_TARGET_HEAD: HEAD,
    HANIEL_PREVIOUS_HEAD: HEAD,
    HANIEL_RELEASE_ID: releaseId,
    HANIEL_REQUEST_ID: `installer-${HEAD}`,
    HANIEL_DEPLOY_REPO: "soulstream",
    HANIEL_BACKUP_DIR: join(root, ".local", "database-release", releaseId),
  } as Record<string, string>;
}

function unitState(loadState: string, activeState: string, mainPid: string) {
  return `LoadState=${loadState}\nActiveState=${activeState}\nSubState=dead\nMainPID=${mainPid}\n`;
}

const STOPPED = unitState("loaded", "inactive", "0");

function systemctl(answer: (unit: string, call: number) => string | Error = () => STOPPED) {
  const calls: string[] = [];
  return {
    calls,
    show: async (unit: string) => {
      calls.push(unit);
      const value = answer(unit, calls.length);
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function migration(id: string, ordinal: number, sql: string) {
  return { id, migration_id: id, ordinal, sha256: String(ordinal % 10).repeat(64), sql };
}

const MIXED_PLAN = [
  migration("172_drop_store.sql", 172, "DROP TABLE store"),
  migration("173_add_config.sql", 173, "CREATE TABLE IF NOT EXISTS config (id int)"),
];

/** A database double whose in-lock writer runs the real apply gate before "SQL". */
function fakeDatabase(pending: Array<ReturnType<typeof migration>>, operation = "upgrade") {
  const inventory = {
    object_count: operation === "fresh_install" ? 0 : 1,
    object_fingerprint: "0".repeat(64),
    relation_count: operation === "fresh_install" ? 0 : 1,
    routine_count: 0,
    type_count: 0,
    ledger_count: 0,
  };
  let ledger: Array<Record<string, unknown>> = [];
  const plan = () => ({
    state: "current",
    ledger,
    migrations: pending,
    bootstrap: [],
    pending: ledger.length > 0 ? [] : pending,
  });
  const state = { sqlExecuted: 0 };
  const options: DatabaseReleaseOptions = {
    inventoryRead: async () => inventory,
    planRead: async () => plan(),
    migrationRun: async (_mode, runOptions) => {
      await assertDatabaseReleaseApplyGate({
        env: runOptions.env,
        operation,
        plan: plan(),
        inventory,
        authority: runOptions.authority,
        systemctlShow: runOptions.systemctlShow,
      });
      state.sqlExecuted += 1;
      ledger = pending.map((item) => ({
        ...item,
        checksum: item.sha256,
        release_id: runOptions.env.HANIEL_RELEASE_ID,
      }));
    },
  };
  return { options, state };
}

async function runCli(
  command: string,
  env: Record<string, string>,
  injected: DatabaseReleaseOptions = {},
  paths: [string, string] | null = [INSTALLER_MANIFEST, INSTALLER_CONTRACT],
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const authorities: string[] = [];
  const argv = paths
    ? [command, "--manifest", paths[0], "--database-contract", paths[1]]
    : [command];
  const code = await runDatabaseReleaseCli(async (cliCommand, { subphase, ...options }) => {
    authorities.push(options.authority);
    return await runDatabaseRelease(cliCommand, {
      platform: "linux",
      ...options,
      subphase: subphase ?? undefined,
      ...injected,
    });
  }, {
    argv,
    env,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  const output = code === 0 ? stdout : stderr;
  return {
    code,
    authorities,
    output: output.join("\n"),
    result: JSON.parse(output.at(-1) ?? "null") as Record<string, any>,
  };
}

async function authorityFor(paths: [string, string] | null, env: Record<string, string> = {}) {
  const authorities: string[] = [];
  const errors: string[] = [];
  const code = await runDatabaseReleaseCli(async (_command, options) => {
    authorities.push(options.authority);
    return { ok: true };
  }, {
    argv: paths ? ["preflight", "--manifest", paths[0], "--database-contract", paths[1]] : ["preflight"],
    env,
    stdout: () => undefined,
    stderr: (line) => errors.push(line),
  });
  return { code, authorities, errors: errors.join("\n") };
}

describe.sequential("linux-systemd-installer database release authority", () => {
  it("selects the installer authority only for the repository install/ pair", async () => {
    await expect(authorityFor([INSTALLER_MANIFEST, INSTALLER_CONTRACT])).resolves.toMatchObject({
      code: 0,
      authorities: ["linux-systemd-installer"],
    });
    await expect(authorityFor([STANDALONE_MANIFEST, STANDALONE_CONTRACT])).resolves.toMatchObject({
      code: 0,
      authorities: ["haniel"],
    });
    await expect(authorityFor(null)).resolves.toMatchObject({ code: 0, authorities: ["haniel"] });
  });

  it("rejects copied pairs, half-canonical pairs and a canonical contract without authority", async () => {
    const directory = tempDirectory("release-installer-copies-");
    const manifestCopy = join(directory, "release-manifest-installer.json");
    const contractCopy = join(directory, "database-release-installer.json");
    copyFileSync(INSTALLER_MANIFEST, manifestCopy);
    copyFileSync(INSTALLER_CONTRACT, contractCopy);
    for (const paths of [
      [manifestCopy, contractCopy],
      [INSTALLER_MANIFEST, contractCopy],
      [manifestCopy, INSTALLER_CONTRACT],
    ] as Array<[string, string]>) {
      const observed = await authorityFor(paths);
      expect(observed.code).toBe(1);
      expect(observed.authorities).toEqual([]);
      expect(observed.errors).toContain("JOURNAL_GATE_FAILED");
    }
    const canonical = { manifestPath: INSTALLER_MANIFEST, databaseContractPath: INSTALLER_CONTRACT };
    const contract = JSON.parse(readFileSync(INSTALLER_CONTRACT, "utf8"));
    const { authority: _authority, ...withoutAuthority } = contract;
    await expect(resolveDatabaseReleaseAuthority({ ...canonical, contract: withoutAuthority }))
      .rejects.toThrow("installer database contract authority differs");
    await expect(resolveDatabaseReleaseAuthority({
      ...canonical,
      contract: { ...contract, authority: "haniel" },
    })).rejects.toThrow("installer database contract authority differs");
  });

  it("keeps an environment-only installer request on the Haniel path", async () => {
    const root = tempDirectory("release-installer-env-only-");
    const env = {
      ...installerEnvironment(root),
      HANIEL_DATABASE_AUTHORITY: "linux-systemd-installer",
      HANIEL_DATABASE_AFFECTED_SERVICES: JSON.stringify(UNITS),
      HANIEL_DATABASE_REQUIRED_SUBPHASES: "[]",
      HANIEL_MANIFEST_DIGEST: "a".repeat(64),
      HANIEL_DATABASE_CONTRACT_DIGEST: "b".repeat(64),
    };
    await expect(authorityFor(null, { ...env })).resolves.toMatchObject({ authorities: ["haniel"] });
    const database = fakeDatabase(MIXED_PLAN);
    const observed = await runCli("preflight", env, database.options, null);
    expect(observed.authorities).toEqual(["haniel"]);
    expect(observed.code).toBe(1);
    expect(observed.result.error.message).toContain("HANIEL_DEPLOYMENT_JOURNAL is required");
  });

  it("runs preflight, apply and verify with two live unit checks and no Haniel evidence", async () => {
    const root = tempDirectory("release-installer-upgrade-");
    const env = installerEnvironment(root);
    const units = systemctl();
    const database = fakeDatabase(MIXED_PLAN);
    const injected = { ...database.options, systemctlShow: units.show };

    const preflight = await runCli("preflight", { ...env }, injected);
    expect(preflight.code).toBe(0);
    expect(preflight.result).toMatchObject({
      operation: "upgrade",
      pending_count: 2,
      pending_additive_only: false,
      status: "preflight_complete",
      release_id: `clean-${HEAD.slice(0, 12)}`,
      request_id: `installer-${HEAD}`,
    });
    expect(units.calls).toEqual([]);
    await expect(runCli("apply", { ...env }, injected)).resolves.toMatchObject({
      code: 0,
      result: { status: "applied" },
    });
    expect(units.calls).toEqual([...UNITS, ...UNITS]);
    expect(database.state.sqlExecuted).toBe(1);
    await expect(runCli("verify", { ...env }, injected)).resolves.toMatchObject({
      code: 0,
      result: { status: "verified" },
    });
    const journal = await readDatabaseReleaseJournal(databaseReleaseJournalPath(env));
    expect(journal).toMatchObject({
      status: "verified",
      haniel_journal_path: null,
      affected_services: UNITS,
      target_head: HEAD,
      previous_head: HEAD,
      quiescence_receipt_digest: null,
    });
    // A completed target still reports its first plan; the journal status tells
    // the installer that no new backup is needed.
    await expect(runCli("preflight", { ...env }, injected)).resolves.toMatchObject({
      code: 0,
      result: { status: "verified", pending_count: 2, pending_additive_only: false },
    });
  });

  it("refuses the installer authority outside Linux", async () => {
    const root = tempDirectory("release-installer-platform-");
    const env = installerEnvironment(root);
    for (const platform of ["win32", "darwin"]) {
      const observed = await runCli("preflight", { ...env }, {
        ...fakeDatabase(MIXED_PLAN).options,
        platform,
      });
      expect(observed.code).toBe(1);
      expect(observed.result.error.code).toBe("NON_STANDALONE_INSTALLER_FORBIDDEN");
    }
    expect(existsSync(databaseReleaseJournalPath(env))).toBe(false);
  });

  it.each([
    "HANIEL_DEPLOYMENT_JOURNAL",
    "HANIEL_QUIESCENCE_RECEIPT",
    "HANIEL_NODE_ID",
  ])("refuses %s even when the service env clears it", async (marker) => {
    const root = tempDirectory("release-installer-marker-");
    const env = installerEnvironment(
      root,
      `DATABASE_URL=${LOCAL_DATABASE_URL}\n${marker}=\n`,
    );
    for (const command of ["preflight", "apply", "verify"]) {
      const observed = await runCli(command, { ...env, [marker]: "/srv/haniel/marker" }, {
        ...fakeDatabase(MIXED_PLAN).options,
        systemctlShow: systemctl().show,
      });
      expect(observed.code).toBe(1);
      expect(observed.result.error.code).toBe("NON_STANDALONE_INSTALLER_FORBIDDEN");
      expect(observed.result.error.message).toContain(marker);
    }
    expect(existsSync(databaseReleaseJournalPath(env))).toBe(false);
  });

  it.each([
    [
      "a different migration URL",
      `DATABASE_URL=${LOCAL_DATABASE_URL}\n`
        + "MIGRATION_DATABASE_URL=postgresql://admin:installer-secret@127.0.0.1:9/soulstream\n",
    ],
    ["a remote host", "DATABASE_URL=postgresql://soulstream:installer-secret@db.example.test:5432/soulstream\n"],
    ["another database name", "DATABASE_URL=postgresql://soulstream:installer-secret@127.0.0.1:9/atom\n"],
  ])("refuses %s as the installer migration target", async (_case, serviceEnv) => {
    const root = tempDirectory("release-installer-target-");
    const env = installerEnvironment(root, serviceEnv);
    const observed = await runCli("preflight", { ...env }, fakeDatabase(MIXED_PLAN).options);
    expect(observed.code).toBe(1);
    expect(observed.result.error.code).toBe("NON_STANDALONE_INSTALLER_FORBIDDEN");
    expect(observed.output).not.toContain("installer-secret");
    expect(observed.output).not.toContain("db.example.test");
    expect(existsSync(databaseReleaseJournalPath(env))).toBe(false);
  });

  it("accepts local host spellings and the unix socket for the soulstream database", async () => {
    for (const url of [
      "postgresql://soulstream:installer-secret@localhost:9/soulstream",
      "postgresql://soulstream:installer-secret@[::1]:9/soulstream",
      "postgresql://soulstream@%2Fvar%2Frun%2Fpostgresql/soulstream",
    ]) {
      const root = tempDirectory("release-installer-local-");
      const env = installerEnvironment(root, `DATABASE_URL=${url}\nMIGRATION_DATABASE_URL=${url}\n`);
      const observed = await runCli("preflight", { ...env }, fakeDatabase(MIXED_PLAN).options);
      expect(observed.code, observed.output).toBe(0);
    }
  });

  it.each([
    ["an active unit", () => unitState("loaded", "active", "0")],
    ["a live main process", () => unitState("loaded", "inactive", "4242")],
    ["a missing unit", () => unitState("not-found", "inactive", "0")],
    ["a failed systemctl", () => new Error("Failed to connect to bus")],
    ["a missing property", () => "LoadState=loaded\nActiveState=inactive\nSubState=dead\n"],
  ])("refuses an upgrade apply with %s before any SQL", async (_case, answer) => {
    const root = tempDirectory("release-installer-quiescence-");
    const env = installerEnvironment(root);
    const units = systemctl(answer);
    const database = fakeDatabase(MIXED_PLAN);
    const injected = { ...database.options, systemctlShow: units.show };
    expect((await runCli("preflight", { ...env }, injected)).code).toBe(0);
    const observed = await runCli("apply", { ...env }, injected);
    expect(observed.code).toBe(1);
    expect(observed.result.error.code).toBe("QUIESCENCE_REQUIRED");
    expect(database.state.sqlExecuted).toBe(0);
    const journal = await readDatabaseReleaseJournal(databaseReleaseJournalPath(env));
    expect(journal.status).toBe("preflight_complete");
  });

  it("accepts not-found units only for a first install", async () => {
    const notFound = async () => unitState("not-found", "inactive", "0");
    await expect(assertInstallerQuiescence({
      operation: "fresh_install",
      services: UNITS,
      systemctlShow: notFound,
    })).resolves.toBeUndefined();
    await expect(assertInstallerQuiescence({
      operation: "upgrade",
      services: UNITS,
      systemctlShow: notFound,
    })).rejects.toThrow("QUIESCENCE_REQUIRED");
    await expect(assertInstallerQuiescence({
      operation: "fresh_install",
      services: UNITS,
      systemctlShow: async () => unitState("not-found", "active", "0"),
    })).rejects.toThrow("QUIESCENCE_REQUIRED");
  });

  it("stops before SQL when only the in-lock check sees a started unit", async () => {
    const root = tempDirectory("release-installer-second-check-");
    const env = installerEnvironment(root);
    const units = systemctl((_unit, call) => (call <= UNITS.length
      ? STOPPED
      : unitState("loaded", "active", "4242")));
    const database = fakeDatabase(MIXED_PLAN);
    const injected = { ...database.options, systemctlShow: units.show };
    expect((await runCli("preflight", { ...env }, injected)).code).toBe(0);
    const observed = await runCli("apply", { ...env }, injected);
    expect(observed.code).toBe(1);
    expect(observed.output).toContain("QUIESCENCE_REQUIRED");
    expect(units.calls.length).toBeGreaterThan(UNITS.length);
    expect(database.state.sqlExecuted).toBe(0);
    const journal = await readDatabaseReleaseJournal(databaseReleaseJournalPath(env));
    expect(journal.status).toBe("apply_failed");
  });

  it("keeps the deploy/ pairs on Haniel evidence that live unit checks cannot replace", async () => {
    const root = tempDirectory("release-installer-haniel-regression-");
    const backupDirectory = join(root, "haniel-release");
    const env = {
      HANIEL_BACKUP_DIR: backupDirectory,
      HANIEL_DEPLOY_REPO: "soulstream",
      HANIEL_DEPLOYMENT_JOURNAL: join(backupDirectory, "haniel-deployment.json"),
      HANIEL_PREVIOUS_HEAD: "1".repeat(40),
      HANIEL_RELEASE_ID: "release-1",
      HANIEL_REQUEST_ID: "request-1",
      HANIEL_TARGET_HEAD: "2".repeat(40),
      HANIEL_SERVICE_ENV_FILE: join(root, ".env.soul-server-ts"),
    };
    writeFileSync(env.HANIEL_SERVICE_ENV_FILE, `DATABASE_URL=${LOCAL_DATABASE_URL}\n`, "utf8");
    const units = systemctl();
    const database = fakeDatabase(MIXED_PLAN);
    const injected = { ...database.options, systemctlShow: units.show };
    const paths: [string, string] = [STANDALONE_MANIFEST, STANDALONE_CONTRACT];
    const preflight = await runCli("preflight", { ...env }, injected, paths);
    expect(preflight.authorities).toEqual(["haniel"]);
    expect(preflight.code).toBe(0);
    const observed = await runCli("apply", { ...env }, injected, paths);
    expect(observed.code).toBe(1);
    expect(observed.result.error.code).toBe("QUIESCENCE_REQUIRED");
    expect(observed.output).toContain("Haniel release evidence is unavailable");
    expect(units.calls).toEqual([]);
    expect(database.state.sqlExecuted).toBe(0);
    const journal = await readDatabaseReleaseJournal(databaseReleaseJournalPath(env));
    expect(journal.haniel_journal_path).toBe(env.HANIEL_DEPLOYMENT_JOURNAL);
  });

  it("accepts only preflight, apply and verify under the installer authority", async () => {
    const root = tempDirectory("release-installer-commands-");
    const env = installerEnvironment(root);
    for (const command of ["probe", "recover", "initialize", "run-subphase"]) {
      const observed = await runCli(command, { ...env }, fakeDatabase(MIXED_PLAN).options);
      expect(observed.code).toBe(1);
      expect(observed.output).toContain("installer authority accepts only preflight, apply and verify");
    }
  });

  it("uses an absolute systemctl path", () => {
    expect(systemctlExecutable((path) => path === "/bin/systemctl")).toBe("/bin/systemctl");
    expect(systemctlExecutable(() => true)).toBe("/usr/bin/systemctl");
    expect(systemctlExecutable(() => false)).toBeNull();
  });
});
