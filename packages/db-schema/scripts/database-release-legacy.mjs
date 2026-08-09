import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { applyManifestContract } from "./database-release-cli.mjs";
import { deploymentEnvironmentPath } from "./migration-contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export async function prepareLegacyInitializeEnvironment(options) {
  const env = options.env ?? process.env;
  dotenv.config({
    path: deploymentEnvironmentPath(env, options.cwd ?? process.cwd()),
    override: true,
    processEnv: env,
  });
  const releaseId = (env.HANIEL_RELEASE_ID ?? env.SOULSTREAM_RELEASE_ID)?.trim();
  if (!releaseId) throw new Error("SOULSTREAM_RELEASE_ID is required for initialize");
  const targetHead = env.HANIEL_TARGET_HEAD?.trim() || execFileSync(
    "git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" },
  ).trim();
  const serviceCwd = env.HANIEL_SERVICE_CWD?.trim() || options.cwd || process.cwd();
  const backupDirectory = env.HANIEL_BACKUP_DIR?.trim()
    || resolve(serviceCwd, ".haniel", "database-release", releaseId);
  const manifestPath = resolve(repositoryRoot, "deploy/release-manifest-standalone.json");
  const contractPath = resolve(repositoryRoot, "deploy/database-release-standalone.json");
  env.HANIEL_RELEASE_ID = releaseId;
  env.HANIEL_DEPLOY_REPO ??= "soulstream";
  env.HANIEL_REQUEST_ID ??= `legacy-initialize-${releaseId}-${targetHead}`;
  env.HANIEL_PREVIOUS_HEAD ??= targetHead;
  env.HANIEL_TARGET_HEAD = targetHead;
  env.HANIEL_BACKUP_DIR = backupDirectory;
  env.HANIEL_DEPLOYMENT_JOURNAL ??= resolve(backupDirectory, "legacy-haniel.json");
  await applyManifestContract(manifestPath, contractPath, env);
}
