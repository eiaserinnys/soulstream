import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import dotenv from "dotenv";

import { parseEnv } from "../src/config.js";
import { hashArtifactSet } from "../src/runner/runner_release_materializer.js";
import {
  declaredExecutablePath,
  deploymentEnvIdentity,
} from "../src/release/release_env.js";
import {
  HOST_RELEASE_ARTIFACTS,
  executableIdentity,
  hashReleaseFileSet,
} from "../src/release/release_artifacts.js";
import { buildReleaseManifest, canonicalJson } from "../src/release/release_manifest.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..");
const distRoot = resolve(
  optionValue(process.argv.slice(2), "--dist-root") ?? resolve(packageRoot, "dist"),
);
const runnerRoot = resolve(distRoot, "runner");
const migrationManifestPath = resolve(repositoryRoot, "packages/db-schema/migration-manifest.json");
const wireSchemaPath = resolve(repositoryRoot, "packages/wire-schema/src/upstream.schema.json");

// The service loads "<repository root>/.env.soul-server-ts" from its working directory,
// so that path is the default declared document. An explicit --env-file or
// SOULSTREAM_RELEASE_ENV_FILE overrides it; a node whose build hook predates that
// option still hashes the very document its service will start with.
const envFilePath = resolve(
  optionValue(process.argv.slice(2), "--env-file")
    ?? process.env.SOULSTREAM_RELEASE_ENV_FILE?.trim()
    ?? process.env.HANIEL_SERVICE_ENV_FILE?.trim()
    ?? resolve(repositoryRoot, ".env.soul-server-ts"),
);
const declaredEnv = await readDeclaredEnv(envFilePath);
const env = parseEnv({ ...process.env, ...declaredEnv });
const runnerReleaseId = await hashArtifactSet(runnerRoot);
const migrationManifestRaw = await readFile(migrationManifestPath, "utf8");
const migrationManifest = JSON.parse(migrationManifestRaw) as {
  migrations: Array<{ id: string; sha256: string }>;
};
const latestMigration = migrationManifest.migrations.at(-1);
if (!latestMigration) throw new Error("migration manifest is empty");

const manifest = buildReleaseManifest({
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim(),
  hostBundleHash: await hashReleaseFileSet(distRoot, HOST_RELEASE_ARTIFACTS),
  runnerReleaseId,
  runnerArtifactHash: runnerReleaseId,
  schemaGeneration: `${latestMigration.id}:${latestMigration.sha256}:${sha256(migrationManifestRaw)}`,
  wireGeneration: sha256(await readFile(wireSchemaPath)),
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  deploymentEnvIdentity: deploymentEnvIdentity(env, declaredEnv),
  claudeExecutable: await executableIdentity(
    "claude",
    declaredExecutablePath(declaredEnv, "claude"),
  ),
  codexExecutable: await executableIdentity(
    "codex",
    declaredExecutablePath(declaredEnv, "codex"),
  ),
});

await writeFile(resolve(distRoot, "release-manifest.json"), canonicalJson(
  manifest as unknown as import("../src/release/release_manifest.js").CanonicalJsonValue,
), "utf8");
process.stdout.write(
  `release manifest written: ${manifest.manifest_id} cohort=${manifest.release_cohort_id}\n`,
);

async function readDeclaredEnv(path: string): Promise<Record<string, string>> {
  try {
    return dotenv.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // No declared document: the service that starts this bundle must also have none.
    process.stdout.write(`release manifest: no deployment env document at ${path}\n`);
    return {};
  }
}

function sha256(value: string | Buffer): string {
  return `sha256-${createHash("sha256").update(value).digest("hex")}`;
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
