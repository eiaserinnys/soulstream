import { createHash } from "node:crypto";

/** Stable upload identity so a retried delivery reuses the same stored object. */
export function inlineUploadId(seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
