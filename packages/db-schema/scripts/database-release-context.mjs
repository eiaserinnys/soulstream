import dotenv from "dotenv";
import postgres from "postgres";

import { createBackup, recoverPreviousReleaseData, verifyBackup } from "./backup.mjs";
import { inspectUserObjectInventory } from "./database-release-inventory.mjs";
import { deploymentEnvironmentPath, readDatabaseUrl } from "./migration-contract.mjs";
import { readMigrationPlan, runMigrations } from "./migrate.mjs";

export async function resolveDatabaseReleaseContext(options, command) {
  const env = options.env ?? process.env;
  const protectedIdentity = new Map([
    "HANIEL_MANIFEST_DIGEST",
    "HANIEL_DATABASE_CONTRACT_DIGEST",
    "HANIEL_DATABASE_WRITER_SERVICES",
    "HANIEL_DATABASE_REQUIRED_SUBPHASES",
  ].filter((name) => env[name] !== undefined).map((name) => [name, env[name]]));
  dotenv.config({
    path: deploymentEnvironmentPath(env, options.cwd ?? process.cwd()),
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
  const needsSql = databaseCommand
    && !options.inventoryRead && !options.planRead && !options.migrationRun;
  const sql = options.sql ?? (needsSql ? postgres(readDatabaseUrl(env), {
    max: 1, idle_timeout: 1, connect_timeout: 5,
  }) : null);
  return {
    env,
    sql,
    ownsSql: !options.sql && sql !== null,
    inventoryRead: options.inventoryRead ?? (() => inspectUserObjectInventory(sql)),
    planRead: options.planRead ?? (() => readMigrationPlan(sql)),
    migrationRun: options.migrationRun ?? ((mode, runOptions) =>
      runMigrations(mode, { ...runOptions, sql })),
    backupCreate: options.backupCreate ?? createBackup,
    backupVerify: options.backupVerify ?? verifyBackup,
    backupRecover: options.backupRecover ?? recoverPreviousReleaseData,
  };
}
