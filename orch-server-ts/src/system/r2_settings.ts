import type { SqlClient } from "../control_plane/control_plane_types.js";

export const R2_PURPOSES = ["board", "attachment"] as const;
export type R2Purpose = typeof R2_PURPOSES[number];
export type R2Fields = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
export type R2Settings = R2Fields & { version: number };
export type R2SettingsUpdate = Omit<R2Fields, "secretAccessKey"> & {
  secretAccessKey?: string; expectedVersion: number; updatedBy: string;
};
export class R2SettingsError extends Error {
  constructor(readonly statusCode: 409 | 422 | 503, readonly code: string, message: string) {
    super(message); this.name = "R2SettingsError";
  }
}
export function r2SettingsKey(purpose: R2Purpose): string {
  if (!R2_PURPOSES.includes(purpose)) throw invalid("Unknown storage purpose");
  return `${purpose}_r2`;
}
export function normalizeR2Fields(input: Omit<R2Fields, "secretAccessKey">): Omit<R2Fields, "secretAccessKey"> {
  for (const key of ["endpoint", "bucket", "accessKeyId"] as const) {
    if (typeof input[key] !== "string") throw invalid(`${key} must be a string`);
  }
  const endpoint = input.endpoint.trim();
  if (endpoint) {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw invalid("Endpoint must be an HTTPS R2 S3 API endpoint"); }
    if (endpoint.includes("?") || endpoint.includes("#") || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
      || !["", "/"].includes(url.pathname)
      || !/^[a-f0-9]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/.test(url.hostname)) {
      throw invalid("Endpoint must be an HTTPS R2 S3 API endpoint without credentials, port, path, query or fragment");
    }
  }
  const bucket = input.bucket.trim();
  if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw invalid("Bucket must be a valid S3 bucket name");
  return { endpoint: endpoint.replace(/\/$/, ""), bucket, accessKeyId: input.accessKeyId.trim() };
}
export function r2SettingsMetadata(settings: R2Settings) {
  return { endpoint: settings.endpoint, bucket: settings.bucket, accessKeyId: settings.accessKeyId,
    secretAccessKeyConfigured: settings.secretAccessKey.length > 0, version: settings.version };
}
export async function readR2Settings(sql: SqlClient, purpose: R2Purpose): Promise<R2Settings> {
  const key = r2SettingsKey(purpose);
  try {
    const rows = await sql`SELECT value, version FROM system_settings WHERE setting_key = ${key}`;
    if (!rows[0]) throw unavailable();
    return parseRow(rows[0]);
  } catch { throw unavailable(); }
}
export async function updateR2Settings(sql: SqlClient, purpose: R2Purpose, input: R2SettingsUpdate): Promise<R2Settings> {
  const key = r2SettingsKey(purpose);
  const fields = normalizeR2Fields(input);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw invalid("expectedVersion must be a positive integer");
  if (input.secretAccessKey !== undefined && typeof input.secretAccessKey !== "string") throw invalid("secretAccessKey must be a string");
  if (!input.updatedBy.trim()) throw invalid("updatedBy is required");
  let rows;
  try {
    // Preserve the secret in the same CAS update; never read-modify-write it outside this statement.
    rows = await sql`
      UPDATE system_settings
      SET value = ${sql.json(fields)} || jsonb_build_object('secretAccessKey',
            CASE WHEN ${input.secretAccessKey ?? null}::text IS NULL THEN COALESCE(value->>'secretAccessKey', '')
                 ELSE ${input.secretAccessKey ?? null}::text END),
          version = version + 1, updated_at = NOW(), updated_by = ${input.updatedBy}
      WHERE setting_key = ${key} AND version = ${input.expectedVersion}
      RETURNING value, version
    `;
  } catch { throw unavailable(); }
  if (!rows[0]) {
    await readR2Settings(sql, purpose);
    throw new R2SettingsError(409, "R2_SETTINGS_CONFLICT", "Settings changed. Reload before saving.");
  }
  return parseRow(rows[0]);
}
function parseRow(row: Record<string, unknown>): R2Settings {
  const value = row.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const record = value as Record<string, unknown>;
  if (typeof record.secretAccessKey !== "string" || !Number.isSafeInteger(Number(row.version)) || Number(row.version) < 1) throw unavailable();
  try { return { ...normalizeR2Fields(record as R2Fields), secretAccessKey: record.secretAccessKey, version: Number(row.version) }; }
  catch { throw unavailable(); }
}
function invalid(message: string) { return new R2SettingsError(422, "R2_SETTINGS_INVALID", message); }
function unavailable() { return new R2SettingsError(503, "R2_SETTINGS_UNAVAILABLE", "Storage settings are unavailable. Check the central database settings."); }
