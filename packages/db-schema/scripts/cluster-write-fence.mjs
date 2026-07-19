import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { readReleaseId } from "./migration-contract.mjs";

export function validateClusterWriteFence(fence, env = process.env) {
  const writers = Array.isArray(fence?.writer_nodes) ? fence.writer_nodes : [];
  const fenced = Array.isArray(fence?.fenced_nodes) ? fence.fenced_nodes : [];
  const writerSet = new Set(writers);
  const fencedSet = new Set(fenced);
  const allFenced = writerSet.size > 0
    && writerSet.size === fencedSet.size
    && [...writerSet].every((nodeId) => fencedSet.has(nodeId));
  if (
    fence?.schema_version !== "soulstream.cluster-write-fence.v1"
    || fence?.status !== "verified"
    || Number(fence?.active_writer_count) !== 0
    || !allFenced
  ) {
    throw new Error("cluster writers are not fully fenced");
  }
  if (
    fence.release_id !== readReleaseId(env)
    || fence.target_head !== env.HANIEL_TARGET_HEAD
  ) {
    throw new Error("cluster write fence does not match this release");
  }
  return fence;
}

export async function readVerifiedClusterWriteFence(
  env = process.env,
  { read = readFile } = {},
) {
  const fencePath = env.SOULSTREAM_CLUSTER_WRITE_FENCE_PATH?.trim();
  if (!fencePath) {
    throw new Error("SOULSTREAM_CLUSTER_WRITE_FENCE_PATH is required");
  }
  const fence = JSON.parse(await read(resolve(fencePath), "utf8"));
  return validateClusterWriteFence(fence, env);
}
