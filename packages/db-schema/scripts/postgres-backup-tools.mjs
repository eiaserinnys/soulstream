import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import postgres from "postgres";

export function postgresCli(databaseUrl, env = process.env) {
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

export function runPostgresCommand(
  command,
  args,
  options = {},
  spawn = spawnSync,
) {
  const result = spawn(command, args, {
    ...options,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      throw new Error(`${command} is required but was not found on PATH`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed with ${result.status}: ${result.stderr?.trim()}`);
  }
  return result.stdout ?? "";
}

function postgresMajor(output, command) {
  const match = output.match(/(?:PostgreSQL\)\s+)?(\d+)(?:\.\d+)?/);
  if (!match) throw new Error(`${command} returned an unrecognized version: ${output.trim()}`);
  return Number(match[1]);
}

async function readServerVersion(databaseUrl) {
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 1, connect_timeout: 5 });
  try {
    const rows = await sql`SHOW server_version_num`;
    return Number(rows[0]?.server_version_num);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function readRestoreCapability(databaseUrl) {
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 1, connect_timeout: 5 });
  try {
    const rows = await sql`
      SELECT
        has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,
        has_schema_privilege(current_user, current_schema(), 'CREATE') AS can_create,
        NOT EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
            AND NOT pg_has_role(current_user, c.relowner, 'MEMBER')
        ) AS owns_relations,
        NOT EXISTS (
          SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = current_schema()
            AND NOT pg_has_role(current_user, p.proowner, 'MEMBER')
        ) AS owns_routines,
        NOT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = current_schema()
            AND t.typtype IN ('c', 'd', 'e', 'r')
            AND NOT pg_has_role(current_user, t.typowner, 'MEMBER')
        ) AS owns_types,
        NOT EXISTS (
          SELECT 1
          FROM pg_extension e
          JOIN pg_namespace n ON n.oid = e.extnamespace
          WHERE n.nspname = current_schema()
            AND NOT pg_has_role(current_user, e.extowner, 'MEMBER')
        ) AS owns_extensions
    `;
    const row = rows[0];
    const ok = Boolean(
      row?.can_connect
      && row?.can_create
      && row?.owns_relations
      && row?.owns_routines
      && row?.owns_types
      && row?.owns_extensions,
    );
    return {
      ok,
      reason: ok
        ? null
        : "database role cannot create and replace every object in the active schema",
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function assertPostgresBackupPrerequisites(
  {
    databaseUrl,
    env = process.env,
    spawn = spawnSync,
    serverVersionRead = readServerVersion,
    restoreCapabilityRead = readRestoreCapability,
  },
) {
  const dumpVersion = runPostgresCommand("pg_dump", ["--version"], { env }, spawn);
  const restoreVersion = runPostgresCommand("pg_restore", ["--version"], { env }, spawn);
  const serverVersion = Number(await serverVersionRead(databaseUrl));
  if (!Number.isInteger(serverVersion) || serverVersion <= 0) {
    throw new Error("PostgreSQL server returned an invalid server_version_num");
  }
  const serverMajor = Math.floor(serverVersion / 10_000);
  const dumpMajor = postgresMajor(dumpVersion, "pg_dump");
  const restoreMajor = postgresMajor(restoreVersion, "pg_restore");
  if (dumpMajor < serverMajor || restoreMajor < serverMajor) {
    throw new Error(
      `PostgreSQL backup tools must be at least server major ${serverMajor}; `
      + `pg_dump=${dumpMajor}, pg_restore=${restoreMajor}`,
    );
  }

  const capability = await restoreCapabilityRead(databaseUrl);
  if (!capability?.ok) {
    throw new Error(`PostgreSQL restore capability check failed: ${capability?.reason ?? "unknown"}`);
  }

  const directory = await mkdtemp(resolve(tmpdir(), "soulstream-pg-preflight-"));
  const probePath = resolve(directory, "schema-probe.dump");
  const cli = postgresCli(databaseUrl, env);
  try {
    runPostgresCommand(
      "pg_dump",
      [...cli.args, "--schema-only", "--format", "custom", "--file", probePath],
      { env: cli.env },
      spawn,
    );
    const bytes = await readFile(probePath);
    if (bytes.length === 0) throw new Error("pg_dump prerequisite probe produced an empty file");
    runPostgresCommand("pg_restore", ["--list", probePath], { env: cli.env }, spawn);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return {
    server_major: serverMajor,
    pg_dump_major: dumpMajor,
    pg_restore_major: restoreMajor,
    restore_capability: "verified",
  };
}
