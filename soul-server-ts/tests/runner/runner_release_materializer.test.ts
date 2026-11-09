import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BuildArtifactReleaseMaterializer,
  hashArtifactSet,
  RUNNER_RELEASE_ARTIFACTS,
} from "../../src/runner/runner_release_materializer.js";
import { RunnerReleasePool } from "../../src/runner/runner_release_pool.js";

const LEGACY_ARTIFACTS = ["package.json", "runner_entry.js"] as const;

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmod(directory, 0o755).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

describe("BuildArtifactReleaseMaterializer", () => {
  it("checks only the ready marker without reading release artifacts", async () => {
    const releases = await temporaryDirectory("runner-releases-");
    const releaseRoot = join(releases, "release-marker-only");
    await mkdir(releaseRoot, { recursive: true });
    const release = {
      releaseId: "release-marker-only",
      releaseRoot,
      runnerModuleRoot: releaseRoot,
    };
    await writeFile(join(releaseRoot, ".runner-release.json"), `${JSON.stringify({
      schemaVersion: 1,
      releaseId: release.releaseId,
      hashAlgorithm: "sha256",
      artifacts: [...LEGACY_ARTIFACTS],
    })}\n`);
    const materializer = new BuildArtifactReleaseMaterializer(
      await temporaryDirectory("runner-artifacts-"),
    );

    await expect(materializer.checkReadyMarker(release)).resolves.toBeUndefined();
    await expect(materializer.verify(release)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives release_id from the ordered runtime artifact set including the helper scripts", async () => {
    const first = await artifactDirectory("export const version = 1;\n");
    const second = await artifactDirectory("export const version = 1;\n");
    await writeFile(join(first, "not-runtime.map"), "ignored-a");
    await writeFile(join(second, "not-runtime.map"), "ignored-b");

    expect([...RUNNER_RELEASE_ARTIFACTS]).toEqual([
      "package.json",
      "runner_entry.js",
      "session-netns-helper.py",
      "session_netns_network.py",
    ]);
    expect(await hashArtifactSet(first)).toBe(await hashArtifactSet(second));
    expect(await hashArtifactSet(first)).toMatch(/^sha256-[a-f0-9]{64}$/);

    await writeFile(join(second, "runner_entry.js"), "export const version = 2;\n");
    expect(await hashArtifactSet(first)).not.toBe(await hashArtifactSet(second));

    await writeFile(join(second, "session-netns-helper.py"), "# helper changed\n");
    expect(await hashArtifactSet(first)).not.toBe(await hashArtifactSet(second));
  });

  it("copies every runtime artifact, publishes atomically, and makes them read-only", async () => {
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
    expect(await readFile(join(release.releaseRoot, "session_netns_network.py"), "utf8"))
      .toBe("# network helper\n");
    await expect(readFile(join(release.releaseRoot, "debug.map"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const releaseMode = (await stat(release.releaseRoot)).mode & 0o777;
    const entryMode = (await stat(join(release.releaseRoot, "runner_entry.js"))).mode & 0o777;
    const packageMode = (await stat(join(release.releaseRoot, "package.json"))).mode & 0o777;
    const networkMode = (await stat(join(release.releaseRoot, "session_netns_network.py"))).mode & 0o777;
    const helperMode = (await stat(join(release.releaseRoot, "session-netns-helper.py"))).mode & 0o777;
    if (process.platform === "win32") {
      for (const mode of [releaseMode, entryMode, packageMode, networkMode, helperMode]) {
        expect(mode & 0o222).toBe(0);
      }
    } else {
      expect(releaseMode).toBe(0o555);
      expect(entryMode).toBe(0o444);
      expect(packageMode).toBe(0o444);
      expect(networkMode).toBe(0o444);
      expect(helperMode).toBe(0o555);
    }
    await materializer.remove(release);
  });

  it("accepts a legacy two-artifact release and verifies it with its own artifact list", async () => {
    const releases = await temporaryDirectory("runner-releases-");
    const materializer = new BuildArtifactReleaseMaterializer(
      await temporaryDirectory("runner-artifacts-"),
    );
    const staging = join(releases, "legacy-release");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(staging, "runner_entry.js"), "export const legacy = true;\n");
    const releaseId = await hashArtifactSet(staging, LEGACY_ARTIFACTS);
    const releaseRoot = join(releases, releaseId);
    await rename(staging, releaseRoot);
    await writeFile(join(releaseRoot, ".runner-release.json"), `${JSON.stringify({
      schemaVersion: 1,
      releaseId,
      hashAlgorithm: "sha256",
      artifacts: [...LEGACY_ARTIFACTS],
    })}\n`);
    const release = new RunnerReleasePool(releases, materializer).describe(releaseId);

    await expect(materializer.checkReadyMarker(release)).resolves.toBeUndefined();
    await expect(materializer.verify(release)).resolves.toBeUndefined();

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

  it("rejects a ready marker whose artifact list is not a known runtime set", async () => {
    const releases = await temporaryDirectory("runner-releases-");
    const releaseRoot = join(releases, "unknown-list");
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(join(releaseRoot, ".runner-release.json"), `${JSON.stringify({
      schemaVersion: 1,
      releaseId: "unknown-list",
      hashAlgorithm: "sha256",
      artifacts: ["package.json", "other.js"],
    })}\n`);
    const release = {
      releaseId: "unknown-list",
      releaseRoot,
      runnerModuleRoot: releaseRoot,
    };
    const materializer = new BuildArtifactReleaseMaterializer(
      await temporaryDirectory("runner-artifacts-"),
    );

    await expect(materializer.checkReadyMarker(release)).rejects.toThrow(
      "invalid runner release marker",
    );
    await expect(materializer.verify(release)).rejects.toThrow(
      "invalid runner release marker",
    );
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
  await writeFile(join(directory, "session-netns-helper.py"), "#!/usr/bin/env python3\n");
  await writeFile(join(directory, "session_netns_network.py"), "# network helper\n");
  return directory;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
