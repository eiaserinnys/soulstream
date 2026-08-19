import allowlistDocument from "./release_env_allowlist.json" with { type: "json" };

import type { AgentProfile } from "../agent_registry.js";
import type { Env } from "../config.js";
import {
  computeRuntimeEnvIdentity,
  type CanonicalJsonValue,
  type ReleaseExecutableIdentity,
  type RuntimeCredentialDescriptor,
} from "./release_manifest.js";

/**
 * `identity_scope` splits the two jobs this allowlist does.
 *
 * - `deployment`: the operator *declares* the value in the deployment env document.
 *   It is immutable for the life of a release, so it belongs in the manifest digest.
 * - `ambient`: the value is machine/process state (PATH, HOME, ...). The inventory test
 *   still requires it to be listed, but it must never reach an immutable identity —
 *   it differs between the clean build environment and the live service process, and a
 *   digest over it makes every node unbootable after the first restart.
 */
type AllowlistEntry = {
  owner: string;
  kind: "non_secret" | "credential";
  identity_scope: "deployment" | "ambient";
  normalization?: string;
};

/**
 * The dotenv-parsed deployment env document. Build and startup read the same file, so
 * this map — and nothing about the surrounding process — decides the env identity.
 */
export type DeclaredDeploymentEnv = Readonly<Record<string, string>>;

const allowlist = allowlistDocument.entries as Record<string, AllowlistEntry>;
const SECRET_NAME = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/i;

export function deploymentEnvIdentity(env: Env, declared: DeclaredDeploymentEnv): string {
  const nonSecrets: Record<string, CanonicalJsonValue> = {};
  const credentials: RuntimeCredentialDescriptor[] = [];
  for (const key of deploymentIdentityKeys()) {
    const policy = allowlist[key]!;
    const raw = declaredValue(declared, key);
    if (policy.kind === "credential") {
      credentials.push({
        slot: key,
        present: raw !== undefined && raw.length > 0,
        validation: "declared_presence_only",
        generation: declaredValue(declared, `${key}_GENERATION`)?.trim() || null,
      });
      continue;
    }
    // An undeclared key contributes the same absence on both sides; reading the parsed
    // config for it would re-admit whatever the ambient process happened to export.
    if (raw === undefined) {
      nonSecrets[key] = null;
      continue;
    }
    const typed = (env as unknown as Record<string, unknown>)[key];
    nonSecrets[key] = normalizeNonSecret(typed ?? raw, policy.normalization!);
  }
  return computeRuntimeEnvIdentity({ nonSecrets, credentials });
}

/**
 * Executable identity is bound to the declared pin only. Resolving through PATH would
 * read the ambient process again: the clean build environment and the live service
 * resolve different binaries (or none at all), which fails the manifest at startup.
 */
export function declaredExecutablePath(
  declared: DeclaredDeploymentEnv,
  kind: ReleaseExecutableIdentity["kind"],
): string | undefined {
  const slot = kind === "claude" ? "CLAUDE_CODE_EXECPATH" : "CODEX_CLI_PATH";
  const raw = declaredValue(declared, slot);
  return raw && raw.length > 0 ? raw : undefined;
}

export function agentRuntimeEnvIdentity(agent: Pick<AgentProfile, "id" | "env">): string {
  const nonSecrets: Record<string, CanonicalJsonValue> = { agent_id: agent.id };
  const credentials: RuntimeCredentialDescriptor[] = [];
  for (const [key, raw] of Object.entries(agent.env ?? {}).sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))) {
    const policy = allowlist[key];
    if (policy?.kind === "credential" || SECRET_NAME.test(key)) {
      credentials.push({
        slot: key,
        present: raw.length > 0,
        validation: "profile_slot_presence_only",
        generation: null,
      });
    } else {
      nonSecrets[key] = raw.normalize("NFC");
    }
  }
  return computeRuntimeEnvIdentity({ nonSecrets, credentials });
}

export function releaseEnvAllowlistKeys(): readonly string[] {
  return Object.keys(allowlist).sort();
}

export function releaseEnvAllowlistEntry(key: string): Readonly<AllowlistEntry> | undefined {
  return allowlist[key];
}

export function deploymentIdentityKeys(): readonly string[] {
  return Object.keys(allowlist)
    .filter((key) => allowlist[key]!.identity_scope === "deployment")
    .sort();
}

function declaredValue(declared: DeclaredDeploymentEnv, key: string): string | undefined {
  return Object.hasOwn(declared, key) ? declared[key] : undefined;
}

function normalizeNonSecret(value: unknown, normalization: string): CanonicalJsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).normalize("NFC"));
  }
  const text = String(value).normalize("NFC");
  if (normalization === "boolean") return text === "true";
  if (normalization === "number") {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) throw new Error(`invalid numeric release env value: ${text}`);
    return parsed;
  }
  if (normalization === "url") return new URL(text).toString();
  // Paths stay as declared. Resolving them against a cwd would bind the identity to
  // where the process happens to run, which build and startup do not share.
  if (normalization === "string_array") {
    return text.split(",").map((entry) => entry.trim().normalize("NFC")).filter(Boolean);
  }
  return text;
}
