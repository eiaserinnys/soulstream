import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { parseEnv } from "../../src/config.js";
import {
  RELEASE_MANIFEST_FILE,
  bindErrorLines,
  bindPortableRelease,
} from "../../src/release/bind_release.js";
import {
  PORTABLE_RELEASE_METADATA_FILE,
  parsePortableReleaseMetadata,
  type PortableReleaseMetadata,
} from "../../src/release/portable_release.js";
import { sha256Digest } from "../../src/release/release_generations.js";
import { loadAndVerifyReleaseManifest } from "../../src/release/release_runtime.js";
import { RUNNER_RELEASE_ARTIFACTS } from "../../src/runner/runner_release_materializer.js";

/** Same declared document the build-side and startup-side identity tests use. */
const DECLARED_ENV = {
  SOULSTREAM_NODE_ID: "portable-release-test",
  SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:5200/ws/node",
  EVENT_OUTBOX_DIR: ".local/event-outbox",
  AGENTS_CONFIG_PATH: "config/agents.yaml",
  AGENT_COMMON_FILES_DIR: "common-files",
  PORT: "4205",
  MCP_ALLOWED_HOSTS: "localhost,127.0.0.1",
} as const;

/** Ambient machine state the live service carries and the payload never declares. */
const LIVE_SERVICE_AMBIENT: NodeJS.ProcessEnv = {
  HOME: "/home/eias",
  PATH: "/home/eias/.codex/tmp/arg0/codex-arg0yoEWax:/usr/bin:/bin",
  PATHEXT: ".COM;.EXE",
  JWT_SECRET: "runtime-injected",
  CLAUDE_CODE_EXECPATH: "/runtime/claude",
};

/**
 * A payload that contains everything the runtime hashes or imports. The runner
 * entries come from the materializer's canonical artifact list, so adding an
 * artifact there cannot leave this fixture silently out of date.
 */
const PAYLOAD_FILES: Readonly<Record<string, string>> = {
  "main.js": "// host bundle\n",
  "chunks/vendor.js": "// vendor chunk\n",
  "runner/runner_release_prewarm.js": "// prewarm\n",
  "upstream/control_inbox_worker_entry.js": "// control\n",
  "bind-release.mjs": "// bind\n",
  "package.json": '{"type":"module"}\n',
  ...Object.fromEntries(RUNNER_RELEASE_ARTIFACTS.map((artifact) => [
    `runner/${artifact}`,
    artifact === "package.json" ? '{"type":"module"}\n' : `// ${artifact}\n`,
  ])),
};

const SOURCE_COMMIT = "70b09abd03d38c9fa120508be22542bf0ef88d2a";
const SCHEMA_GENERATION = "070:sha256-schema";
const WIRE_GENERATION = "sha256-wire";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("portable release metadata", () => {
  it("rejects documents that are not the v1 file list", () => {
    const valid = metadataFor({ "main.js": "// main\n" });
    expect(() => parsePortableReleaseMetadata({ ...valid, schema_version: 2 }))
      .toThrow(/invalid portable release metadata v1/);
    expect(() => parsePortableReleaseMetadata({ ...valid, extra: true }))
      .toThrow(/keys/);
    expect(() => parsePortableReleaseMetadata({ ...valid, files: [] }))
      .toThrow(/no files/);
    expect(() => parsePortableReleaseMetadata({ ...valid, source_commit: "" }))
      .toThrow(/source_commit/);
    expect(() => parsePortableReleaseMetadata({
      ...valid,
      files: [{ path: "main.js", sha256: "sha256-not-a-digest", size: 1 }],
    })).toThrow(/digest/);
  });

  it("rejects paths that would read outside the release directory", () => {
    for (const path of ["../main.js", "/etc/passwd", "a/../../b.js", "./main.js", "a//b.js", "a\\b.js", "C:/x.js"]) {
      expect(() => parsePortableReleaseMetadata({
        schema_version: 1,
        source_commit: SOURCE_COMMIT,
        schema_generation: SCHEMA_GENERATION,
        wire_generation: WIRE_GENERATION,
        files: [{ path, sha256: sha256Digest("x"), size: 1 }],
      })).toThrow(/path/);
    }
  });

  it("rejects a payload that lists the same file twice", () => {
    const entry = { path: "main.js", sha256: sha256Digest("x"), size: 1 };
    expect(() => parsePortableReleaseMetadata({
      schema_version: 1,
      source_commit: SOURCE_COMMIT,
      schema_generation: SCHEMA_GENERATION,
      wire_generation: WIRE_GENERATION,
      files: [entry, entry],
    })).toThrow(/duplicate/);
  });
});

describe("bindPortableRelease", () => {
  it("binds a verified payload into a release the runtime accepts", async () => {
    const releaseDirectory = await createReleaseDirectory();
    const envFile = join(releaseDirectory, ".env.soul-server-ts");
    await writeFile(envFile, envDocument(DECLARED_ENV), "utf8");

    const result = await bindPortableRelease({ releaseDirectory, envFile });

    // Source provenance and generations come from the metadata only.
    expect(result.manifest.source_commit).toBe(SOURCE_COMMIT);
    expect(result.manifest.schema_generation).toBe(SCHEMA_GENERATION);
    expect(result.manifest.wire_generation).toBe(WIRE_GENERATION);
    expect(result.manifestPath).toBe(join(releaseDirectory, RELEASE_MANIFEST_FILE));
    const written = await readFile(result.manifestPath, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(JSON.parse(written).manifest_id).toBe(result.manifest.manifest_id);

    // Startup verification, the same call main.ts makes, accepts the bound release.
    const verified = await loadAndVerifyReleaseManifest({
      manifestPath: result.manifestPath,
      hostBundleDirectory: releaseDirectory,
      runnerArtifactDirectory: join(releaseDirectory, "runner"),
      env: parseEnv({ ...LIVE_SERVICE_AMBIENT, ...DECLARED_ENV }),
      declaredEnv: { ...DECLARED_ENV },
    });
    expect(verified.manifest_id).toBe(result.manifest.manifest_id);
    expect(verified.executables.claude.path).toBeNull();
  });

  it("refuses to bind after any payload byte changed", async () => {
    const releaseDirectory = await createReleaseDirectory();
    const envFile = await writeEnvDocument(releaseDirectory);
    // Same length, different byte: only the digest can catch this.
    await writeFile(join(releaseDirectory, "main.js"), "// host bundlX\n", "utf8");

    await expect(bindPortableRelease({ releaseDirectory, envFile }))
      .rejects.toThrow(/portable release file hash mismatch: main\.js/);
    await expect(readFile(join(releaseDirectory, RELEASE_MANIFEST_FILE)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to bind a payload whose file is a symbolic link outside the release directory", async () => {
    const releaseDirectory = await createReleaseDirectory();
    const envFile = await writeEnvDocument(releaseDirectory);
    // Same bytes, different location: only the link itself can tell this apart.
    const outsideDirectory = await mkdtemp(join(tmpdir(), "portable-release-outside-"));
    temporaryDirectories.push(outsideDirectory);
    const outsideMain = join(outsideDirectory, "main.js");
    await writeFile(outsideMain, PAYLOAD_FILES["main.js"], "utf8");
    await rm(join(releaseDirectory, "main.js"));
    await symlink(outsideMain, join(releaseDirectory, "main.js"));

    await expect(bindPortableRelease({ releaseDirectory, envFile }))
      .rejects.toThrow(/contains a symbolic link: main\.js/);
    await expect(readFile(join(releaseDirectory, RELEASE_MANIFEST_FILE)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to bind a payload with a symbolic link in a parent path component", async () => {
    const releaseDirectory = await createReleaseDirectory();
    const envFile = await writeEnvDocument(releaseDirectory);
    const outsideDirectory = await mkdtemp(join(tmpdir(), "portable-release-outside-"));
    temporaryDirectories.push(outsideDirectory);
    await mkdir(join(outsideDirectory, "chunks"), { recursive: true });
    await writeFile(
      join(outsideDirectory, "chunks/vendor.js"),
      PAYLOAD_FILES["chunks/vendor.js"],
      "utf8",
    );
    await rm(join(releaseDirectory, "chunks"), { recursive: true, force: true });
    await symlink(join(outsideDirectory, "chunks"), join(releaseDirectory, "chunks"));

    await expect(bindPortableRelease({ releaseDirectory, envFile }))
      .rejects.toThrow(/contains a symbolic link: chunks/);
    await expect(readFile(join(releaseDirectory, RELEASE_MANIFEST_FILE)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to bind a payload with an undeclared file", async () => {
    const releaseDirectory = await createReleaseDirectory();
    const envFile = await writeEnvDocument(releaseDirectory);
    await writeFile(join(releaseDirectory, "stray.js"), "// stray\n", "utf8");

    await expect(bindPortableRelease({ releaseDirectory, envFile }))
      .rejects.toThrow(/unlisted file: stray\.js/);
  });

  it("refuses to bind a payload with a missing file", async () => {
    const releaseDirectory = await createReleaseDirectory();
    const envFile = await writeEnvDocument(releaseDirectory);
    await rm(join(releaseDirectory, "chunks/vendor.js"));

    await expect(bindPortableRelease({ releaseDirectory, envFile }))
      .rejects.toThrow(/missing file: chunks\/vendor\.js/);
  });

  it("refuses to bind a payload that does not declare the runtime entries", async () => {
    const releaseDirectory = await createReleaseDirectory();
    const envFile = await writeEnvDocument(releaseDirectory);
    const metadata = metadataFor(PAYLOAD_FILES);
    const withoutBindScript = {
      ...metadata,
      files: metadata.files.filter((file) => file.path !== "bind-release.mjs"),
    };
    await writeFile(
      join(releaseDirectory, PORTABLE_RELEASE_METADATA_FILE),
      JSON.stringify(withoutBindScript),
      "utf8",
    );

    await expect(bindPortableRelease({ releaseDirectory, envFile }))
      .rejects.toThrow(/does not list required file: bind-release\.mjs/);
  });

  it("still fails at startup when the env document changed after bind", async () => {
    const releaseDirectory = await createReleaseDirectory();
    const envFile = await writeEnvDocument(releaseDirectory);
    const result = await bindPortableRelease({ releaseDirectory, envFile });

    const drifted = { ...DECLARED_ENV, PORT: "4305" };
    await expect(loadAndVerifyReleaseManifest({
      manifestPath: result.manifestPath,
      hostBundleDirectory: releaseDirectory,
      runnerArtifactDirectory: join(releaseDirectory, "runner"),
      env: parseEnv({ ...LIVE_SERVICE_AMBIENT, ...drifted }),
      declaredEnv: drifted,
    })).rejects.toThrow(/release manifest mismatch: deployment_env_identity/);
  });
});

describe("bindErrorLines", () => {
  it("zod 오류는 이슈마다 path와 message를 한 줄씩 쓴다", async () => {
    const root = await mkdtemp(join(tmpdir(), "portable-bind-error-"));
    temporaryDirectories.push(root);
    let error: unknown;
    try {
      // The reported first-run failure: WORKTREE_PROJECTS_ROOT points at a folder nobody made.
      parseEnv({
        SOULSTREAM_NODE_ID: "portable-node",
        SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:5200/ws/node",
        EVENT_OUTBOX_DIR: join(root, "outbox"),
        WORKTREE_MCP_ENABLED: "true",
        WORKTREE_PROJECTS_ROOT: join(root, "missing-projects"),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ZodError);
    expect(bindErrorLines(error)).toEqual([
      "bind-release: WORKTREE_PROJECTS_ROOT: WORKTREE_PROJECTS_ROOT must be an absolute existing directory",
    ]);
  });

  it("그 밖의 오류는 메시지 첫 줄 하나로 쓴다", () => {
    expect(bindErrorLines(new Error("binding refused\nsecond line")))
      .toEqual(["bind-release: binding refused"]);
    expect(bindErrorLines("boom")).toEqual(["bind-release: boom"]);
  });
});

async function createReleaseDirectory(
  overrides: Readonly<Record<string, string>> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "portable-release-"));
  temporaryDirectories.push(root);
  const files = { ...PAYLOAD_FILES, ...overrides };
  for (const [relativePath, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await writeFile(join(root, relativePath), contents, "utf8");
  }
  await writeFile(
    join(root, PORTABLE_RELEASE_METADATA_FILE),
    JSON.stringify(metadataFor(files)),
    "utf8",
  );
  return root;
}

async function writeEnvDocument(directory: string): Promise<string> {
  const envFile = join(directory, ".env.soul-server-ts");
  await writeFile(envFile, envDocument(DECLARED_ENV), "utf8");
  return envFile;
}

function metadataFor(files: Readonly<Record<string, string>>): PortableReleaseMetadata {
  return {
    schema_version: 1,
    source_commit: SOURCE_COMMIT,
    schema_generation: SCHEMA_GENERATION,
    wire_generation: WIRE_GENERATION,
    files: Object.entries(files).map(([path, contents]) => ({
      path,
      sha256: sha256Digest(contents),
      size: Buffer.byteLength(contents),
    })),
  };
}

function envDocument(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}
