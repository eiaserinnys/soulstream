import type { ReleaseActivationPersistInput } from
  "./release_activation_receipt_repository.js";

const MANIFEST_KEYS = [
  "schema_version", "manifest_id", "release_cohort_id", "source_commit",
  "host_bundle_hash", "runner_release_id", "runner_artifact_hash",
  "schema_generation", "wire_generation", "node",
  "deployment_env_identity", "executables",
] as const;
const ACTIVATION_KEYS = [
  "manifest_id", "release_cohort_id", "source_commit", "prewarmed_at",
  "verification", "registration_idempotency_key",
] as const;

export function parseReleaseActivationRegistration(
  frame: Record<string, unknown>,
): ReleaseActivationPersistInput | null {
  const manifest = frame.release_manifest;
  const activation = frame.release_activation;
  if (manifest === undefined && activation === undefined) return null;
  const releaseManifest = requireRecord(manifest, "release_manifest");
  const releaseActivation = requireRecord(activation, "release_activation");
  requireExactKeys(releaseManifest, MANIFEST_KEYS, "release_manifest");
  requireExactKeys(releaseActivation, ACTIVATION_KEYS, "release_activation");
  validateManifest(releaseManifest);

  const nodeId = nonEmptyString(frame.node_id, "node_id");
  const manifestId = nonEmptyString(
    releaseManifest.manifest_id,
    "release_manifest.manifest_id",
  );
  const releaseCohortId = nonEmptyString(
    releaseManifest.release_cohort_id,
    "release_manifest.release_cohort_id",
  );
  const sourceCommit = nonEmptyString(
    releaseManifest.source_commit,
    "release_manifest.source_commit",
  );
  if (releaseActivation.manifest_id !== manifestId
    || releaseActivation.release_cohort_id !== releaseCohortId
    || releaseActivation.source_commit !== sourceCommit) {
    throw new Error("release activation identity does not match manifest");
  }
  const prewarmedAt = nonEmptyString(
    releaseActivation.prewarmed_at,
    "release_activation.prewarmed_at",
  );
  if (!Number.isFinite(Date.parse(prewarmedAt))) {
    throw new Error("release_activation.prewarmed_at must be an ISO timestamp");
  }
  validateVerification(releaseActivation.verification);
  return {
    nodeId,
    manifestId,
    releaseCohortId,
    sourceCommit,
    prewarmedAt,
    verification: {
      host: "verified",
      runner: "verified",
      env: "verified",
      executable: "verified",
    },
    registrationIdempotencyKey: nonEmptyString(
      releaseActivation.registration_idempotency_key,
      "release_activation.registration_idempotency_key",
    ),
  };
}

function validateManifest(manifest: Record<string, unknown>): void {
  if (manifest.schema_version !== 1) {
    throw new Error("release_manifest.schema_version must be 1");
  }
  for (const field of [
    "manifest_id", "release_cohort_id", "source_commit", "host_bundle_hash",
    "runner_release_id", "runner_artifact_hash", "schema_generation",
    "wire_generation", "deployment_env_identity",
  ]) nonEmptyString(manifest[field], `release_manifest.${field}`);

  const node = requireRecord(manifest.node, "release_manifest.node");
  requireExactKeys(node, ["version", "platform", "arch"], "release_manifest.node");
  for (const field of ["version", "platform", "arch"]) {
    nonEmptyString(node[field], `release_manifest.node.${field}`);
  }
  const executables = requireRecord(
    manifest.executables,
    "release_manifest.executables",
  );
  requireExactKeys(executables, ["claude", "codex"], "release_manifest.executables");
  validateExecutable(executables.claude, "claude");
  validateExecutable(executables.codex, "codex");
}

function validateExecutable(value: unknown, kind: "claude" | "codex"): void {
  const executable = requireRecord(value, `release_manifest.executables.${kind}`);
  requireExactKeys(
    executable,
    ["kind", "path", "identity"],
    `release_manifest.executables.${kind}`,
  );
  if (executable.kind !== kind) {
    throw new Error(`release_manifest.executables.${kind}.kind must be ${kind}`);
  }
  for (const field of ["path", "identity"]) {
    if (executable[field] !== null && typeof executable[field] !== "string") {
      throw new Error(`release_manifest.executables.${kind}.${field} invalid`);
    }
  }
}

function validateVerification(value: unknown): void {
  const verification = requireRecord(value, "release_activation.verification");
  requireExactKeys(
    verification,
    ["host", "runner", "env", "executable"],
    "release_activation.verification",
  );
  if (verification.host !== "verified"
    || verification.runner !== "verified"
    || verification.env !== "verified"
    || verification.executable !== "verified") {
    throw new Error("release activation verification incomplete");
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} required`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !expected.has(key))) {
    throw new Error(`${field} has invalid fields`);
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} required`);
  }
  return value;
}
