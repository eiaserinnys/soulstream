import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeFileAtomically } from "../atomic_file_rename.js";
import { parseEnv } from "../config.js";
import { hashArtifactSet } from "../runner/runner_release_materializer.js";
import { readDeclaredEnvDocument } from "./declared_env_document.js";
import {
  HOST_RELEASE_ARTIFACTS,
  executableIdentity,
  hashReleaseFileSet,
} from "./release_artifacts.js";
import {
  declaredExecutablePath,
  deploymentEnvIdentity,
} from "./release_env.js";
import {
  buildReleaseManifest,
  canonicalJson,
  type CanonicalJsonValue,
  type ReleaseManifestV1,
} from "./release_manifest.js";
import {
  PORTABLE_RELEASE_METADATA_FILE,
  PORTABLE_RUNNER_DIRECTORY,
  parsePortableReleaseMetadata,
  verifyPortableReleasePayload,
  type PortableReleaseMetadata,
} from "./portable_release.js";

/**
 * The runtime looks for the manifest at `join(dirname(main.js), "release-manifest.json")`
 * (main.ts). bind writes exactly there: the unpacked payload directory is the release root.
 */
export const RELEASE_MANIFEST_FILE = "release-manifest.json";

export interface BindPortableReleaseInput {
  readonly releaseDirectory: string;
  readonly envFile: string;
}

export interface BindPortableReleaseResult {
  readonly manifest: ReleaseManifestV1;
  readonly manifestPath: string;
  readonly metadata: PortableReleaseMetadata;
  readonly envDocumentPresent: boolean;
}

/**
 * Turns a platform-agnostic payload into a node-local release: verify every
 * payload byte against `portable-release.json`, then write the ReleaseManifestV1
 * this node will start with. `source_commit`, `schema_generation`, and
 * `wire_generation` come from the metadata only; node identity, env identity,
 * and executable identities are read from this host and its env document, using
 * the same code the build-side writer and the startup verifier use.
 */
export async function bindPortableRelease(
  input: BindPortableReleaseInput,
): Promise<BindPortableReleaseResult> {
  const releaseDirectory = resolve(input.releaseDirectory);
  const metadata = parsePortableReleaseMetadata(JSON.parse(
    await readFile(join(releaseDirectory, PORTABLE_RELEASE_METADATA_FILE), "utf8"),
  ) as unknown);
  // Verify first: a payload that does not match its own metadata must not become
  // a runnable release, so no manifest is written before this passes.
  await verifyPortableReleasePayload(releaseDirectory, metadata);

  const { declared, present } = await readDeclaredEnvDocument(resolve(input.envFile));
  const env = parseEnv({ ...process.env, ...declared });
  const runnerArtifactDirectory = join(releaseDirectory, PORTABLE_RUNNER_DIRECTORY);
  const runnerArtifactHash = await hashArtifactSet(runnerArtifactDirectory);
  const manifest = buildReleaseManifest({
    sourceCommit: metadata.source_commit,
    hostBundleHash: await hashReleaseFileSet(releaseDirectory, HOST_RELEASE_ARTIFACTS),
    runnerReleaseId: runnerArtifactHash,
    runnerArtifactHash,
    schemaGeneration: metadata.schema_generation,
    wireGeneration: metadata.wire_generation,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    deploymentEnvIdentity: deploymentEnvIdentity(env, declared),
    claudeExecutable: await executableIdentity(
      "claude",
      declaredExecutablePath(declared, "claude"),
    ),
    codexExecutable: await executableIdentity(
      "codex",
      declaredExecutablePath(declared, "codex"),
    ),
  });
  const manifestPath = join(releaseDirectory, RELEASE_MANIFEST_FILE);
  await writeFileAtomically(
    manifestPath,
    canonicalJson(manifest as unknown as CanonicalJsonValue),
  );
  return { manifest, manifestPath, metadata, envDocumentPresent: present };
}
