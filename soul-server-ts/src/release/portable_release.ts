import { readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";

import { RUNNER_RELEASE_ARTIFACTS } from "../runner/runner_release_materializer.js";
import { HOST_RELEASE_ARTIFACTS } from "./release_artifacts.js";
import { sha256Digest } from "./release_generations.js";

export const PORTABLE_RELEASE_SCHEMA_VERSION = 1;
export const PORTABLE_RELEASE_METADATA_FILE = "portable-release.json";
export const PORTABLE_BIND_SCRIPT_FILE = "bind-release.mjs";
export const PORTABLE_RUNNER_DIRECTORY = "runner";

/**
 * Node-local files a bound release directory holds beside the payload: the
 * metadata document that produced it, the manifest bind writes, and the
 * deployment env document the service loads from its working directory.
 * Everything else in the directory must be declared in the payload file list.
 */
const BOUND_RELEASE_EXTRA_FILES: readonly string[] = [
  PORTABLE_RELEASE_METADATA_FILE,
  "release-manifest.json",
  ".env.soul-server-ts",
];

const SHA256_PATTERN = /^sha256-[0-9a-f]{64}$/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

export interface PortableReleaseFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface PortableReleaseMetadata {
  readonly schema_version: typeof PORTABLE_RELEASE_SCHEMA_VERSION;
  readonly source_commit: string;
  readonly schema_generation: string;
  readonly wire_generation: string;
  readonly files: readonly PortableReleaseFile[];
}

export interface PortableReleasePayloadSummary {
  readonly fileCount: number;
  readonly totalBytes: number;
}

export function parsePortableReleaseMetadata(value: unknown): PortableReleaseMetadata {
  if (!isRecord(value) || value.schema_version !== PORTABLE_RELEASE_SCHEMA_VERSION) {
    throw new Error("invalid portable release metadata v1");
  }
  requireExactKeys(value, [
    "schema_version",
    "source_commit",
    "schema_generation",
    "wire_generation",
    "files",
  ], "portable release metadata v1");
  const sourceCommit = requiredMetadataString(value, "source_commit");
  const schemaGeneration = requiredMetadataString(value, "schema_generation");
  const wireGeneration = requiredMetadataString(value, "wire_generation");
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("portable release metadata has no files");
  }
  const seen = new Set<string>();
  const files: PortableReleaseFile[] = value.files.map((entry) => {
    if (!isRecord(entry)) throw new Error("invalid portable release file entry");
    requireExactKeys(entry, ["path", "sha256", "size"], "portable release file entry");
    const path = payloadPath(entry.path);
    if (seen.has(path)) throw new Error(`duplicate portable release file: ${path}`);
    seen.add(path);
    if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
      throw new Error(`invalid portable release file digest: ${path}`);
    }
    if (typeof entry.size !== "number" || !Number.isInteger(entry.size) || entry.size < 0) {
      throw new Error(`invalid portable release file size: ${path}`);
    }
    return { path, sha256: entry.sha256, size: entry.size };
  });
  return {
    schema_version: PORTABLE_RELEASE_SCHEMA_VERSION,
    source_commit: sourceCommit,
    schema_generation: schemaGeneration,
    wire_generation: wireGeneration,
    files,
  };
}

/**
 * Verifies the whole payload against its metadata before anything is bound:
 * every listed file must exist with the declared size and digest, and the
 * directory must hold nothing undeclared. Returns the verified size summary.
 */
export async function verifyPortableReleasePayload(
  directory: string,
  metadata: PortableReleaseMetadata,
): Promise<PortableReleasePayloadSummary> {
  const listed = new Map(metadata.files.map((file) => [file.path, file]));
  const requiredFiles = [
    ...HOST_RELEASE_ARTIFACTS,
    ...RUNNER_RELEASE_ARTIFACTS.map(
      (artifact) => `${PORTABLE_RUNNER_DIRECTORY}/${artifact}`,
    ),
    PORTABLE_BIND_SCRIPT_FILE,
  ];
  for (const required of requiredFiles) {
    if (!listed.has(required)) {
      throw new Error(`portable release payload does not list required file: ${required}`);
    }
  }
  let totalBytes = 0;
  for (const file of metadata.files) {
    const contents = await readPayloadFile(directory, file.path);
    if (contents.byteLength !== file.size) {
      throw new Error(`portable release file size mismatch: ${file.path}`);
    }
    if (sha256Digest(contents) !== file.sha256) {
      throw new Error(`portable release file hash mismatch: ${file.path}`);
    }
    totalBytes += file.size;
  }
  for (const relativePath of await listPortablePayloadFiles(directory)) {
    if (!listed.has(relativePath) && !BOUND_RELEASE_EXTRA_FILES.includes(relativePath)) {
      throw new Error(`portable release payload has unlisted file: ${relativePath}`);
    }
  }
  return { fileCount: metadata.files.length, totalBytes };
}

/** Every regular file under the payload root, as sorted POSIX-style relative paths. */
export async function listPortablePayloadFiles(
  directory: string,
  prefix = "",
): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listPortablePayloadFiles(directory, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function readPayloadFile(directory: string, relativePath: string): Promise<Buffer> {
  try {
    return await readFile(join(directory, ...relativePath.split("/")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`portable release payload is missing file: ${relativePath}`);
    }
    throw error;
  }
}

function payloadPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid portable release file path");
  }
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/")
    || WINDOWS_DRIVE_PATTERN.test(value)) {
    throw new Error(`invalid portable release file path: ${value}`);
  }
  // Rejects ".", "./a", "a/../b", "a//b", "a/" — every form that leaves the
  // spelled path different from the path the verifier would read.
  if (value === "." || value.startsWith("../") || posix.normalize(value) !== value) {
    throw new Error(`invalid portable release file path: ${value}`);
  }
  return value;
}

function requiredMetadataString(record: Record<string, unknown>, key: string): string {
  const raw = record[key];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`invalid portable release metadata field: ${key}`);
  }
  return raw;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`invalid ${label} keys: ${actual.join(", ")}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
