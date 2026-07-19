#!/usr/bin/env node
import { runMigrations, formatMigrationError } from "../../packages/db-schema/scripts/migrate.mjs";

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
