import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildReleaseManifest,
  type ReleaseManifestBuildInput,
} from "../../src/release/release_manifest.js";
import {
  WIRE_RELEASE_MANIFEST_KEYS,
  toWireReleaseManifest,
} from "../../src/release/wire_release_manifest.js";

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

const catalogPath = "/clone/packages/model-catalog/data/model-catalog.yaml";

const schema = JSON.parse(readFileSync(
  new URL("../../../packages/wire-schema/src/upstream.schema.json", import.meta.url),
  "utf8",
)) as {
  $defs: {
    ReleaseManifestV1: {
      required: string[];
      properties: Record<string, unknown>;
    };
  };
};

describe("wire release manifest", () => {
  it("sends exactly the wire keys and drops the node-local model_catalog_path", () => {
    const local = buildReleaseManifest({ ...buildInput, modelCatalogPath: catalogPath });
    expect(local.model_catalog_path).toBe(catalogPath);

    const wire = toWireReleaseManifest(local);

    expect(Object.keys(wire).sort()).toEqual([...WIRE_RELEASE_MANIFEST_KEYS].sort());
    expect(wire).not.toHaveProperty("model_catalog_path");
    for (const key of WIRE_RELEASE_MANIFEST_KEYS) {
      expect(wire[key]).toEqual(local[key]);
    }
    expect(wire.manifest_id).toBe(local.manifest_id);
  });

  it("keeps the same wire keys for a manifest bound without model_catalog_path", () => {
    const wire = toWireReleaseManifest(buildReleaseManifest(buildInput));

    expect(Object.keys(wire).sort()).toEqual([...WIRE_RELEASE_MANIFEST_KEYS].sort());
  });

  it("matches the wire-schema ReleaseManifestV1 properties and required keys", () => {
    const definition = schema.$defs.ReleaseManifestV1;

    expect([...WIRE_RELEASE_MANIFEST_KEYS].sort()).toEqual(Object.keys(definition.properties).sort());
    expect([...WIRE_RELEASE_MANIFEST_KEYS].sort()).toEqual([...definition.required].sort());
  });
});
