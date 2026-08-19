import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildReleaseManifest,
  canonicalJson,
  computeRuntimeEnvIdentity,
  verifyReleaseManifest,
  type ReleaseManifestBuildInput,
} from "../../src/release/release_manifest.js";
import {
  agentRuntimeEnvIdentity,
  releaseEnvAllowlistKeys,
} from "../../src/release/release_env.js";
import { parseReleaseManifest } from "../../src/release/release_runtime.js";

const buildInput: ReleaseManifestBuildInput = {
  sourceCommit: "46203dc8c05222cbac476d2973f6f9d554926ac2",
  hostBundleHash: "sha256-host",
  runnerReleaseId: "sha256-runner",
  runnerArtifactHash: "sha256-runner",
  schemaGeneration: "069:sha256-schema",
  wireGeneration: "sha256-wire",
  nodeVersion: "22.18.0",
  platform: "linux",
  arch: "x64",
  deploymentEnvIdentity: "sha256-env",
  claudeExecutable: { kind: "claude", path: "/usr/bin/claude", identity: "sha256-claude" },
  codexExecutable: { kind: "codex", path: "/usr/bin/codex", identity: "sha256-codex" },
};

describe("ReleaseManifest v1", () => {
  it("uses recursive UTF-8 byte ordering, NFC strings, and one trailing LF", () => {
    expect(canonicalJson({ z: "e\u0301", "가": 2, a: { y: 2, x: 1 } })).toBe(
      '{"a":{"x":1,"y":2},"z":"é","가":2}\n',
    );
  });

  it("keeps a common cohort while platform-specific executable identities change manifest_id", () => {
    const linux = buildReleaseManifest(buildInput);
    const windows = buildReleaseManifest({
      ...buildInput,
      platform: "win32",
      arch: "x64",
      claudeExecutable: {
        kind: "claude",
        path: "C:/tools/claude.exe",
        identity: "sha256-claude-windows",
      },
    });

    expect(linux.release_cohort_id).toBe(windows.release_cohort_id);
    expect(linux.manifest_id).not.toBe(windows.manifest_id);
    expect(linux).not.toHaveProperty("prewarmed_at");
    expect(linux).not.toHaveProperty("activated_at");
  });

  it("rejects missing or unknown immutable manifest fields at the host boundary", () => {
    const manifest = buildReleaseManifest(buildInput);
    const { runner_artifact_hash: _missing, ...incomplete } = manifest;
    expect(() => parseReleaseManifest(incomplete)).toThrow("invalid fields");
    expect(() => parseReleaseManifest({ ...manifest, mutable_ready: true })).toThrow(
      "invalid fields",
    );
  });

  it("hashes typed non-secrets but represents credentials only by slot metadata", () => {
    const first = computeRuntimeEnvIdentity({
      nonSecrets: { PORT: 4205, MCP_ALLOWED_HOSTS: ["localhost", "127.0.0.1"] },
      credentials: [{ slot: "AUTH_BEARER_TOKEN", present: true, validation: "non_empty", generation: "7" }],
    });
    const sameWithDifferentSecret = computeRuntimeEnvIdentity({
      nonSecrets: { MCP_ALLOWED_HOSTS: ["localhost", "127.0.0.1"], PORT: 4205 },
      credentials: [{ slot: "AUTH_BEARER_TOKEN", present: true, validation: "non_empty", generation: "7" }],
    });

    expect(first).toBe(sameWithDifferentSecret);
    expect(first).toBe("sha256-77aeae0ea9b9d13679767bec764b0d311bb65dedc712a4441728ca17697cfc7b");
    expect(first).not.toContain("secret");
  });

  it("keeps AgentProfile secret values out of runtime_env_identity", () => {
    const first = agentRuntimeEnvIdentity({
      id: "roselin",
      env: { CUSTOM_API_KEY: "first-secret", FEATURE_LEVEL: "strict" },
    });
    const rotated = agentRuntimeEnvIdentity({
      id: "roselin",
      env: { CUSTOM_API_KEY: "rotated-secret", FEATURE_LEVEL: "strict" },
    });
    const absent = agentRuntimeEnvIdentity({
      id: "roselin",
      env: { CUSTOM_API_KEY: "", FEATURE_LEVEL: "strict" },
    });

    expect(first).toBe(rotated);
    expect(first).not.toBe(absent);
    expect(first).not.toContain("first-secret");
    expect(first).not.toContain("rotated-secret");
  });

  it("inventories every typed and direct static runtime env key in the checked-in allowlist", () => {
    const sourceRoot = resolve(import.meta.dirname, "../../src");
    const configSource = readFileSync(join(sourceRoot, "config.ts"), "utf8");
    const typedKeys = [...configSource.matchAll(/^\s{4}([A-Z][A-Z0-9_]+):/gm)]
      .map((match) => match[1]!);
    const runtimeSources = readTypeScriptSources(sourceRoot);
    const directKeys = runtimeSources.flatMap((source) =>
      [...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)]
        .map((match) => match[1]!)
        .filter((key) => key !== "X"));
    const constantBracketKeys = runtimeSources.flatMap((source) => {
      const constants = new Map(
        [...source.matchAll(/const\s+([A-Z][A-Z0-9_]*_ENV)\s*=\s*"([A-Z][A-Z0-9_]*)"/g)]
          .map((match) => [match[1]!, match[2]!] as const),
      );
      return [...source.matchAll(/process\.env\[([A-Z][A-Z0-9_]*_ENV)\]/g)]
        .flatMap((match) => constants.get(match[1]!) ?? []);
    });
    const consumed = [...new Set([...typedKeys, ...directKeys, ...constantBracketKeys])].sort();
    const allowed = new Set(releaseEnvAllowlistKeys());

    expect(consumed.filter((key) => !allowed.has(key))).toEqual([]);
  });

  it.each([
    ["host_bundle_hash", { hostBundleHash: "sha256-other" }],
    ["runner_release_id", { runnerReleaseId: "sha256-other" }],
    ["deployment_env_identity", { deploymentEnvIdentity: "sha256-other" }],
    ["claude_executable", { claudeExecutable: { kind: "claude" as const, path: "/other", identity: "sha256-other" } }],
  ])("fails fast when only %s mismatches", (_axis, override) => {
    const manifest = buildReleaseManifest(buildInput);
    expect(() => verifyReleaseManifest(manifest, { ...buildInput, ...override })).toThrow(
      /release manifest mismatch/,
    );
  });

  it.each([
    [true, true, true, true],
    [true, true, false, false],
    [true, false, true, false],
    [true, false, false, false],
    [false, true, true, false],
    [false, true, false, false],
    [false, false, true, false],
    [false, false, false, false],
  ])(
    "decides host=%s runner=%s env=%s as compatible=%s",
    (hostMatches, runnerMatches, envMatches, compatible) => {
      const manifest = buildReleaseManifest(buildInput);
      const current = {
        ...buildInput,
        hostBundleHash: hostMatches ? buildInput.hostBundleHash : "sha256-other-host",
        runnerReleaseId: runnerMatches ? buildInput.runnerReleaseId : "sha256-other-runner",
        runnerArtifactHash: runnerMatches ? buildInput.runnerArtifactHash : "sha256-other-runner",
        deploymentEnvIdentity: envMatches
          ? buildInput.deploymentEnvIdentity
          : "sha256-other-env",
      };
      if (compatible) expect(() => verifyReleaseManifest(manifest, current)).not.toThrow();
      else expect(() => verifyReleaseManifest(manifest, current)).toThrow(/release manifest mismatch/);
    },
  );
});

function readTypeScriptSources(root: string): string[] {
  const sources: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) sources.push(...readTypeScriptSources(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      sources.push(readFileSync(path, "utf8"));
    }
  }
  return sources;
}
