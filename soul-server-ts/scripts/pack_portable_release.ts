import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PORTABLE_BIND_SCRIPT_FILE,
  PORTABLE_RELEASE_METADATA_FILE,
  PORTABLE_RELEASE_SCHEMA_VERSION,
  PORTABLE_RUNNER_DIRECTORY,
  listPortablePayloadFiles,
  parsePortableReleaseMetadata,
  verifyPortableReleasePayload,
  type PortableReleaseFile,
} from "../src/release/portable_release.js";
import {
  migrationSchemaGeneration,
  sha256Digest,
  wireSchemaGeneration,
} from "../src/release/release_generations.js";
import { HOST_RELEASE_ARTIFACTS } from "../src/release/release_artifacts.js";
import { RUNNER_RELEASE_ARTIFACTS } from "../src/runner/runner_release_materializer.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..");
const args = process.argv.slice(2);
const outRoot = resolve(
  optionValue(args, "--out") ?? join(packageRoot, "dist-portable-release"),
);
const explicitSourceCommit = optionValue(args, "--source-commit");
const sourceCommit = explicitSourceCommit ?? gitHead();
const portableDist = join(packageRoot, "dist-portable");
const runnerDist = join(packageRoot, "dist", "runner");

/** Files the portable tsup build must have produced before a payload can be packed. */
const PORTABLE_BUILD_ENTRIES = [...HOST_RELEASE_ARTIFACTS, PORTABLE_BIND_SCRIPT_FILE];

await assertFileSet(portableDist, PORTABLE_BUILD_ENTRIES, "dist-portable");
await assertFileSet(runnerDist, RUNNER_RELEASE_ARTIFACTS, "dist/runner");
if (!explicitSourceCommit) {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  if (status.length > 0) {
    process.stderr.write(
      "pack-portable: the source tree is dirty; the payload is labelled with git HEAD "
      + "but contains uncommitted work\n",
    );
  }
}

const summary = await packPayload();
process.stdout.write(`${JSON.stringify(summary)}\n`);

async function packPayload(): Promise<Record<string, unknown>> {
  const releaseDirectory = join(outRoot, sanitizeSourceCommit(sourceCommit));
  const payloadDirectory = join(releaseDirectory, ".payload");
  await mkdir(releaseDirectory, { recursive: true });
  await rm(payloadDirectory, { recursive: true, force: true });
  try {
    await cp(portableDist, payloadDirectory, { recursive: true });
    for (const artifact of RUNNER_RELEASE_ARTIFACTS) {
      await cp(
        join(runnerDist, artifact),
        join(payloadDirectory, PORTABLE_RUNNER_DIRECTORY, artifact),
      );
    }
    // The unpacked directory is a standalone ESM package: main.js and chunks/*.js
    // have no surrounding package.json to inherit "type" from.
    await writeFile(
      join(payloadDirectory, "package.json"),
      `${JSON.stringify({
        name: "soulstream-node-portable",
        private: true,
        type: "module",
      }, null, 2)}\n`,
      "utf8",
    );

    const files = await describePayloadFiles(payloadDirectory);
    await writeFile(
      join(payloadDirectory, PORTABLE_RELEASE_METADATA_FILE),
      `${JSON.stringify({
        schema_version: PORTABLE_RELEASE_SCHEMA_VERSION,
        source_commit: sourceCommit,
        schema_generation: migrationSchemaGeneration(await readFile(
          join(repositoryRoot, "packages/db-schema/migration-manifest.json"),
          "utf8",
        )),
        wire_generation: wireSchemaGeneration(await readFile(
          join(repositoryRoot, "packages/wire-schema/src/upstream.schema.json"),
        )),
        files,
      }, null, 2)}\n`,
      "utf8",
    );

    // The packer verifies its own output with the verifier the node will run.
    const metadata = parsePortableReleaseMetadata(JSON.parse(
      await readFile(join(payloadDirectory, PORTABLE_RELEASE_METADATA_FILE), "utf8"),
    ) as unknown);
    const verified = await verifyPortableReleasePayload(payloadDirectory, metadata);

    const tarballPath = join(releaseDirectory, "node.tar.gz");
    const tar = spawnSync("tar", ["-czf", tarballPath, "-C", payloadDirectory, "."], {
      encoding: "utf8",
    });
    if (tar.error) throw new Error(`tar failed to start: ${tar.error.message}`);
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr.trim()}`);
    const tarball = await readFile(tarballPath);
    const tarballSha256 = sha256Digest(tarball);
    await writeFile(
      `${tarballPath}.sha256`,
      `${tarballSha256.slice("sha256-".length)}  node.tar.gz\n`,
      "utf8",
    );
    return {
      source_commit: sourceCommit,
      tarball: tarballPath,
      sha256: tarballSha256,
      size: tarball.byteLength,
      files: verified.fileCount,
      payload_bytes: verified.totalBytes,
    };
  } finally {
    await rm(payloadDirectory, { recursive: true, force: true });
  }
}

async function describePayloadFiles(directory: string): Promise<PortableReleaseFile[]> {
  const files: PortableReleaseFile[] = [];
  for (const relativePath of await listPortablePayloadFiles(directory)) {
    const contents = await readFile(join(directory, ...relativePath.split("/")));
    files.push({
      path: relativePath,
      sha256: sha256Digest(contents),
      size: contents.byteLength,
    });
  }
  return files;
}

async function assertFileSet(
  directory: string,
  relativePaths: readonly string[],
  label: string,
): Promise<void> {
  for (const relativePath of relativePaths) {
    try {
      const metadata = await stat(join(directory, relativePath));
      if (!metadata.isFile()) throw new Error(`${label}/${relativePath} is not a file`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`${label}/${relativePath} is missing: run \`pnpm run build\` and `
          + "`pnpm run build:portable` first");
      }
      throw error;
    }
  }
}

function gitHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function sanitizeSourceCommit(value: string): string {
  if (!/^[0-9a-f]{7,64}$/.test(value)) {
    throw new Error(`--source-commit must be a git commit hash, got: ${value}`);
  }
  return value;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
