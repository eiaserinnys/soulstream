import { readFile } from "node:fs/promises";

import {
  databaseReleaseFailure,
  serializeDatabaseReleaseResult,
} from "./database-release-result.mjs";
import { sha256 } from "./migration-contract.mjs";

function optionArgument(argv, name) {
  const inline = argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1];
}

function assignCanonicalEnvironmentValue(env, name, actual) {
  if (env[name] === undefined) {
    env[name] = actual;
    return;
  }
  if (env[name] !== actual) {
    throw new Error(`JOURNAL_GATE_FAILED: ${name} differs from release files`);
  }
}

export async function applyManifestContract(manifestPath, databaseContractPath, env) {
  if (!manifestPath && !databaseContractPath) return;
  if (!manifestPath || !databaseContractPath) {
    throw new Error("JOURNAL_GATE_FAILED: manifest and database contract must be paired");
  }
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString("utf8"));
  const contractBytes = await readFile(databaseContractPath);
  const contract = JSON.parse(contractBytes.toString("utf8"));
  if (contract.schema_version !== "soulstream.database-release-manifest.v1") {
    throw new Error("JOURNAL_GATE_FAILED: database release contract schema differs");
  }
  assignCanonicalEnvironmentValue(env, "HANIEL_MANIFEST_DIGEST", sha256(bytes));
  if (!manifest.migration || !manifest.environment_service) {
    throw new Error("JOURNAL_GATE_FAILED: database release manifest is incomplete");
  }
  const isStringList = (value) => Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.trim())
    && new Set(value).size === value.length;
  if (!isStringList(contract.writer_services) || contract.writer_services.length === 0
    || !contract.writer_services.includes(manifest.environment_service)
    || !isStringList(contract.required_subphases)) {
    throw new Error("JOURNAL_GATE_FAILED: database release contract identity is invalid");
  }
  assignCanonicalEnvironmentValue(
    env,
    "HANIEL_DATABASE_WRITER_SERVICES",
    JSON.stringify(contract.writer_services),
  );
  assignCanonicalEnvironmentValue(
    env,
    "HANIEL_DATABASE_REQUIRED_SUBPHASES",
    JSON.stringify(contract.required_subphases),
  );
  assignCanonicalEnvironmentValue(
    env,
    "HANIEL_DATABASE_CONTRACT_DIGEST",
    sha256(contractBytes),
  );
}

export async function runDatabaseReleaseCli(
  runDatabaseRelease,
  {
    argv = process.argv.slice(2),
    env = process.env,
    stdout = console.log,
    stderr = console.error,
  } = {},
) {
  const [command, ...args] = argv;
  try {
    const manifestPath = optionArgument(args, "--manifest");
    const databaseContractPath = optionArgument(args, "--database-contract");
    await applyManifestContract(manifestPath, databaseContractPath, env);
    const separator = args.indexOf("--");
    stdout(serializeDatabaseReleaseResult(await runDatabaseRelease(command, {
      env,
      subphase: optionArgument(args, "--subphase"),
      childCommand: separator < 0 ? undefined : args.slice(separator + 1),
    }), env));
    return 0;
  } catch (error) {
    stderr(serializeDatabaseReleaseResult(databaseReleaseFailure(error, env, command), env));
    return 1;
  }
}
