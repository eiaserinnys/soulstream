import { readFile } from "node:fs/promises";

import {
  modelCatalogPathForRepository,
  repositoryRootFromEntryUrl,
} from "@soulstream/model-catalog/file-loader";
import { isRecord } from "@soulstream/wire-schema/json-record";

import type { Env } from "../config.js";
import { hashArtifactSet } from "../runner/runner_release_materializer.js";
import {
  declaredExecutablePath,
  deploymentEnvIdentity,
  type DeclaredDeploymentEnv,
} from "./release_env.js";
import {
  HOST_RELEASE_ARTIFACTS,
  executableIdentity,
  hashReleaseFileSet,
} from "./release_artifacts.js";
import {
  verifyReleaseManifest,
  type ReleaseManifestBuildInput,
  type ReleaseManifestV1,
} from "./release_manifest.js";

export async function loadAndVerifyReleaseManifest(input: {
  manifestPath: string;
  hostBundleDirectory: string;
  runnerArtifactDirectory: string;
  env: Env;
  /**
   * Deployment env document this host was started with. The build hashes the same
   * document, so the env axis stays comparable across build and startup.
   */
  declaredEnv: DeclaredDeploymentEnv;
}): Promise<ReleaseManifestV1> {
  const manifest = parseReleaseManifest(JSON.parse(
    await readFile(input.manifestPath, "utf8"),
  ) as unknown);
  const runnerArtifactHash = await hashArtifactSet(input.runnerArtifactDirectory);
  const current: ReleaseManifestBuildInput = {
    sourceCommit: manifest.source_commit,
    hostBundleHash: await hashReleaseFileSet(
      input.hostBundleDirectory,
      HOST_RELEASE_ARTIFACTS,
    ),
    runnerReleaseId: runnerArtifactHash,
    runnerArtifactHash,
    schemaGeneration: manifest.schema_generation,
    wireGeneration: manifest.wire_generation,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    deploymentEnvIdentity: deploymentEnvIdentity(input.env, input.declaredEnv),
    claudeExecutable: await executableIdentity(
      "claude",
      declaredExecutablePath(input.declaredEnv, "claude"),
    ),
    codexExecutable: await executableIdentity(
      "codex",
      declaredExecutablePath(input.declaredEnv, "codex"),
    ),
    ...(manifest.model_catalog_path === undefined
      ? {}
      : { modelCatalogPath: manifest.model_catalog_path }),
  };
  try {
    verifyReleaseManifest(manifest, current);
  } catch (error) {
    throw withRebuildHint(error);
  }
  return manifest;
}

/**
 * The manifest is written at build time from `.env.soul-server-ts` and the checkout, so a
 * source run that edited either afterwards fails here until it is rebuilt.
 */
function withRebuildHint(error: unknown): unknown {
  if (!(error instanceof Error) || !error.message.startsWith("release manifest mismatch")) {
    return error;
  }
  return new Error(
    `${error.message} (when running from source, rebuild after editing .env.soul-server-ts `
    + "or updating the checkout: pnpm --dir soul-server-ts build)",
    { cause: error },
  );
}

/**
 * Portable bind records the catalogue absolute path it was bound with; a
 * repository checkout derives it from the entry module location.
 */
export function modelCatalogPathForStartup(
  manifest: Pick<ReleaseManifestV1, "model_catalog_path">,
  entryUrl: string,
): string {
  return manifest.model_catalog_path
    ?? modelCatalogPathForRepository(repositoryRootFromEntryUrl(entryUrl));
}

export function parseReleaseManifest(value: unknown): ReleaseManifestV1 {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new Error("invalid ReleaseManifest v1");
  }
  const allowedKeys = [
    "schema_version", "manifest_id", "release_cohort_id", "source_commit",
    "host_bundle_hash", "runner_release_id", "runner_artifact_hash",
    "schema_generation", "wire_generation", "node",
    "deployment_env_identity", "executables",
    ...(value.model_catalog_path === undefined ? [] : ["model_catalog_path"]),
  ];
  requireExactKeys(value, allowedKeys, "ReleaseManifest v1");
  if (
    value.model_catalog_path !== undefined
    && (typeof value.model_catalog_path !== "string"
      || value.model_catalog_path.length === 0)
  ) {
    throw new Error("invalid ReleaseManifest v1 field: model_catalog_path");
  }
  for (const key of [
    "manifest_id",
    "release_cohort_id",
    "source_commit",
    "host_bundle_hash",
    "runner_release_id",
    "runner_artifact_hash",
    "schema_generation",
    "wire_generation",
    "deployment_env_identity",
  ] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`invalid ReleaseManifest v1 field: ${key}`);
    }
  }
  if (!isRecord(value.node)
    || typeof value.node.version !== "string"
    || typeof value.node.platform !== "string"
    || typeof value.node.arch !== "string") {
    throw new Error("invalid ReleaseManifest v1 node identity");
  }
  requireExactKeys(value.node, ["version", "platform", "arch"], "ReleaseManifest v1 node");
  if (!isRecord(value.executables)
    || !validExecutable(value.executables.claude, "claude")
    || !validExecutable(value.executables.codex, "codex")) {
    throw new Error("invalid ReleaseManifest v1 executable identity");
  }
  requireExactKeys(value.executables, ["claude", "codex"], "ReleaseManifest v1 executables");
  requireExactKeys(
    value.executables.claude as Record<string, unknown>,
    ["kind", "path", "identity"],
    "ReleaseManifest v1 Claude executable",
  );
  requireExactKeys(
    value.executables.codex as Record<string, unknown>,
    ["kind", "path", "identity"],
    "ReleaseManifest v1 Codex executable",
  );
  return value as unknown as ReleaseManifestV1;
}

function validExecutable(value: unknown, kind: "claude" | "codex"): boolean {
  return isRecord(value)
    && value.kind === kind
    && (typeof value.path === "string" || value.path === null)
    && (typeof value.identity === "string" || value.identity === null);
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !expected.has(key))) {
    throw new Error(`${field} has invalid fields`);
  }
}
