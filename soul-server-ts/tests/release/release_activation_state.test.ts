import { describe, expect, it } from "vitest";

import { ReleaseActivationState } from "../../src/release/release_activation_state.js";
import { buildReleaseManifest } from "../../src/release/release_manifest.js";

const manifest = buildReleaseManifest({
  sourceCommit: "commit",
  hostBundleHash: "host",
  runnerReleaseId: "runner",
  runnerArtifactHash: "runner",
  schemaGeneration: "schema",
  wireGeneration: "wire",
  nodeVersion: "22.18.0",
  platform: "linux",
  arch: "x64",
  deploymentEnvIdentity: "env",
  claudeExecutable: { kind: "claude", path: "/claude", identity: "claude" },
  codexExecutable: { kind: "codex", path: "/codex", identity: "codex" },
});

describe("ReleaseActivationState", () => {
  it("is not ready before exact runner prewarm and central receipt ACK", () => {
    const state = new ReleaseActivationState(manifest, {
      now: () => new Date("2026-08-19T09:00:00.000Z"),
      registrationIdempotencyKey: "registration-key",
    });

    expect(state.health()).toMatchObject({ status: "starting", ready: false });
    state.markPrewarmed({ host: "verified", runner: "verified", env: "verified", executable: "verified" });
    expect(state.registration()).toMatchObject({
      registration_idempotency_key: "registration-key",
      manifest_id: manifest.manifest_id,
      verification: { runner: "verified" },
    });
    expect(state.health()).toMatchObject({ status: "starting", ready: false });

    state.acceptReceipt({
      manifest_id: manifest.manifest_id,
      activation_generation: 41,
      activated_at: "2026-08-19T09:00:01.000Z",
      registration_idempotency_key: "registration-key",
    });
    expect(state.health()).toMatchObject({
      status: "ok",
      ready: true,
      manifest_id: manifest.manifest_id,
      activation_generation: 41,
    });
  });

  it("rejects a receipt from another manifest or registration attempt", () => {
    const state = new ReleaseActivationState(manifest, {
      registrationIdempotencyKey: "registration-key",
    });
    state.markPrewarmed({ host: "verified", runner: "verified", env: "verified", executable: "verified" });

    expect(() => state.acceptReceipt({
      manifest_id: "other",
      activation_generation: 1,
      activated_at: "2026-08-19T09:00:01.000Z",
      registration_idempotency_key: "registration-key",
    })).toThrow("activation receipt manifest mismatch");
    expect(() => state.acceptReceipt({
      manifest_id: manifest.manifest_id,
      activation_generation: 1,
      activated_at: "not-a-timestamp",
      registration_idempotency_key: "registration-key",
    })).toThrow("activation receipt timestamp invalid");
  });

  it("keeps immutable manifest identity separate from mutable activation generations", () => {
    const first = new ReleaseActivationState(manifest, {
      registrationIdempotencyKey: "registration-first",
    });
    const replacement = new ReleaseActivationState(manifest, {
      registrationIdempotencyKey: "registration-replacement",
    });
    const verification = {
      host: "verified" as const,
      runner: "verified" as const,
      env: "verified" as const,
      executable: "verified" as const,
    };
    first.markPrewarmed(verification);
    replacement.markPrewarmed(verification);
    first.acceptReceipt({
      manifest_id: manifest.manifest_id,
      activation_generation: 41,
      activated_at: "2026-08-19T09:00:01.000Z",
      registration_idempotency_key: "registration-first",
    });
    replacement.acceptReceipt({
      manifest_id: manifest.manifest_id,
      activation_generation: 42,
      activated_at: "2026-08-19T09:05:01.000Z",
      registration_idempotency_key: "registration-replacement",
    });

    expect(first.manifest).toEqual(replacement.manifest);
    expect(first.health()).toMatchObject({
      manifest_id: manifest.manifest_id,
      activation_generation: 41,
    });
    expect(replacement.health()).toMatchObject({
      manifest_id: manifest.manifest_id,
      activation_generation: 42,
    });
  });
});
