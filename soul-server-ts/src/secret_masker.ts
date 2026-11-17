/**
 * Deterministic output masker for already-known secret values.
 *
 * The registry and the process environment tell us which values are secret;
 * this module replaces exactly those values inside tool output, engine events,
 * and runner frames before they reach a model, the outbox, or a transcript.
 * Pattern guessing is intentionally out of scope: only values collected from
 * resolved MCP servers and environment variables are masked.
 */

import {
  isSensitiveKey,
  isSensitiveUrlQueryParam,
  type ResolvedMcpServer,
} from "./mcp_config_service.js";

export interface SecretValue {
  /** Non-secret label used in the replacement marker (e.g. "env:OPENAI_API_KEY"). */
  name: string;
  value: string;
}

export type SecretValueProvider = () => readonly SecretValue[];

interface SecretValueSource {
  provider: SecretValueProvider;
  cached: readonly SecretValue[] | null;
  cachedAtMs: number;
  warned: boolean;
}

const SOURCE_CACHE_TTL_MS = 30_000;
const MIN_SECRET_VALUE_LENGTH = 8;
const NUMERIC_VALUE_RE = /^[+-]?\d+(?:\.\d+)?$/;
const BOOLEAN_VALUE_RE = /^(?:true|false)$/i;
const PATH_LIKE_NAME_SUFFIX_RE = /_(?:PATH|FILE|DIR|URL_PATH)$/i;
const PATH_LIKE_VALUE_PREFIXES = ["/", "./", "~"] as const;
const AUTHORIZATION_SCHEME_RE = /^[A-Za-z][A-Za-z0-9_-]*\s+(.+)$/;

const sources = new Map<string, SecretValueSource>();

/** Register (or replace) a provider of secret values under a stable source name. */
export function registerSecretValueSource(
  source: string,
  provider: SecretValueProvider,
): void {
  sources.set(source, { provider, cached: null, cachedAtMs: 0, warned: false });
}

export function resetSecretMaskerForTests(): void {
  sources.clear();
}

export function collectMcpServerSecretValues(
  servers: readonly ResolvedMcpServer[],
): SecretValue[] {
  const values: SecretValue[] = [];
  for (const server of servers) {
    const label = server.name ?? "mcp-server";
    for (const [key, raw] of Object.entries(server.headers ?? {})) {
      if (!isSensitiveKey(key)) continue;
      pushValue(values, `mcp:${label}:headers:${key}`, raw);
      const token = authorizationToken(raw);
      if (token !== undefined) pushValue(values, `mcp:${label}:headers:${key}`, token);
    }
    if (server.type === "stdio" && server.env) {
      for (const [key, raw] of Object.entries(server.env)) {
        if (isSensitiveKey(key)) pushValue(values, `mcp:${label}:env:${key}`, raw);
      }
    }
    if (
      (server.type === "streamable_http" || server.type === "sse")
      && typeof server.url === "string"
    ) {
      collectUrlQuerySecretValues(values, `mcp:${label}:url`, server.url);
    }
    if (server.type === "stdio" && server.args) {
      for (const arg of server.args) {
        if (arg.includes("?")) collectUrlQuerySecretValues(values, `mcp:${label}:args`, arg);
      }
    }
  }
  return dedupeSecretValues(values);
}

export function collectEnvSecretValues(
  env: Record<string, string | undefined>,
): SecretValue[] {
  const values: SecretValue[] = [];
  for (const [name, raw] of Object.entries(env)) {
    if (typeof raw !== "string") continue;
    if (!isSensitiveKey(name)) continue;
    if (PATH_LIKE_NAME_SUFFIX_RE.test(name)) continue;
    const value = raw.trim();
    if (value.length < MIN_SECRET_VALUE_LENGTH) continue;
    if (PATH_LIKE_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix))) continue;
    if (BOOLEAN_VALUE_RE.test(value) || NUMERIC_VALUE_RE.test(value)) continue;
    values.push({ name: `env:${name}`, value });
  }
  return dedupeSecretValues(values);
}

/**
 * Replace every registered secret value inside strings below `value`.
 *
 * Unchanged input keeps its reference; changed paths are shallow-rebuilt so the
 * caller's object is never mutated. Plain objects and arrays are traversed;
 * Date, Buffer, Uint8Array, Map, Set, and class instances pass through as-is.
 */
export function maskSecrets<T>(value: T): T {
  const secrets = activeSecretValues();
  if (secrets.length === 0) return value;
  if (!containsSecretValue(value, secrets, new WeakSet())) return value;
  return transformSecretValues(value, secrets, new WeakMap()) as T;
}

function collectUrlQuerySecretValues(
  values: SecretValue[],
  namePrefix: string,
  url: string,
): void {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return;
  const fragmentStart = url.indexOf("#", queryStart + 1);
  const query = url.slice(queryStart + 1, fragmentStart === -1 ? url.length : fragmentStart);
  for (const entry of query.split("&")) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    const rawName = entry.slice(0, separator);
    if (!isSensitiveUrlQueryParam(rawName)) continue;
    const rawValue = entry.slice(separator + 1);
    const decodedValue = decodeUrlComponent(rawValue);
    const name = `${namePrefix}:${decodeUrlComponent(rawName)}`;
    pushValue(values, name, decodedValue);
    if (decodedValue !== rawValue) pushValue(values, name, rawValue);
  }
}

function pushValue(values: SecretValue[], name: string, raw: string): void {
  const value = raw.trim();
  if (value.length < MIN_SECRET_VALUE_LENGTH) return;
  values.push({ name, value });
}

function dedupeSecretValues(values: readonly SecretValue[]): SecretValue[] {
  const seen = new Set<string>();
  const deduped: SecretValue[] = [];
  for (const entry of values) {
    const value = entry.value.trim();
    if (value.length < MIN_SECRET_VALUE_LENGTH) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    deduped.push({ name: entry.name, value });
  }
  return deduped;
}

function authorizationToken(value: string): string | undefined {
  const match = AUTHORIZATION_SCHEME_RE.exec(value.trim());
  return match?.[1]?.trim();
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

function activeSecretValues(): SecretValue[] {
  const now = Date.now();
  const collected: SecretValue[] = [];
  for (const [source, state] of sources) {
    let cached = state.cached;
    if (cached === null || now - state.cachedAtMs >= SOURCE_CACHE_TTL_MS) {
      try {
        cached = state.provider();
        state.cached = cached;
        state.warned = false;
      } catch {
        cached ??= [];
        if (!state.warned) {
          state.warned = true;
          console.warn(`secret masker source "${source}" failed; using cached values`);
        }
      }
      state.cachedAtMs = now;
    }
    collected.push(...cached);
  }
  return dedupeSecretValues(collected).sort((left, right) => right.value.length - left.value.length);
}

function containsSecretValue(
  value: unknown,
  secrets: readonly SecretValue[],
  seen: WeakSet<object>,
): boolean {
  if (typeof value === "string") return containsAnySecret(value, secrets);
  if (Array.isArray(value)) {
    if (seen.has(value)) return false;
    seen.add(value);
    return value.some((item) => containsSecretValue(item, secrets, seen));
  }
  if (!isPlainObject(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor && containsSecretValue(descriptor.value, secrets, seen)) {
      return true;
    }
  }
  return false;
}

function containsAnySecret(value: string, secrets: readonly SecretValue[]): boolean {
  return secrets.some((secret) => value.includes(secret.value));
}

function transformSecretValues(
  value: unknown,
  secrets: readonly SecretValue[],
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") return maskString(value, secrets);
  if (Array.isArray(value)) return transformArray(value, secrets, seen);
  if (!isPlainObject(value)) return value;
  return transformPlainObject(value, secrets, seen);
}

function transformArray(
  value: unknown[],
  secrets: readonly SecretValue[],
  seen: WeakMap<object, unknown>,
): unknown {
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const next = value.slice();
  seen.set(value, next);
  let changed = false;
  for (let index = 0; index < next.length; index += 1) {
    if (!(index in next)) continue;
    const masked = transformSecretValues(next[index], secrets, seen);
    if (masked !== next[index]) {
      next[index] = masked;
      changed = true;
    }
  }
  if (!changed) {
    seen.set(value, value);
    return value;
  }
  return next;
}

function transformPlainObject(
  value: Record<PropertyKey, unknown>,
  secrets: readonly SecretValue[],
  seen: WeakMap<object, unknown>,
): unknown {
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const descriptors: Record<PropertyKey, PropertyDescriptor> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor) descriptors[key] = descriptor;
  }
  const next = Object.create(Object.getPrototypeOf(value)) as Record<PropertyKey, unknown>;
  seen.set(value, next);
  let changed = false;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) continue;
    const masked = transformSecretValues(descriptor.value, secrets, seen);
    if (masked !== descriptor.value) {
      descriptor.value = masked;
      changed = true;
    }
  }
  if (!changed) {
    seen.set(value, value);
    return value;
  }
  Object.defineProperties(next, descriptors);
  return next;
}

function maskString(value: string, secrets: readonly SecretValue[]): string {
  let masked = value;
  for (const secret of secrets) {
    if (!masked.includes(secret.value)) continue;
    masked = masked.split(secret.value).join(`[REDACTED:${secret.name}]`);
  }
  return masked;
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
