#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { deploymentEnvironmentPath } from "../../packages/db-schema/scripts/migration-contract.mjs";

// Mirror migrate.mjs's environment discovery: DATABASE_URL comes from the
// process env or the canonical deployment env file. dotenv is not resolvable
// from this package under pnpm isolation, so probe the file directly.
function databaseUrlConfigured() {
  if (process.env.DATABASE_URL?.trim()) return true;
  try {
    const content = readFileSync(
      deploymentEnvironmentPath(process.env, process.cwd()),
      "utf8",
    );
    return /^\s*DATABASE_URL\s*=\s*\S/m.test(content);
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
    reason: "worker-db-free: DATABASE_URL is not configured; schema verification is owned by the central deployment",
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
