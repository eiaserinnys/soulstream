import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ReleaseExecutableIdentity } from "./release_manifest.js";

const FILE_SET_DOMAIN = "soulstream.release.file-set.v1\0";
const EXECUTABLE_DOMAIN = "soulstream.release.executable.v1\0";

export const HOST_RELEASE_ARTIFACTS = [
  "main.js",
  "runner/runner_release_prewarm.js",
  "upstream/control_inbox_worker_entry.js",
] as const;

export async function hashReleaseFileSet(
  directory: string,
  relativePaths: readonly string[],
): Promise<string> {
  const hash = createHash("sha256").update(FILE_SET_DOMAIN);
  for (const relativePath of [...relativePaths].sort()) {
    const absolutePath = join(directory, relativePath);
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) throw new Error(`release artifact is not a regular file: ${relativePath}`);
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

export async function executableIdentity(
  kind: ReleaseExecutableIdentity["kind"],
  path: string | undefined,
): Promise<ReleaseExecutableIdentity> {
  if (!path) return { kind, path: null, identity: null };
  const resolvedPath = await realpath(path);
  const metadata = await stat(resolvedPath);
  if (!metadata.isFile()) throw new Error(`${kind} executable is not a regular file: ${resolvedPath}`);
  const hash = createHash("sha256").update(EXECUTABLE_DOMAIN);
  hash.update(kind, "utf8");
  hash.update("\0");
  hash.update(await readFile(resolvedPath));
  return {
    kind,
    path: resolvedPath,
    identity: `sha256-${hash.digest("hex")}`,
  };
}
