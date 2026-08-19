import { createHash } from "node:crypto";

const MANIFEST_HASH_DOMAIN = "soulstream.release.manifest.v1\0";
const COHORT_HASH_DOMAIN = "soulstream.release.cohort.v1\0";
const RUNTIME_ENV_HASH_DOMAIN = "soulstream.runtime.env.v1\0";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface ReleaseExecutableIdentity {
  kind: "claude" | "codex";
  path: string | null;
  identity: string | null;
}

export interface ReleaseManifestBuildInput {
  sourceCommit: string;
  hostBundleHash: string;
  runnerReleaseId: string;
  runnerArtifactHash: string;
  schemaGeneration: string;
  wireGeneration: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  deploymentEnvIdentity: string;
  claudeExecutable: ReleaseExecutableIdentity;
  codexExecutable: ReleaseExecutableIdentity;
}

export interface ReleaseManifestV1 {
  schema_version: 1;
  manifest_id: string;
  release_cohort_id: string;
  source_commit: string;
  host_bundle_hash: string;
  runner_release_id: string;
  runner_artifact_hash: string;
  schema_generation: string;
  wire_generation: string;
  node: {
    version: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  deployment_env_identity: string;
  executables: {
    claude: ReleaseExecutableIdentity;
    codex: ReleaseExecutableIdentity;
  };
}

export interface RuntimeCredentialDescriptor {
  slot: string;
  present: boolean;
  validation: string;
  generation: string | null;
}

export interface RuntimeEnvIdentityInput {
  nonSecrets: Readonly<Record<string, CanonicalJsonValue>>;
  credentials: readonly RuntimeCredentialDescriptor[];
}

export function canonicalJson(value: CanonicalJsonValue): string {
  return `${serializeCanonical(value)}\n`;
}

export function computeRuntimeEnvIdentity(input: RuntimeEnvIdentityInput): string {
  const credentials = [...input.credentials]
    .map((descriptor) => ({
      slot: descriptor.slot.normalize("NFC"),
      present: descriptor.present,
      validation: descriptor.validation.normalize("NFC"),
      generation: descriptor.generation?.normalize("NFC") ?? null,
    }))
    .sort((left, right) => compareUtf8(left.slot, right.slot));
  return domainHash(RUNTIME_ENV_HASH_DOMAIN, canonicalJson({
    non_secrets: input.nonSecrets,
    credentials,
  }));
}

export function buildReleaseManifest(input: ReleaseManifestBuildInput): ReleaseManifestV1 {
  const releaseCohortId = domainHash(COHORT_HASH_DOMAIN, canonicalJson({
    schema_version: 1,
    source_commit: input.sourceCommit,
    schema_generation: input.schemaGeneration,
    wire_generation: input.wireGeneration,
  }));
  const body = manifestBody(input, releaseCohortId);
  return {
    ...body,
    manifest_id: domainHash(
      MANIFEST_HASH_DOMAIN,
      canonicalJson(body as unknown as CanonicalJsonValue),
    ),
  };
}

export function verifyReleaseManifest(
  manifest: ReleaseManifestV1,
  current: ReleaseManifestBuildInput,
): void {
  const expected = buildReleaseManifest(current);
  const axes: Array<keyof ReleaseManifestV1> = [
    "source_commit",
    "host_bundle_hash",
    "runner_release_id",
    "runner_artifact_hash",
    "schema_generation",
    "wire_generation",
    "node",
    "deployment_env_identity",
    "executables",
    "release_cohort_id",
    "manifest_id",
  ];
  for (const axis of axes) {
    if (canonicalJson(manifest[axis] as CanonicalJsonValue)
      !== canonicalJson(expected[axis] as CanonicalJsonValue)) {
      throw new Error(`release manifest mismatch: ${axis}`);
    }
  }
}

function manifestBody(
  input: ReleaseManifestBuildInput,
  releaseCohortId: string,
): Omit<ReleaseManifestV1, "manifest_id"> {
  return {
    schema_version: 1,
    release_cohort_id: releaseCohortId,
    source_commit: input.sourceCommit,
    host_bundle_hash: input.hostBundleHash,
    runner_release_id: input.runnerReleaseId,
    runner_artifact_hash: input.runnerArtifactHash,
    schema_generation: input.schemaGeneration,
    wire_generation: input.wireGeneration,
    node: {
      version: input.nodeVersion,
      platform: input.platform,
      arch: input.arch,
    },
    deployment_env_identity: input.deploymentEnvIdentity,
    executables: {
      claude: input.claudeExecutable,
      codex: input.codexExecutable,
    },
  };
}

function serializeCanonical(value: CanonicalJsonValue): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(",")}]`;
  const record = value as Readonly<Record<string, CanonicalJsonValue>>;
  return `{${Object.keys(record)
    .sort(compareUtf8)
    .map((key) => `${JSON.stringify(key.normalize("NFC"))}:${serializeCanonical(record[key]!)}`)
    .join(",")}}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function domainHash(domain: string, canonical: string): string {
  return `sha256-${createHash("sha256").update(domain).update(canonical, "utf8").digest("hex")}`;
}
