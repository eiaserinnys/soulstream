#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import dotenv from "dotenv";
import postgres from "postgres";

import {
  assertLegacyBackupResolved,
  deploymentEnvironmentPath,
  destructivePending,
  legacyRetirementPending,
  loadLegacyBackupContract,
  readDatabaseUrl,
  readReleaseId,
  sha256,
} from "./migration-contract.mjs";
import { readMigrationPlan } from "./migrate.mjs";

const METADATA_NAME = "database-backup.json";
const DUMP_NAME = "database.dump";

function requireDeployEnvironment(env) {
  const backupDirectory = env.HANIEL_BACKUP_DIR?.trim();
  const targetHead = env.HANIEL_TARGET_HEAD?.trim();
  if (!backupDirectory) throw new Error("HANIEL_BACKUP_DIR is required");
  if (!targetHead) throw new Error("HANIEL_TARGET_HEAD is required");
  return {
    backupDirectory: resolve(backupDirectory),
    targetHead,
    releaseId: readReleaseId(env),
  };
}

function postgresCli(databaseUrl, env) {
  const parsed = new URL(databaseUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!parsed.hostname || !database || !parsed.username) {
    throw new Error("DATABASE_URL must include hostname, user, and database");
  }
  return {
    args: [
      "--host", parsed.hostname,
      "--port", parsed.port || "5432",
      "--username", decodeURIComponent(parsed.username),
      "--dbname", database,
    ],
    env: {
      ...env,
      PGPASSWORD: decodeURIComponent(parsed.password),
      ...(parsed.searchParams.get("sslmode")
        ? { PGSSLMODE: parsed.searchParams.get("sslmode") }
        : {}),
    },
  };
}

function run(command, args, options, spawn = spawnSync) {
  const result = spawn(command, args, {
    ...options,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with ${result.status}: ${result.stderr?.trim()}`);
  }
  return result.stdout ?? "";
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function databasePlan(databaseUrl) {
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 1, connect_timeout: 5 });
  try {
    return await readMigrationPlan(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function validateBackupArchive(metadata, bytes, toc) {
  if (sha256(bytes) !== metadata.dump_sha256) {
    throw new Error("database dump checksum differs");
  }
  const tocEntries = toc.split("\n").filter((line) => line && !line.startsWith(";")).length;
  if (tocEntries < 10 || !/\bTABLE\b/.test(toc)) {
    throw new Error("pg_restore list does not contain a credible database archive");
  }
  return tocEntries;
}

export async function createBackup(
  { env = process.env, cwd = process.cwd(), spawn = spawnSync } = {},
) {
  dotenv.config({
    path: deploymentEnvironmentPath(env, cwd),
    override: true,
    processEnv: env,
  });
  const databaseUrl = readDatabaseUrl(env);
  const deploy = requireDeployEnvironment(env);
  const dumpPath = resolve(deploy.backupDirectory, DUMP_NAME);
  const metadataPath = resolve(deploy.backupDirectory, METADATA_NAME);
  await mkdir(deploy.backupDirectory, { recursive: true });

  const cli = postgresCli(databaseUrl, env);
  run(
    "pg_dump",
    [...cli.args, "--format", "custom", "--file", dumpPath],
    { env: cli.env },
    spawn,
  );
  const bytes = await readFile(dumpPath);
  const size = (await stat(dumpPath)).size;
  if (size === 0) throw new Error("pg_dump produced an empty file");
  const plan = await databasePlan(databaseUrl);
  const metadata = {
    schema_version: "soulstream.database-backup.v1",
    status: "created",
    release_id: deploy.releaseId,
    target_head: deploy.targetHead,
    created_at: new Date().toISOString(),
    dump_file: DUMP_NAME,
    dump_bytes: size,
    dump_sha256: sha256(bytes),
    schema_state: plan.state,
    destructive_pending: destructivePending(plan).map((item) => item.id),
  };
  await atomicJson(metadataPath, metadata);
  return metadata;
}

export async function verifyBackup(
  { env = process.env, cwd = process.cwd(), spawn = spawnSync } = {},
) {
  dotenv.config({
    path: deploymentEnvironmentPath(env, cwd),
    override: true,
    processEnv: env,
  });
  const databaseUrl = readDatabaseUrl(env);
  const deploy = requireDeployEnvironment(env);
  const metadataPath = resolve(deploy.backupDirectory, METADATA_NAME);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (!new Set(["created", "verified"]).has(metadata.status)) {
    throw new Error("backup metadata is not in a verifiable state");
  }
  if (metadata.dump_file !== DUMP_NAME) throw new Error("backup metadata dump path differs");
  if (metadata.release_id !== deploy.releaseId || metadata.target_head !== deploy.targetHead) {
    throw new Error("backup metadata does not match this release");
  }

  const dumpPath = resolve(deploy.backupDirectory, metadata.dump_file);
  const bytes = await readFile(dumpPath);
  const toc = run("pg_restore", ["--list", dumpPath], { env }, spawn);
  const tocEntries = validateBackupArchive(metadata, bytes, toc);

  const plan = await databasePlan(databaseUrl);
  const pending = destructivePending(plan).map((item) => item.id);
  if (JSON.stringify(pending) !== JSON.stringify(metadata.destructive_pending)) {
    throw new Error("database migration plan changed after backup");
  }
  if (legacyRetirementPending(plan)) {
    assertLegacyBackupResolved(await loadLegacyBackupContract());
  }

  const verified = {
    ...metadata,
    status: "verified",
    verified_at: new Date().toISOString(),
    pg_restore_toc_entries: tocEntries,
  };
  await atomicJson(metadataPath, verified);
  return verified;
}

export async function restoreBackup(
  { env = process.env, cwd = process.cwd(), spawn = spawnSync } = {},
) {
  dotenv.config({
    path: deploymentEnvironmentPath(env, cwd),
    override: true,
    processEnv: env,
  });
  const databaseUrl = readDatabaseUrl(env);
  const deploy = requireDeployEnvironment(env);
  const metadataPath = resolve(deploy.backupDirectory, METADATA_NAME);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (!new Set(["verified", "restored"]).has(metadata.status)) {
    throw new Error("only a verified backup can be restored");
  }
  if (metadata.dump_file !== DUMP_NAME) throw new Error("backup metadata dump path differs");
  if (metadata.release_id !== deploy.releaseId || metadata.target_head !== deploy.targetHead) {
    throw new Error("backup metadata does not match this release");
  }

  const dumpPath = resolve(deploy.backupDirectory, metadata.dump_file);
  const bytes = await readFile(dumpPath);
  const cli = postgresCli(databaseUrl, env);
  const toc = run("pg_restore", ["--list", dumpPath], { env: cli.env }, spawn);
  validateBackupArchive(metadata, bytes, toc);
  run(
    "pg_restore",
    [
      ...cli.args,
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      "--single-transaction",
      "--exit-on-error",
      dumpPath,
    ],
    { env: cli.env },
    spawn,
  );

  const plan = await databasePlan(databaseUrl);
  const pending = destructivePending(plan).map((item) => item.id);
  if (
    plan.state !== metadata.schema_state
    || JSON.stringify(pending) !== JSON.stringify(metadata.destructive_pending)
  ) {
    throw new Error("restored database does not match the recorded migration plan");
  }
  const restored = {
    ...metadata,
    status: "restored",
    restored_at: new Date().toISOString(),
  };
  await atomicJson(metadataPath, restored);
  return restored;
}

export function formatBackupError(error, env = process.env) {
  let text = error instanceof Error ? error.stack ?? error.message : String(error);
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) text = text.split(databaseUrl).join("[redacted DATABASE_URL]");
  let password = "";
  try {
    password = databaseUrl ? new URL(databaseUrl).password : "";
  } catch {
    password = "";
  }
  if (password) text = text.split(decodeURIComponent(password)).join("[redacted]");
  return text;
}

async function main() {
  const mode = process.argv[2];
  try {
    const report = mode === "create"
      ? await createBackup()
      : mode === "verify"
        ? await verifyBackup()
        : mode === "restore"
          ? await restoreBackup()
        : (() => { throw new Error(`unknown backup mode: ${mode}`); })();
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(JSON.stringify({ status: "error", mode, message: formatBackupError(error) }));
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) await main();
