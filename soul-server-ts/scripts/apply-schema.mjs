#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  formatDatabaseReleaseError,
  runDatabaseRelease,
} from "../../packages/db-schema/scripts/release-executor.mjs";
import { readDatabaseUrl } from "../../packages/db-schema/scripts/migration-contract.mjs";

export async function applySchema(options = {}) {
  return await runDatabaseRelease("initialize", options);
}

export function formatApplySchemaError(error, env = process.env) {
  return formatDatabaseReleaseError(error, env);
}

async function main() {
  try {
    const report = await applySchema();
    // One-time release step: remove after folder storage deployment is verified.
    // initialize has loaded the release environment and verified SQL migration 108.
    const { runFolderStorageMigration } = await import("../../orch-server-ts/dist/folder_storage_migration_cli.js");
    const documents = await runFolderStorageMigration(readDatabaseUrl());
    console.log(`[apply-schema] folder documents migrated ${JSON.stringify(documents)}`);
    console.log(`[apply-schema] schema applied ${JSON.stringify(report)}`);
  } catch (error) {
    console.error("[apply-schema] failed");
    console.error(formatApplySchemaError(error));
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) await main();
