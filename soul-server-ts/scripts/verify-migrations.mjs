#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { releaseServiceEnvironmentPath } from "../../packages/db-schema/scripts/migration-contract.mjs";

// Mirror migrate.mjs's environment discovery: the connection string comes from
// MIGRATION_DATABASE_URL or DATABASE_URL, in the process env or the canonical
// deployment env file. dotenv is not resolvable from this package under pnpm
// isolation, so probe the file directly.
//
// Both names must be probed. A deployment that separates the DDL role can carry
// only MIGRATION_DATABASE_URL, and missing it here would silently downgrade the
// schema gate to "worker-db-free" on a node that does hold a credential.
function databaseUrlConfigured() {
  if (process.env.MIGRATION_DATABASE_URL?.trim()) return true;
  if (process.env.DATABASE_URL?.trim()) return true;
  try {
    const content = readFileSync(
      releaseServiceEnvironmentPath(process.env, process.cwd()),
      "utf8",
    );
    return /^\s*(?:MIGRATION_)?DATABASE_URL\s*=\s*\S/m.test(content);
  } catch {
    return false;
  }
}

if (!databaseUrlConfigured()) {
  // Worker-DB-free mode (Phase 12): workers hold no database credential and
  // schema verification is owned by the central orchestrator deployment.
  // Node-local haniel.yaml pre_start hooks may still invoke this script on
  // credential-free workers; succeeding explicitly here keeps any release
  // startable on such nodes without weakening the central schema gate,
  // whose manifests call migrate.mjs directly with a configured DATABASE_URL.
  console.log(JSON.stringify({
    status: "skipped",
    mode: "verify",
    reason: "worker-db-free: no database credential is configured; schema verification is owned by the central deployment",
  }));
  process.exit(0);
}

// migrate.mjs (and its dependencies) are only loaded on nodes that actually
// hold a DATABASE_URL, so credential-free workers stay startable even if
// db-schema runtime dependencies are absent.
const { runMigrations, formatMigrationError } = await import(
  "../../packages/db-schema/scripts/migrate.mjs"
);

try {
  const report = await runMigrations("verify");
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(JSON.stringify({
    status: "error",
    mode: "verify",
    message: formatMigrationError(error),
  }));
  process.exitCode = 1;
}
