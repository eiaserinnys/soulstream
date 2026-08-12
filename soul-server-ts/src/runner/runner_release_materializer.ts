import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { renameWithTransientRetry } from "../atomic_file_rename.js";

const READY_MARKER = ".runner-release.json";
const HASH_DOMAIN = "soulstream.runner.release.v1\0";

/**
 * Complete runtime-owned file set for a runner release. Claude and Codex CLI
 * executables remain external process dependencies; JavaScript dependencies
 * are bundled into runner_entry.js and node:sqlite is built into Node.
 */
export const RUNNER_RELEASE_ARTIFACTS = [
  "package.json",
  "runner_entry.js",
] as const;

export interface RunnerReleaseDescriptor {
  /** Opaque release identity. The current materializer uses an artifact content hash. */
  releaseId: string;
  releaseRoot: string;
  runnerModuleRoot: string;
}

export interface RunnerReleaseMaterializer {
  resolveCurrentReleaseId(): Promise<string>;
  materialize(release: RunnerReleaseDescriptor, stagingPath: string): Promise<void>;
  verify(release: RunnerReleaseDescriptor): Promise<void>;
  remove(release: RunnerReleaseDescriptor): Promise<void>;
}

interface RunnerReleaseMarker {
  schemaVersion: 1;
  releaseId: string;
  hashAlgorithm: "sha256";
  artifacts: readonly string[];
}

/**
 * Materializes an immutable release from the already-built runner bundle.
 * Git, package installation, and building are deliberately outside this
 * boundary. A future manifest/copy source can replace this implementation
 * without changing spawn, bootstrap, or GC.
 */
export class BuildArtifactReleaseMaterializer implements RunnerReleaseMaterializer {
  constructor(private readonly artifactDirectory: string) {
    if (!artifactDirectory) throw new Error("runner artifact directory required");
  }

  async resolveCurrentReleaseId(): Promise<string> {
    return await hashArtifactSet(this.artifactDirectory);
  }

  async materialize(release: RunnerReleaseDescriptor, stagingPath: string): Promise<void> {
    const sourceReleaseId = await this.resolveCurrentReleaseId();
    if (sourceReleaseId !== release.releaseId) {
      throw new Error(
        `runner build artifacts changed before snapshot: expected ${release.releaseId}, got ${sourceReleaseId}`,
      );
    }

    await mkdir(dirname(stagingPath), { recursive: true });
    await rm(stagingPath, { recursive: true, force: true });
    await mkdir(stagingPath, { recursive: true, mode: 0o755 });
    let published = false;
    try {
      for (const relativePath of RUNNER_RELEASE_ARTIFACTS) {
        await copyFile(
          join(this.artifactDirectory, relativePath),
          join(stagingPath, relativePath),
        );
      }
      const stagedReleaseId = await hashArtifactSet(stagingPath);
      if (stagedReleaseId !== release.releaseId) {
        throw new Error(
          `runner snapshot hash mismatch: expected ${release.releaseId}, got ${stagedReleaseId}`,
        );
      }
      const marker: RunnerReleaseMarker = {
        schemaVersion: 1,
        releaseId: release.releaseId,
        hashAlgorithm: "sha256",
        artifacts: [...RUNNER_RELEASE_ARTIFACTS],
      };
      await writeFile(join(stagingPath, READY_MARKER), `${JSON.stringify(marker)}\n`, {
        mode: 0o444,
      });
      await mkdir(dirname(release.releaseRoot), { recursive: true });
      await renameWithTransientRetry(stagingPath, release.releaseRoot);
      published = true;
      await makeReleaseReadOnly(release.releaseRoot);
    } catch (error) {
      const failedPath = published ? release.releaseRoot : stagingPath;
      await makeReleaseWritable(failedPath).catch(() => undefined);
      await rm(failedPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async verify(release: RunnerReleaseDescriptor): Promise<void> {
    const marker = parseMarker(await readFile(join(release.releaseRoot, READY_MARKER), "utf8"));
    if (marker.releaseId !== release.releaseId) {
      throw new Error(`runner release marker mismatch: ${release.releaseId}`);
    }
    const releaseId = await hashArtifactSet(release.runnerModuleRoot);
    if (releaseId !== release.releaseId) {
      throw new Error(`runner release content mismatch: ${release.releaseId}`);
    }
    // Idempotently finish a publish interrupted after atomic rename but before
    // permission hardening. Content is verified before any directory is trusted.
    await makeReleaseReadOnly(release.releaseRoot);
  }

  async remove(release: RunnerReleaseDescriptor): Promise<void> {
    await makeReleaseWritable(release.releaseRoot);
    await rm(release.releaseRoot, { recursive: true, force: true });
  }
}

export async function hashArtifactSet(directory: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(HASH_DOMAIN);
  for (const relativePath of [...RUNNER_RELEASE_ARTIFACTS].sort()) {
    const absolutePath = join(directory, relativePath);
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) {
      throw new Error(`runner release artifact is not a regular file: ${relativePath}`);
    }
    const contents = await readFile(absolutePath);
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(String(contents.byteLength), "utf8");
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return `sha256-${hash.digest("hex")}`;
}

function parseMarker(raw: string): RunnerReleaseMarker {
  const value = JSON.parse(raw) as Partial<RunnerReleaseMarker>;
  if (
    value.schemaVersion !== 1
    || typeof value.releaseId !== "string"
    || value.hashAlgorithm !== "sha256"
    || !Array.isArray(value.artifacts)
    || value.artifacts.length !== RUNNER_RELEASE_ARTIFACTS.length
    || !RUNNER_RELEASE_ARTIFACTS.every((entry, index) => value.artifacts?.[index] === entry)
  ) {
    throw new Error("invalid runner release marker");
  }
  return value as RunnerReleaseMarker;
}

async function makeReleaseReadOnly(root: string): Promise<void> {
  for (const relativePath of [...RUNNER_RELEASE_ARTIFACTS, READY_MARKER]) {
    await chmod(join(root, relativePath), 0o444);
  }
  await chmod(root, 0o555);
}

async function makeReleaseWritable(root: string): Promise<void> {
  try {
    await chmod(root, 0o755);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
