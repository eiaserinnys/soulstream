import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BuildArtifactReleaseMaterializer,
  hashArtifactSet,
} from "../../src/runner/runner_release_materializer.js";
import { RunnerReleasePool } from "../../src/runner/runner_release_pool.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmod(directory, 0o755).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

describe("BuildArtifactReleaseMaterializer", () => {
  it("derives release_id only from the ordered, explicit runtime artifact set", async () => {
    const first = await artifactDirectory("export const version = 1;\n");
    const second = await artifactDirectory("export const version = 1;\n");
    await writeFile(join(first, "not-runtime.map"), "ignored-a");
    await writeFile(join(second, "not-runtime.map"), "ignored-b");

    expect(await hashArtifactSet(first)).toBe(await hashArtifactSet(second));
    expect(await hashArtifactSet(first)).toMatch(/^sha256-[a-f0-9]{64}$/);

    await writeFile(join(second, "runner_entry.js"), "export const version = 2;\n");
    expect(await hashArtifactSet(first)).not.toBe(await hashArtifactSet(second));
  });

  it("copies only self-contained artifacts, publishes atomically, and makes them read-only", async () => {
    const artifacts = await artifactDirectory("export const ready = true;\n");
    await writeFile(join(artifacts, "debug.map"), "not copied");
    const releases = await temporaryDirectory("runner-releases-");
    const materializer = new BuildArtifactReleaseMaterializer(artifacts);
    const pool = new RunnerReleasePool(releases, materializer);
    const release = await pool.resolveCurrentRelease();

    await pool.ensureRelease(release);

    await expect(materializer.verify(release)).resolves.toBeUndefined();
    expect(await readFile(join(release.releaseRoot, "runner_entry.js"), "utf8"))
      .toBe("export const ready = true;\n");
    await expect(readFile(join(release.releaseRoot, "debug.map"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const releaseMode = (await stat(release.releaseRoot)).mode & 0o777;
    const entryMode = (await stat(join(release.releaseRoot, "runner_entry.js"))).mode & 0o777;
    if (process.platform === "win32") {
      expect(releaseMode & 0o222).toBe(0);
      expect(entryMode & 0o222).toBe(0);
    } else {
      expect(releaseMode).toBe(0o555);
      expect(entryMode).toBe(0o444);
    }
    await materializer.remove(release);
  });

  it("fails loudly if the build changes between release resolution and copy", async () => {
    const artifacts = await artifactDirectory("export const version = 1;\n");
    const releases = await temporaryDirectory("runner-releases-");
    const pool = new RunnerReleasePool(
      releases,
      new BuildArtifactReleaseMaterializer(artifacts),
    );
    const release = await pool.resolveCurrentRelease();
    await writeFile(join(artifacts, "runner_entry.js"), "export const version = 2;\n");

    await expect(pool.ensureRelease(release)).rejects.toThrow(
      "runner build artifacts changed before snapshot",
    );
    expect(await pool.listReadyReleases()).toEqual([]);
  });

  it("fails loudly when a required build artifact is absent", async () => {
    const artifacts = await temporaryDirectory("runner-artifacts-");
    await writeFile(join(artifacts, "package.json"), "{\"type\":\"module\"}\n");

    await expect(hashArtifactSet(artifacts)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function artifactDirectory(entry: string): Promise<string> {
  const directory = await temporaryDirectory("runner-artifacts-");
  await writeFile(join(directory, "package.json"), "{\"type\":\"module\"}\n");
  await writeFile(join(directory, "runner_entry.js"), entry);
  return directory;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
