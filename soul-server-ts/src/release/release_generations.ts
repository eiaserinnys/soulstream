import { createHash } from "node:crypto";

/**
 * Content digest used across the release contract (`sha256-<hex>`). Callers that
 * need a domain prefix hash it separately; the manifest axes do not.
 */
export function sha256Digest(value: string | Uint8Array): string {
  return `sha256-${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * `schema_generation` binds the applied migration set: newest migration id and
 * digest plus a digest over the whole manifest document.
 */
export function migrationSchemaGeneration(rawManifest: string): string {
  const manifest = JSON.parse(rawManifest) as {
    migrations?: Array<{ id?: unknown; sha256?: unknown }>;
  };
  const latest = manifest.migrations?.at(-1);
  if (!latest || typeof latest.id !== "string" || typeof latest.sha256 !== "string") {
    throw new Error("migration manifest is empty");
  }
  return `${latest.id}:${latest.sha256}:${sha256Digest(rawManifest)}`;
}

/** `wire_generation` binds the upstream wire schema document. */
export function wireSchemaGeneration(rawSchema: string | Uint8Array): string {
  return sha256Digest(rawSchema);
}
