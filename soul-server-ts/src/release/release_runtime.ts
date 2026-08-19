import { readFile } from "node:fs/promises";

import type { Env } from "../config.js";
import { hashArtifactSet } from "../runner/runner_release_materializer.js";
import { deploymentEnvIdentity } from "./release_env.js";
import {
  HOST_RELEASE_ARTIFACTS,
  executableIdentity,
  hashReleaseFileSet,
} from "./release_artifacts.js";
import {
  verifyReleaseManifest,
  type ReleaseManifestV1,
} from "./release_manifest.js";

export async function loadAndVerifyReleaseManifest(input: {
  manifestPath: string;
  hostBundleDirectory: string;
  runnerArtifactDirectory: string;
  env: Env;
  processEnv: NodeJS.ProcessEnv;
  runtimeCwd: string;
  claudeExecutablePath?: string;
  codexExecutablePath?: string;
}): Promise<ReleaseManifestV1> {
  const manifest = parseReleaseManifest(JSON.parse(
    await readFile(input.manifestPath, "utf8"),
  ) as unknown);
  const runnerArtifactHash = await hashArtifactSet(input.runnerArtifactDirectory);
  verifyReleaseManifest(manifest, {
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
    deploymentEnvIdentity: deploymentEnvIdentity(input.env, input.processEnv, {
      runtimeCwd: input.runtimeCwd,
    }),
    claudeExecutable: await executableIdentity("claude", input.claudeExecutablePath),
    codexExecutable: await executableIdentity("codex", input.codexExecutablePath),
  });
  return manifest;
}

export function parseReleaseManifest(value: unknown): ReleaseManifestV1 {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new Error("invalid ReleaseManifest v1");
  }
  requireExactKeys(value, [
    "schema_version", "manifest_id", "release_cohort_id", "source_commit",
    "host_bundle_hash", "runner_release_id", "runner_artifact_hash",
    "schema_generation", "wire_generation", "node",
    "deployment_env_identity", "executables",
  ], "ReleaseManifest v1");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
