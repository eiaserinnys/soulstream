import { resolve } from "node:path";

import { DATABASE_RELEASE_SCHEMA_VERSION } from "./database-release-journal.mjs";

export const DATABASE_RELEASE_RESULT_MAX_BYTES = 32_768;
const MAX_FIELD_CHARS = 4_096;

export function databaseReleaseSuccess(env, details) {
  const {
    backup_path: backupPath = null,
    recovered = false,
    retryable = false,
    ...extra
  } = details.extra ?? {};
  return sanitizeDatabaseReleaseResult({
    ...extra,
    schema_version: DATABASE_RELEASE_SCHEMA_VERSION,
    ok: true,
    request_id: env.HANIEL_REQUEST_ID ?? null,
    release_id: env.HANIEL_RELEASE_ID ?? null,
    operation: details.operation,
    phase: details.phase,
    previous_head: env.HANIEL_PREVIOUS_HEAD ?? null,
    target_head: env.HANIEL_TARGET_HEAD ?? null,
    journal_path: details.journalPath,
    backup_path: backupPath,
    recovered,
    retryable,
    error: null,
    status: details.status,
  }, env);
}

export function formatDatabaseReleaseError(error, env = process.env) {
  let text = error instanceof Error ? error.stack ?? error.message : String(error);
  const sensitive = /TOKEN|PASSWORD|SECRET|AUTH|CREDENTIAL|DATABASE_URL/i;
  const secrets = Object.entries(env)
    .filter(([key, value]) => sensitive.test(key) && typeof value === "string" && value)
    .map(([, value]) => value);
  for (const secret of secrets) text = text.split(secret).join("[redacted]");
  // Only the tail is observable. Bound it before the pattern redactors so a
  // hostile, delimiter-free identity cannot turn URL scanning quadratic.
  text = text.slice(-MAX_FIELD_CHARS);
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/\b(token|password|secret|auth|credential|database_url)=([^\s&]+)/gi,
      "$1=[redacted]");
}

function redactField(value, env) {
  if (value === null || value === undefined) return value ?? null;
  return formatDatabaseReleaseError(String(value), env);
}

export function databaseReleaseErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  const known = [
    "AMBIGUOUS_COMMIT_STATE", "APPLY_FAILED", "BACKUP_CREATE_FAILED",
    "BACKUP_VERIFY_FAILED", "JOURNAL_GATE_FAILED", "JOURNAL_IDENTITY_CONFLICT",
    "JOURNAL_REVISION_CONFLICT", "JOURNAL_STATE_CONFLICT",
    "OPERATION_MISMATCH", "POST_VERIFY_FAILED", "QUIESCENCE_REQUIRED",
    "RECOVERY_FAILED", "RECOVERY_FORBIDDEN", "RELEASE_LEASE_CONFLICT",
    "NON_CENTRAL_MUTATION_FORBIDDEN", "SUBPHASE_FAILED",
    "UPGRADE_REQUIRES_HANIEL_HANDOVER",
  ];
  return known.find((code) => message.includes(code)) ?? "DATABASE_RELEASE_FAILED";
}

export function databaseReleaseFailure(error, env, phase) {
  const operation = env.HANIEL_DATABASE_OPERATION
    ?? env.HANIEL_EXPECTED_DATABASE_OPERATION
    ?? null;
  const backupDirectory = env.HANIEL_BACKUP_DIR?.trim();
  return sanitizeDatabaseReleaseResult({
    schema_version: DATABASE_RELEASE_SCHEMA_VERSION,
    ok: false,
    request_id: env.HANIEL_REQUEST_ID ?? null,
    release_id: env.HANIEL_RELEASE_ID ?? null,
    operation,
    phase,
    previous_head: env.HANIEL_PREVIOUS_HEAD ?? null,
    target_head: env.HANIEL_TARGET_HEAD ?? null,
    journal_path: backupDirectory
      ? redactField(resolve(backupDirectory, "database-release.json"), env)
      : null,
    backup_path: null,
    recovered: false,
    retryable: false,
    error: {
      code: databaseReleaseErrorCode(error),
      message: formatDatabaseReleaseError(error, env),
    },
  }, env);
}

export function sanitizeDatabaseReleaseResult(value, env = process.env) {
  return sanitizeValue(value, env, new WeakSet(), 0);
}

function sanitizeValue(value, env, seen, depth) {
  if (depth > 8) return "[depth-limited]";
  if (typeof value === "string") return redactField(value, env);
  if (value === null || value === undefined
    || typeof value === "number" || typeof value === "boolean") {
    return value ?? null;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 64).map((item) => sanitizeValue(item, env, seen, depth + 1));
  }
  if (typeof value !== "object") return redactField(String(value), env);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const sanitized = {};
  for (const [key, child] of Object.entries(value).slice(0, 64)) {
    sanitized[redactField(key, env)] = sanitizeValue(child, env, seen, depth + 1);
  }
  seen.delete(value);
  return sanitized;
}

export function serializeDatabaseReleaseResult(value, env = process.env) {
  const sanitized = sanitizeDatabaseReleaseResult(value, env);
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, "utf8") <= DATABASE_RELEASE_RESULT_MAX_BYTES) {
    return serialized;
  }
  const compact = compactDatabaseReleaseResult(sanitized, env);
  const bounded = JSON.stringify(compact);
  if (Buffer.byteLength(bounded, "utf8") > DATABASE_RELEASE_RESULT_MAX_BYTES) {
    return JSON.stringify({
      schema_version: compact.schema_version ?? DATABASE_RELEASE_SCHEMA_VERSION,
      ok: compact.ok ?? false,
      phase: compactValue(compact.phase, env, 256),
      truncated: true,
      error: {
        code: compactValue(compact.error?.code, env, 256)
          ?? "RESULT_CONTRACT_TRUNCATED",
        message: "database release result exceeded the bounded result contract",
      },
    });
  }
  return bounded;
}

function compactDatabaseReleaseResult(value, env) {
  const compact = { truncated: true };
  for (const key of [
    "schema_version", "ok", "request_id", "release_id", "operation", "phase",
    "previous_head", "target_head", "journal_path", "backup_path", "recovered",
    "retryable", "status",
  ]) {
    if (Object.hasOwn(value, key)) compact[key] = compactValue(value[key], env);
  }
  if (value.error && typeof value.error === "object") {
    compact.error = {
      code: compactValue(value.error.code, env, 256),
      message: compactValue(value.error.message, env, 2_048),
    };
  } else {
    compact.error = value.error ?? null;
  }
  return compact;
}

function compactValue(value, env, maxChars = 1_024) {
  if (value === null || value === undefined
    || typeof value === "number" || typeof value === "boolean") {
    return value ?? null;
  }
  if (typeof value !== "string") return "[nested-value-truncated]";
  return formatDatabaseReleaseError(value, env).slice(-maxChars);
}
