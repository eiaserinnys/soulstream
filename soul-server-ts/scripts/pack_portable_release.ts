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
  assertCleanSourceTree,
  assertCommitHash,
  readSourceCommit,
} from "../src/release/portable_pack_source.js";
import {
  migrationSchemaGeneration,
  sha256Digest,
  wireSchemaGeneration,
} from "../src/release/release_generations.js";
import { HOST_RELEASE_ARTIFACTS } from "../src/release/release_artifacts.js";
import { RUNNER_RELEASE_ARTIFACTS } from "../src/runner/runner_release_materializer.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..");
const options = parseOptions(process.argv.slice(2));
const outRoot = resolve(
  options.out ?? join(packageRoot, "dist-portable-release"),
);
const portableDist = join(packageRoot, "dist-portable");
const runnerDist = join(packageRoot, "dist", "runner");

/** Files the portable tsup build must have produced before a payload can be packed. */
const PORTABLE_BUILD_ENTRIES = [...HOST_RELEASE_ARTIFACTS, PORTABLE_BIND_SCRIPT_FILE];

/**
 * The payload is labelled with `source_commit` and startup trusts that label,
 * so the bytes in it must be exactly that commit: refuse to pack a dirty tree,
 * rebuild both artifact sets inside the pack instead of shipping whatever was
 * left in dist/, and prove the tree is still that commit before tarballing.
 */
await main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function main(): Promise<void> {
  assertCleanSourceTree(repositoryRoot);
  const packedCommit = readSourceCommit(repositoryRoot);

  runPackageScript("build");
  runPackageScript("build:portable");

  assertCleanSourceTree(repositoryRoot);
  const headAfterBuild = readSourceCommit(repositoryRoot);
  if (headAfterBuild !== packedCommit) {
    fail(`HEAD moved during the pack build (${packedCommit} -> ${headAfterBuild})`);
  }
  await assertFileSet(portableDist, PORTABLE_BUILD_ENTRIES, "dist-portable");
  await assertFileSet(runnerDist, RUNNER_RELEASE_ARTIFACTS, "dist/runner");

  const summary = await packPayload(assertCommitHash(packedCommit));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function packPayload(sourceCommit: string): Promise<Record<string, unknown>> {
  const releaseDirectory = join(outRoot, sourceCommit);
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
        throw new Error(`${label}/${relativePath} is missing after the pack build`);
      }
      throw error;
    }
  }
}

function runPackageScript(name: string): void {
  process.stderr.write(`pack-portable: npm run ${name}\n`);
  execFileSync("npm", ["run", name], { cwd: packageRoot, stdio: "inherit" });
}

function parseOptions(argv: string[]): { out?: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (name !== "--out") fail(`unknown argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${name} requires a value`);
    values.set(name, value);
  }
  return { out: values.get("--out") };
}

function fail(message: string): never {
  process.stderr.write(`pack-portable: ${message}\n`);
  process.exit(1);
}
