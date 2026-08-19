import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { parseEnv } from "../src/config.js";
import { resolveClaudeExecutableFromPath } from "../src/engine/claude_executable_path.js";
import { resolveCodexCliPath } from "../src/engine/codex_cli_path.js";
import { hashArtifactSet } from "../src/runner/runner_release_materializer.js";
import { deploymentEnvIdentity } from "../src/release/release_env.js";
import {
  HOST_RELEASE_ARTIFACTS,
  executableIdentity,
  hashReleaseFileSet,
} from "../src/release/release_artifacts.js";
import { buildReleaseManifest, canonicalJson } from "../src/release/release_manifest.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..");
const distRoot = resolve(packageRoot, "dist");
const runnerRoot = resolve(distRoot, "runner");
const migrationManifestPath = resolve(repositoryRoot, "packages/db-schema/migration-manifest.json");
const wireSchemaPath = resolve(repositoryRoot, "packages/wire-schema/src/upstream.schema.json");

const processEnv = { ...process.env };
const claudePath = resolveClaudeExecutableFromPath(processEnv, process.platform);
if (claudePath) processEnv.CLAUDE_CODE_EXECPATH = claudePath;
const codexPath = resolveCodexCliPath(processEnv, process.platform)?.path;
if (codexPath) processEnv.CODEX_CLI_PATH = codexPath;
const env = parseEnv(processEnv);
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
  deploymentEnvIdentity: deploymentEnvIdentity(env, processEnv),
  claudeExecutable: await executableIdentity("claude", claudePath),
  codexExecutable: await executableIdentity("codex", codexPath),
});

await writeFile(resolve(distRoot, "release-manifest.json"), canonicalJson(
  manifest as unknown as import("../src/release/release_manifest.js").CanonicalJsonValue,
), "utf8");
process.stdout.write(
  `release manifest written: ${manifest.manifest_id} cohort=${manifest.release_cohort_id}\n`,
);

function sha256(value: string | Buffer): string {
  return `sha256-${createHash("sha256").update(value).digest("hex")}`;
}
