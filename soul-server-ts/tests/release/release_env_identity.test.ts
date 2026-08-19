import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseEnv } from "../../src/config.js";
import {
  declaredExecutablePath,
  deploymentEnvIdentity,
  deploymentIdentityKeys,
  releaseEnvAllowlistEntry,
  releaseEnvAllowlistKeys,
} from "../../src/release/release_env.js";
import { executableIdentity } from "../../src/release/release_artifacts.js";
import {
  buildReleaseManifest,
  canonicalJson,
  type ReleaseManifestBuildInput,
} from "../../src/release/release_manifest.js";
import { loadAndVerifyReleaseManifest } from "../../src/release/release_runtime.js";

/** The deployment env document both the build and the service read. */
const DECLARED_ENV = {
  SOULSTREAM_NODE_ID: "release-test",
  SOULSTREAM_UPSTREAM_URL: "ws://127.0.0.1:5200/ws/node",
  EVENT_OUTBOX_DIR: ".local/event-outbox",
  AGENTS_CONFIG_PATH: "config/agents.yaml",
  AGENT_COMMON_FILES_DIR: "common-files",
  PORT: "4205",
  MCP_ALLOWED_HOSTS: "localhost,127.0.0.1",
} as const;

/**
 * What `bin/build-soulstream.sh` gives the build: `env -i` plus a fixed PATH.
 * No credentials, no agent runtime paths, no Codex arg0 shims.
 */
const CLEAN_BUILD_AMBIENT: NodeJS.ProcessEnv = {
  HOME: "/home/eias",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  NODE_ENV: "production",
};

/**
 * What the live service actually has. PATH carries per-boot Codex arg0 shims, and
 * Haniel injects credentials and paths that the deployment document never declares.
 */
const LIVE_SERVICE_AMBIENT: NodeJS.ProcessEnv = {
  HOME: "/home/eias",
  PATH: "/home/eias/.codex/tmp/arg0/codex-arg0yoEWax:/home/eias/.npm-global/bin:/usr/bin:/bin",
  PATHEXT: ".COM;.EXE",
  APPDATA: "C:/Users/eias/AppData/Roaming",
  USERPROFILE: "C:/Users/eias",
  JWT_SECRET: "runtime-injected",
  GOOGLE_CLIENT_ID: "runtime-injected-client",
  DASH_USER_PORTRAIT: "/runtime/portrait.png",
  CLAUDE_CODE_EXECPATH: "/runtime/claude",
};

/** Mirrors the build: ambient first, declared document last. */
function buildSideIdentity(declared: Record<string, string> = { ...DECLARED_ENV }): string {
  return deploymentEnvIdentity(parseEnv({ ...CLEAN_BUILD_AMBIENT, ...declared }), declared);
}

/** Mirrors startup: dotenv loads the declared document over the live process env. */
function startupSideIdentity(
  declared: Record<string, string> = { ...DECLARED_ENV },
  ambient: NodeJS.ProcessEnv = LIVE_SERVICE_AMBIENT,
): string {
  return deploymentEnvIdentity(parseEnv({ ...ambient, ...declared }), declared);
}

describe("deployment env identity", () => {
  it("survives the clean build environment meeting the live service process env", () => {
    expect(startupSideIdentity()).toBe(buildSideIdentity());
  });

  it("ignores ambient machine state that changes on every boot", () => {
    const rebooted = startupSideIdentity({ ...DECLARED_ENV }, {
      ...LIVE_SERVICE_AMBIENT,
      PATH: "/home/eias/.codex/tmp/arg0/codex-arg0PVWtdS:/usr/bin",
      HOME: "/home/someone-else",
      APPDATA: "D:/Other/AppData",
      USERPROFILE: "D:/Other",
      PATHEXT: ".EXE",
    });

    expect(rebooted).toBe(buildSideIdentity());
  });

  it("ignores credentials that only the running service is given", () => {
    // JWT_SECRET is absent from the build environment and present at runtime.
    expect(startupSideIdentity()).toBe(buildSideIdentity());
    expect(LIVE_SERVICE_AMBIENT.JWT_SECRET).toBeDefined();
    expect(CLEAN_BUILD_AMBIENT.JWT_SECRET).toBeUndefined();
  });

  it("does not depend on the working directory the process happens to run in", () => {
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      const elsewhere = startupSideIdentity();
      process.chdir(original);
      expect(elsewhere).toBe(buildSideIdentity());
    } finally {
      process.chdir(original);
    }
  });

  it("still moves when the declared document itself changes", () => {
    const changed = buildSideIdentity({ ...DECLARED_ENV, AGENTS_CONFIG_PATH: "config/other.yaml" });
    const declaredCredential = buildSideIdentity({ ...DECLARED_ENV, JWT_SECRET: "declared" });

    expect(changed).not.toBe(buildSideIdentity());
    expect(declaredCredential).not.toBe(buildSideIdentity());
  });

  it("keeps declared credential values out of the digest", () => {
    const first = buildSideIdentity({ ...DECLARED_ENV, ATOM_API_KEY: "first-secret" });
    const rotated = buildSideIdentity({ ...DECLARED_ENV, ATOM_API_KEY: "rotated-secret" });

    expect(first).toBe(rotated);
    expect(first).not.toContain("secret");
  });

  it("binds executable identity to the declared pin, not to PATH lookup", () => {
    expect(declaredExecutablePath(LIVE_SERVICE_AMBIENT as Record<string, string>, "claude"))
      .toBe("/runtime/claude");
    expect(declaredExecutablePath({ ...DECLARED_ENV }, "claude")).toBeUndefined();
    expect(declaredExecutablePath({ ...DECLARED_ENV }, "codex")).toBeUndefined();
    expect(declaredExecutablePath({ ...DECLARED_ENV, CODEX_CLI_PATH: "" }, "codex"))
      .toBeUndefined();
  });

  it("splits allowlist duty: every entry is inventoried, only declared ones are hashed", () => {
    const ambient = releaseEnvAllowlistKeys()
      .filter((key) => releaseEnvAllowlistEntry(key)!.identity_scope === "ambient");
    const hashed = new Set(deploymentIdentityKeys());

    expect(ambient).toEqual(["APPDATA", "HOME", "PATH", "PATHEXT", "USERPROFILE"]);
    expect(ambient.filter((key) => hashed.has(key))).toEqual([]);
    for (const key of releaseEnvAllowlistKeys()) {
      const entry = releaseEnvAllowlistEntry(key)!;
      // A deployment entry owns a normalization rule; an ambient entry never needs one.
      expect(entry.normalization !== undefined).toBe(entry.identity_scope === "deployment");
    }
  });
});

describe("release manifest startup verification", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const restore of cleanups.splice(0)) restore();
  });

  it("accepts a clean-environment build started by the live service process", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-manifest-"));
    const runnerRoot = join(root, "runner");
    await mkdir(join(root, "upstream"), { recursive: true });
    await mkdir(runnerRoot, { recursive: true });
    await writeFile(join(root, "main.js"), "// host bundle\n", "utf8");
    await writeFile(join(root, "runner/runner_release_prewarm.js"), "// prewarm\n", "utf8");
    await writeFile(join(root, "upstream/control_inbox_worker_entry.js"), "// control\n", "utf8");
    await writeFile(join(runnerRoot, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(join(runnerRoot, "runner_entry.js"), "// runner\n", "utf8");

    const declared = { ...DECLARED_ENV };
    const { hashArtifactSet } = await import("../../src/runner/runner_release_materializer.js");
    const { HOST_RELEASE_ARTIFACTS, hashReleaseFileSet } = await import(
      "../../src/release/release_artifacts.js"
    );
    const runnerHash = await hashArtifactSet(runnerRoot);
    const buildInput: ReleaseManifestBuildInput = {
      sourceCommit: "70b09abd03d38c9fa120508be22542bf0ef88d2a",
      hostBundleHash: await hashReleaseFileSet(root, HOST_RELEASE_ARTIFACTS),
      runnerReleaseId: runnerHash,
      runnerArtifactHash: runnerHash,
      schemaGeneration: "070:sha256-schema",
      wireGeneration: "sha256-wire",
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      // Built exactly the way `pnpm build` does under `env -i`.
      deploymentEnvIdentity: buildSideIdentity(declared),
      claudeExecutable: await executableIdentity(
        "claude",
        declaredExecutablePath(declared, "claude"),
      ),
      codexExecutable: await executableIdentity(
        "codex",
        declaredExecutablePath(declared, "codex"),
      ),
    };
    await writeFile(
      join(root, "release-manifest.json"),
      canonicalJson(buildReleaseManifest(buildInput) as never),
      "utf8",
    );

    // Start the way the live service does: live ambient env, declared document on top.
    const startupEnv = parseEnv({ ...LIVE_SERVICE_AMBIENT, ...declared });
    const originalCwd = process.cwd();
    process.chdir(tmpdir());
    cleanups.push(() => process.chdir(originalCwd));

    const verified = await loadAndVerifyReleaseManifest({
      manifestPath: join(root, "release-manifest.json"),
      hostBundleDirectory: root,
      runnerArtifactDirectory: runnerRoot,
      env: startupEnv,
      declaredEnv: declared,
    });

    expect(verified.source_commit).toBe(buildInput.sourceCommit);
    expect(verified.executables.claude.path).toBeNull();
  });

  it("still fails fast when the declared document changed after the build", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-manifest-drift-"));
    const runnerRoot = join(root, "runner");
    await mkdir(join(root, "upstream"), { recursive: true });
    await mkdir(runnerRoot, { recursive: true });
    await writeFile(join(root, "main.js"), "// host bundle\n", "utf8");
    await writeFile(join(root, "runner/runner_release_prewarm.js"), "// prewarm\n", "utf8");
    await writeFile(join(root, "upstream/control_inbox_worker_entry.js"), "// control\n", "utf8");
    await writeFile(join(runnerRoot, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(join(runnerRoot, "runner_entry.js"), "// runner\n", "utf8");

    const { hashArtifactSet } = await import("../../src/runner/runner_release_materializer.js");
    const { HOST_RELEASE_ARTIFACTS, hashReleaseFileSet } = await import(
      "../../src/release/release_artifacts.js"
    );
    const runnerHash = await hashArtifactSet(runnerRoot);
    await writeFile(
      join(root, "release-manifest.json"),
      canonicalJson(buildReleaseManifest({
        sourceCommit: "70b09abd03d38c9fa120508be22542bf0ef88d2a",
        hostBundleHash: await hashReleaseFileSet(root, HOST_RELEASE_ARTIFACTS),
        runnerReleaseId: runnerHash,
        runnerArtifactHash: runnerHash,
        schemaGeneration: "070:sha256-schema",
        wireGeneration: "sha256-wire",
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        deploymentEnvIdentity: buildSideIdentity(),
        claudeExecutable: { kind: "claude", path: null, identity: null },
        codexExecutable: { kind: "codex", path: null, identity: null },
      }) as never),
      "utf8",
    );

    const drifted = { ...DECLARED_ENV, PORT: "4305" };
    await expect(loadAndVerifyReleaseManifest({
      manifestPath: join(root, "release-manifest.json"),
      hostBundleDirectory: root,
      runnerArtifactDirectory: runnerRoot,
      env: parseEnv({ ...LIVE_SERVICE_AMBIENT, ...drifted }),
      declaredEnv: drifted,
    })).rejects.toThrow(/release manifest mismatch: deployment_env_identity/);
  });
});
