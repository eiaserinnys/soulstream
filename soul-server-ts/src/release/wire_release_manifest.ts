import type { ReleaseManifestV1 as WireReleaseManifestV1 } from "@soulstream/wire-schema";

import type { ReleaseManifestV1 } from "./release_manifest.js";

/**
 * 등록 프레임에 싣는 manifest 키 목록. 로컬 release-manifest.json은 노드 로컬 키
 * model_catalog_path를 지닐 수 있지만, 오케스트레이터(MANIFEST_KEYS)와
 * wire-schema(ReleaseManifestV1, additionalProperties:false)는 이 12키 정확 일치만 받는다.
 * 로컬 전용 키가 앞으로 더 생겨도 프레임에 새지 않도록 지우는 대신 정한 키만 고른다.
 */
export const WIRE_RELEASE_MANIFEST_KEYS = [
  "schema_version", "manifest_id", "release_cohort_id", "source_commit",
  "host_bundle_hash", "runner_release_id", "runner_artifact_hash",
  "schema_generation", "wire_generation", "node",
  "deployment_env_identity", "executables",
] as const satisfies readonly (keyof ReleaseManifestV1)[];

/** 노드 로컬 manifest에서 wire로 보내는 12키만 골라 등록 프레임용 manifest를 만든다. */
export function toWireReleaseManifest(manifest: ReleaseManifestV1): WireReleaseManifestV1 {
  return {
    schema_version: manifest.schema_version,
    manifest_id: manifest.manifest_id,
    release_cohort_id: manifest.release_cohort_id,
    source_commit: manifest.source_commit,
    host_bundle_hash: manifest.host_bundle_hash,
    runner_release_id: manifest.runner_release_id,
    runner_artifact_hash: manifest.runner_artifact_hash,
    schema_generation: manifest.schema_generation,
    wire_generation: manifest.wire_generation,
    node: manifest.node,
    deployment_env_identity: manifest.deployment_env_identity,
    executables: manifest.executables,
  };
}
