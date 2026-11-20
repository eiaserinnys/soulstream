import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import { ReleaseActivationState } from "../../src/release/release_activation_state.js";
import { buildReleaseManifest } from "../../src/release/release_manifest.js";
import { WIRE_RELEASE_MANIFEST_KEYS } from "../../src/release/wire_release_manifest.js";
import { buildRegistrationMsg } from "../../src/upstream/registration.js";

const catalogPath = "/clone/packages/model-catalog/data/model-catalog.yaml";

const agent = {
  id: "roselin",
  name: "로젤린",
  backend: "claude" as const,
  workspace_dir: "/tmp/roselin",
};

function buildFrame(withCatalogPath: boolean) {
  const manifest = buildReleaseManifest({
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
    ...(withCatalogPath ? { modelCatalogPath: catalogPath } : {}),
  });
  const state = new ReleaseActivationState(manifest, {
    registrationIdempotencyKey: "registration-key",
  });
  state.markPrewarmed({
    host: "verified",
    runner: "verified",
    env: "verified",
    executable: "verified",
  });
  const msg = buildRegistrationMsg({
    nodeId: "eias-shopping-ts",
    host: "127.0.0.1",
    port: 4205,
    userName: "",
    agentRegistry: new AgentRegistry([agent]),
    releaseActivationState: state,
  });
  return { manifest, msg };
}

describe("node registration frame release_manifest", () => {
  it("carries exactly the wire keys and never the node-local model_catalog_path", () => {
    const { manifest, msg } = buildFrame(true);
    expect(manifest.model_catalog_path).toBe(catalogPath);
    const releaseManifest = msg.release_manifest!;

    expect(Object.keys(releaseManifest).sort()).toEqual([...WIRE_RELEASE_MANIFEST_KEYS].sort());
    expect(releaseManifest).not.toHaveProperty("model_catalog_path");
    for (const key of WIRE_RELEASE_MANIFEST_KEYS) {
      expect(releaseManifest[key]).toEqual(manifest[key]);
    }
    expect(releaseManifest.manifest_id).toBe(manifest.manifest_id);
    expect(releaseManifest.release_cohort_id).toBe(manifest.release_cohort_id);
  });

  it("carries the same wire keys when the manifest has no model_catalog_path", () => {
    const { msg } = buildFrame(false);

    expect(Object.keys(msg.release_manifest!).sort()).toEqual([...WIRE_RELEASE_MANIFEST_KEYS].sort());
  });
});
