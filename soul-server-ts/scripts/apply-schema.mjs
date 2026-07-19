#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  formatMigrationError,
  runMigrations,
} from "../../packages/db-schema/scripts/migrate.mjs";

export async function applySchema(options = {}) {
  return await runMigrations("fresh-install", options);
}

export function formatApplySchemaError(error, env = process.env) {
  return formatMigrationError(error, env);
}

async function main() {
  try {
    const report = await applySchema();
    console.log(`[apply-schema] schema applied ${JSON.stringify(report)}`);
  } catch (error) {
    console.error("[apply-schema] failed");
    console.error(formatApplySchemaError(error));
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) await main();
