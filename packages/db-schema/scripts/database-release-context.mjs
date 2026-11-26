import dotenv from "dotenv";
import postgres from "postgres";

import { inspectUserObjectInventory } from "./database-release-inventory.mjs";
import {
  INSTALLER_DATABASE_AUTHORITY,
  assertInstallerDatabaseTarget,
  databaseReleaseAuthority,
} from "./database-release-installer.mjs";
import { readDatabaseUrl, releaseServiceEnvironmentPath } from "./migration-contract.mjs";
import { readMigrationPlan, runMigrations } from "./migrate.mjs";

export async function resolveDatabaseReleaseContext(options, command) {
  const env = options.env ?? process.env;
  const authority = databaseReleaseAuthority(options.authority);
  const protectedIdentity = new Map([
    "HANIEL_MANIFEST_DIGEST",
    "HANIEL_DATABASE_CONTRACT_DIGEST",
    "HANIEL_DATABASE_AFFECTED_SERVICES",
    "HANIEL_DATABASE_REQUIRED_SUBPHASES",
  ].filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));
  dotenv.config({
    path: releaseServiceEnvironmentPath(env, options.cwd ?? process.cwd()),
    override: true,
    processEnv: env,
  });
  for (const [name, expected] of protectedIdentity) {
    if (env[name] !== expected) {
      throw new Error(`JOURNAL_GATE_FAILED: ${name} changed while loading service env`);
    }
  }
  const databaseCommand = new Set(["probe", "preflight", "apply", "verify", "initialize"])
    .has(command);
  if (authority === INSTALLER_DATABASE_AUTHORITY && databaseCommand) {
    assertInstallerDatabaseTarget(env);
  }
  const needsSql = databaseCommand
    && !options.inventoryRead && !options.planRead && !options.migrationRun;
  const sql = options.sql ?? (needsSql ? postgres(readDatabaseUrl(env), {
    max: 1, idle_timeout: 1, connect_timeout: 5, onnotice: () => {},
  }) : null);
  return {
    env,
    authority,
    sql,
    ownsSql: !options.sql && sql !== null,
    inventoryRead: options.inventoryRead ?? (() => inspectUserObjectInventory(sql)),
    planRead: options.planRead ?? (() => readMigrationPlan(sql)),
    migrationRun: options.migrationRun ?? ((mode, runOptions) =>
      runMigrations(mode, { ...runOptions, sql })),
  };
}
