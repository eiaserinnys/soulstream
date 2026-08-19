import allowlistDocument from "./release_env_allowlist.json" with { type: "json" };
import { delimiter, resolve } from "node:path";

import type { AgentProfile } from "../agent_registry.js";
import type { Env } from "../config.js";
import {
  computeRuntimeEnvIdentity,
  type CanonicalJsonValue,
  type RuntimeCredentialDescriptor,
} from "./release_manifest.js";

type AllowlistEntry = {
  owner: string;
  kind: "non_secret" | "credential";
  normalization: string;
};

const allowlist = allowlistDocument.entries as Record<string, AllowlistEntry>;
const SECRET_NAME = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/i;

export function deploymentEnvIdentity(
  env: Env,
  processEnv: NodeJS.ProcessEnv,
  options: { runtimeCwd: string },
): string {
  const nonSecrets: Record<string, CanonicalJsonValue> = {};
  const credentials: RuntimeCredentialDescriptor[] = [];
  for (const key of Object.keys(allowlist).sort()) {
    const policy = allowlist[key]!;
    const parsed = (env as unknown as Record<string, unknown>)[key];
    const raw = processEnv[key];
    if (policy.kind === "credential") {
      credentials.push({
        slot: key,
        present: typeof raw === "string" && raw.length > 0,
        validation: "presence_only",
        generation: processEnv[`${key}_GENERATION`]?.trim() || null,
      });
      continue;
    }
    const value = parsed ?? raw;
    nonSecrets[key] = normalizeNonSecret(
      value,
      policy.normalization,
      options.runtimeCwd,
    );
  }
  return computeRuntimeEnvIdentity({ nonSecrets, credentials });
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

function normalizeNonSecret(
  value: unknown,
  normalization: string,
  runtimeCwd: string,
): CanonicalJsonValue {
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
  if (normalization === "path") return text.length === 0 ? "" : resolve(runtimeCwd, text);
  if (normalization === "path_list") {
    return text.split(delimiter).map((entry) => resolve(runtimeCwd, entry));
  }
  if (normalization === "string_array") {
    return text.split(",").map((entry) => entry.trim().normalize("NFC")).filter(Boolean);
  }
  return text;
}
