#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatDatabaseReleaseError } from "../../packages/db-schema/scripts/database-release-result.mjs";
import { readDatabaseUrl } from "../../packages/db-schema/scripts/migration-contract.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(import.meta.url);
const executor = fileURLToPath(new URL("../../packages/db-schema/scripts/release-executor.mjs", import.meta.url));
const contractArgs = ["--manifest", "deploy/release-manifest.json",
  "--database-contract", "deploy/database-release-central.json"];

// One-time central release step. Remove this entrypoint/subphase after deployment.
export function applyFolderStorage() {
  const run = (args) => execFileSync(process.execPath, [executor, ...args], {
    cwd: repositoryRoot, env: process.env, stdio: "inherit",
  });
  run(["apply", ...contractArgs]);
  run(["run-subphase", ...contractArgs, "--subphase", "folder_storage_documents",
    "--", process.execPath, script, "--documents"]);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  try {
    if (process.argv[2] === "--documents") {
      // The release executor loads the service environment and gates the child
      // on committed SQL plus the existing handover/quiescence evidence.
      const { runFolderStorageMigration } = await import("../dist/folder_storage_migration_cli.js");
      console.log(JSON.stringify(await runFolderStorageMigration(readDatabaseUrl())));
    } else {
      applyFolderStorage();
    }
  } catch (error) {
    console.error(formatDatabaseReleaseError(error));
    process.exitCode = 1;
  }
}
