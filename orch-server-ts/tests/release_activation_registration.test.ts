import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseReleaseActivationRegistration } from "../src/node/release_activation_registration.js";

const schema = JSON.parse(readFileSync(
  new URL("../../packages/wire-schema/src/upstream.schema.json", import.meta.url),
  "utf8",
)) as {
  $defs: {
    ReleaseManifestV1: {
      required: string[];
      properties: Record<string, unknown>;
    };
  };
};

const manifest = {
  schema_version: 1,
  manifest_id: "manifest-1",
  release_cohort_id: "cohort-1",
  source_commit: "commit-1",
  host_bundle_hash: "sha256-host",
  runner_release_id: "sha256-runner-release",
  runner_artifact_hash: "sha256-runner-artifact",
  schema_generation: "schema-70",
  wire_generation: "wire-1",
  node: { version: "v22.18.0", platform: "linux", arch: "x64" },
  deployment_env_identity: "sha256-env",
  executables: {
    claude: { kind: "claude", path: "/usr/bin/claude", identity: "sha256-claude" },
    codex: { kind: "codex", path: "/usr/bin/codex", identity: "sha256-codex" },
  },
};

const activation = {
  manifest_id: "manifest-1",
  release_cohort_id: "cohort-1",
  source_commit: "commit-1",
  prewarmed_at: "2026-08-19T09:00:00.000Z",
  verification: {
    host: "verified",
    runner: "verified",
    env: "verified",
    executable: "verified",
  },
  registration_idempotency_key: "registration-key",
};

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "node_register",
    node_id: "fake-node",
    release_manifest: manifest,
    release_activation: activation,
    ...overrides,
  };
}

function rejectionMessage(input: Record<string, unknown>): string {
  try {
    parseReleaseActivationRegistration(input);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseReleaseActivationRegistration to reject");
}

describe("release activation registration rejection details", () => {
  it("names the unexpected node-local key", () => {
    const message = rejectionMessage(frame({
      release_manifest: { ...manifest, model_catalog_path: "/clone/catalog.yaml" },
    }));

    expect(message).toContain("release_manifest has invalid fields");
    expect(message).toContain("unexpected: model_catalog_path");
    expect(message).toContain("missing: none");
    expect(message).not.toContain("/clone/catalog.yaml");
  });

  it("names the missing key", () => {
    const incomplete: Record<string, unknown> = { ...manifest };
    delete incomplete.runner_artifact_hash;

    const message = rejectionMessage(frame({ release_manifest: incomplete }));

    expect(message).toContain("unexpected: none");
    expect(message).toContain("missing: runner_artifact_hash");
  });

  it("caps long key names and long key lists", () => {
    const longKey = "k".repeat(100);
    const message = rejectionMessage(frame({
      release_manifest: {
        ...manifest,
        [longKey]: true,
        a1: 1, a2: 1, a3: 1, a4: 1, a5: 1, a6: 1, a7: 1, a8: 1, a9: 1, a10: 1, a11: 1,
      },
    }));

    expect(message).not.toContain(longKey);
    expect(message).toContain("k".repeat(64));
    expect(message).toContain("+2");
  });

  it("accepts exactly the schema-required keys and rejects one extra key", () => {
    const required = schema.$defs.ReleaseManifestV1.required;
    expect(Object.keys(manifest).sort()).toEqual([...required].sort());

    const fromSchema = Object.fromEntries(required.map((key) => [key, manifest[key as keyof typeof manifest]]));
    expect(parseReleaseActivationRegistration(frame({ release_manifest: fromSchema }))).toMatchObject({
      nodeId: "fake-node",
      manifestId: "manifest-1",
    });

    expect(() => parseReleaseActivationRegistration(frame({
      release_manifest: { ...fromSchema, model_catalog_path: "/clone/catalog.yaml" },
    }))).toThrow(/model_catalog_path/);
  });
});
