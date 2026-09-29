#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDatabaseRelease } from "../../packages/db-schema/scripts/release-executor.mjs";
import { runDatabaseReleaseCli } from "../../packages/db-schema/scripts/database-release-cli.mjs";
import { readDatabaseUrl } from "../../packages/db-schema/scripts/migration-contract.mjs";
import { assertDatabaseReleaseSubphaseGate } from "../../packages/db-schema/scripts/database-release-subphase.mjs";

const script = fileURLToPath(import.meta.url);
const contractArgs = [
  "--manifest", fileURLToPath(new URL("../../deploy/release-manifest.json", import.meta.url)),
  "--database-contract", fileURLToPath(new URL("../../deploy/database-release-central.json", import.meta.url)),
];

// One-time central release step. Remove this entrypoint/subphase after deployment.
export async function applyFolderStorage(options = {}) {
  await runDatabaseRelease("apply", options);
  return await runDatabaseRelease("run-subphase", {
    ...options,
    subphase: "folder_storage_documents",
    childCommand: [process.execPath, script, "--documents"],
  });
}

export async function convertFolderStorage() {
  await assertDatabaseReleaseSubphaseGate({ subphase: "folder_storage_documents" });
  const databaseUrl = readDatabaseUrl();
  const { runFolderStorageMigration } = await import("../dist/folder_storage_migration_cli.js");
  return await runFolderStorageMigration(databaseUrl);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  const documents = process.argv[2] === "--documents";
  process.exitCode = await runDatabaseReleaseCli(
    documents ? () => convertFolderStorage() : (_command, options) => applyFolderStorage(options),
    { argv: documents ? ["folder_storage_documents"] : ["apply", ...contractArgs] },
  );
}
