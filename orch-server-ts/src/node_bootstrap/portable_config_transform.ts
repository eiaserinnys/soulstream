import { createHash } from "node:crypto";

export type PortableConfigExclusionReason =
  | "not_trusted"
  | "backend_unavailable"
  | "missing_secret"
  | "company_blocked"
  | "host_specific_workspace"
  | "no_default_preset"
  | "host_local"
  | "not_allowed";

export type PortableConfigExclusion = {
  readonly id: string;
  readonly reason: PortableConfigExclusionReason;
};

export type PortableConfigPolicy = {
  readonly source_workspace_dir: string;
  readonly public_env: Readonly<Record<string, string>>;
  readonly mcp_public_urls: Readonly<Record<string, string>>;
  readonly personal_allow: readonly string[];
  readonly company_allow: readonly string[];
};

export type PortableConfigTransformInput = {
  readonly agentsConfig: unknown;
  readonly modelCatalog: unknown;
  readonly mcpRegistry: unknown;
  readonly mcpProfiles: unknown;
  readonly policy: PortableConfigPolicy;
  readonly sourceEnv: Readonly<Record<string, string>>;
  readonly companyPc: boolean;
  readonly sourceCommit: string;
};

export type PortableConfigResponse = {
  readonly config_generation: string;
  readonly source_commit: string;
  readonly agents: { readonly agents: readonly Record<string, unknown>[] };
  readonly model_catalog: { readonly presets: readonly Record<string, unknown>[] };
  readonly mcp_registry: { readonly servers: readonly Record<string, unknown>[] };
  readonly mcp_profiles: { readonly profiles: readonly Record<string, unknown>[] };
  readonly env: Readonly<Record<string, string>>;
  readonly excluded: {
    readonly presets: readonly PortableConfigExclusion[];
    readonly agents: readonly PortableConfigExclusion[];
    readonly mcp_servers: readonly PortableConfigExclusion[];
  };
};

export type PortableConfigTransformResult = {
  readonly response: PortableConfigResponse;
  readonly remainingAgentIds: ReadonlySet<string>;
  readonly remainingPresetIds: ReadonlySet<string>;
};

export class PortableConfigTransformError extends Error {
  constructor(readonly code: "TRUST_CLASSIFICATION_PENDING") {
    super(code);
    this.name = "PortableConfigTransformError";
  }
}

const SUPPORTED_BACKENDS = new Set(["claude", "codex"]);
const SOULSTREAM_SERVER_IDS = new Set(["soulstream", "soulstream-cogito"]);
const LOCAL_MCP_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SOULSTREAM_LOCAL_MCP_URL = "http://127.0.0.1:__SOUL_HOST_PORT__/mcp";
export const PORTABLE_LOCAL_MCP_AUTHORIZATION_ENV = "PORTABLE_LOCAL_MCP_AUTHORIZATION";
const COMPANY_BLOCKED_MODEL_PATTERN = /deepseek|kimi|moonshot|qwen|glm|zhipu|opencode/i;
const COMPANY_BLOCKED_ENV_KEY_PATTERN = /KIMI|DEEPSEEK|MOONSHOT|OPENCODE|QWEN|GLM|ZHIPU/i;
const FORBIDDEN_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "AUTH_BEARER_TOKEN",
  "DATABASE_URL",
  "JWT_SECRET",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_CLIENT_SECRET",
]);
const CORE_ENV_KEY = "ATOM_API_KEY";
const STATE_ROOT_WORKSPACE_DIR = "__STATE_ROOT__/workspace";

export function transformPortableConfig(
  input: PortableConfigTransformInput,
): PortableConfigTransformResult {
  const allow = input.companyPc ? input.policy.company_allow : input.policy.personal_allow;
  const allowedEnvKeys = new Set(allow.filter((entry) => !entry.startsWith("mcp:")));
  const allowedMcpIds = new Set(
    allow.filter((entry) => entry.startsWith("mcp:")).map((entry) => entry.slice("mcp:".length)),
  );
  const hasEnvValue = (key: string): boolean => {
    const value = input.sourceEnv[key];
    return typeof value === "string" && value.length > 0;
  };

  const presetEntries = recordsAt(input.modelCatalog, "presets");
  if (!presetEntries.some((preset) => preset.trusted_execution === true)) {
    throw new PortableConfigTransformError("TRUST_CLASSIFICATION_PENDING");
  }

  const remainingPresets: Record<string, unknown>[] = [];
  const excludedPresets: PortableConfigExclusion[] = [];
  const presetReasons = new Map<string, PortableConfigExclusionReason>();

  for (const preset of presetEntries) {
    const id = stringField(preset, "id");
    const exclude = (reason: PortableConfigExclusionReason): void => {
      presetReasons.set(id, reason);
      excludedPresets.push({ id, reason });
    };
    if (preset.trusted_execution !== true) {
      exclude("not_trusted");
      continue;
    }
    if (!SUPPORTED_BACKENDS.has(stringField(preset, "backend"))) {
      exclude("backend_unavailable");
      continue;
    }
    if (
      collectEnvRefs(preset.env).some(
        (key) => !allowedEnvKeys.has(key) || !hasEnvValue(key),
      )
    ) {
      exclude("missing_secret");
      continue;
    }
    if (
      input.companyPc
      && COMPANY_BLOCKED_MODEL_PATTERN.test(
        [
          id,
          stringField(preset, "model"),
          stringField(preset, "usage_provider"),
        ].join("\n"),
      )
    ) {
      exclude("company_blocked");
      continue;
    }
    remainingPresets.push(preset);
  }

  const remainingPresetById = new Map(
    remainingPresets.map((preset) => [stringField(preset, "id"), preset]),
  );
  const remainingAgents: Record<string, unknown>[] = [];
  const excludedAgents: PortableConfigExclusion[] = [];

  for (const agent of recordsAt(input.agentsConfig, "agents")) {
    const id = stringField(agent, "id");
    const exclude = (reason: PortableConfigExclusionReason): void => {
      excludedAgents.push({ id, reason });
    };
    const backend = stringField(agent, "backend");
    if (!SUPPORTED_BACKENDS.has(backend)) {
      exclude("backend_unavailable");
      continue;
    }
    const defaultPreset = stringField(agent, "default_preset");
    if (defaultPreset.length === 0) {
      exclude("no_default_preset");
      continue;
    }
    const preset = remainingPresetById.get(defaultPreset);
    if (preset === undefined) {
      exclude(presetReasons.get(defaultPreset) ?? "no_default_preset");
      continue;
    }
    if (stringField(preset, "backend") !== backend) {
      exclude("backend_unavailable");
      continue;
    }
    if (stringField(agent, "workspace_dir") !== input.policy.source_workspace_dir) {
      exclude("host_specific_workspace");
      continue;
    }
    const { portrait_path: _portraitPath, ...rest } = agent;
    void _portraitPath;
    remainingAgents.push({ ...rest, workspace_dir: STATE_ROOT_WORKSPACE_DIR });
  }

  const keptServers: Record<string, unknown>[] = [];
  const excludedServers: PortableConfigExclusion[] = [];

  for (const server of recordsAt(input.mcpRegistry, "servers")) {
    const id = stringField(server, "id");
    const exclude = (reason: PortableConfigExclusionReason): void => {
      excludedServers.push({ id, reason });
    };
    if (stringField(server, "type") === "stdio") {
      exclude("host_local");
      continue;
    }
    if (SOULSTREAM_SERVER_IDS.has(id)) {
      if (!allowedMcpIds.has(id)) {
        exclude("not_allowed");
        continue;
      }
      if (!headerRefsAllowed(server.headers, allowedEnvKeys, hasEnvValue, true)) {
        exclude("missing_secret");
        continue;
      }
      keptServers.push(rewriteSoulstreamServer(server));
      continue;
    }
    const url = stringField(server, "url");
    let rewrittenUrl: string | undefined;
    if (isLocalMcpUrl(url)) {
      const publicUrl = input.policy.mcp_public_urls[id];
      if (typeof publicUrl !== "string" || publicUrl.length === 0) {
        exclude("host_local");
        continue;
      }
      rewrittenUrl = publicUrl;
    }
    if (!allowedMcpIds.has(id)) {
      exclude("not_allowed");
      continue;
    }
    if (!headerRefsAllowed(server.headers, allowedEnvKeys, hasEnvValue, false)) {
      exclude("missing_secret");
      continue;
    }
    keptServers.push(rewrittenUrl === undefined ? server : { ...server, url: rewrittenUrl });
  }

  const keptServerIds = new Set(keptServers.map((server) => stringField(server, "id")));
  const referencedProfileIds = new Set(
    remainingAgents
      .map((agent) => stringField(agent, "mcp_profile"))
      .filter((profileId) => profileId.length > 0),
  );
  const remainingProfiles = recordsAt(input.mcpProfiles, "profiles")
    .filter((profile) => referencedProfileIds.has(stringField(profile, "id")))
    .map((profile) => ({
      ...profile,
      mcp_servers: arrayField(profile, "mcp_servers").filter(
        (serverId): serverId is string =>
          typeof serverId === "string" && keptServerIds.has(serverId),
      ),
    }));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.policy.public_env)) {
    if (FORBIDDEN_ENV_KEYS.has(key)) continue;
    if (input.companyPc && COMPANY_BLOCKED_ENV_KEY_PATTERN.test(key)) continue;
    env[key] = value;
  }
  const referencedEnvKeys = new Set<string>([CORE_ENV_KEY]);
  for (const preset of remainingPresets) {
    for (const key of collectEnvRefs(preset.env)) referencedEnvKeys.add(key);
  }
  for (const server of keptServers) {
    for (const key of collectHeaderEnvRefs(server.headers)) {
      if (key === PORTABLE_LOCAL_MCP_AUTHORIZATION_ENV) continue;
      referencedEnvKeys.add(key);
    }
  }
  for (const key of referencedEnvKeys) {
    if (!allowedEnvKeys.has(key)) continue;
    if (FORBIDDEN_ENV_KEYS.has(key)) continue;
    if (input.companyPc && COMPANY_BLOCKED_ENV_KEY_PATTERN.test(key)) continue;
    if (!hasEnvValue(key)) continue;
    env[key] = input.sourceEnv[key] as string;
  }

  const excluded = {
    presets: excludedPresets,
    agents: excludedAgents,
    mcp_servers: excludedServers,
  };
  const configGeneration = buildConfigGeneration({
    sourceCommit: input.sourceCommit,
    agents: remainingAgents,
    presets: remainingPresets,
    servers: keptServers,
    profiles: remainingProfiles,
    excluded,
    envKeys: Object.keys(env),
  });

  return {
    response: {
      config_generation: configGeneration,
      source_commit: input.sourceCommit,
      agents: { agents: remainingAgents },
      model_catalog: { presets: remainingPresets },
      mcp_registry: { servers: keptServers },
      mcp_profiles: { profiles: remainingProfiles },
      env,
      excluded,
    },
    remainingAgentIds: new Set(remainingAgents.map((agent) => stringField(agent, "id"))),
    remainingPresetIds: new Set(
      remainingPresets.map((preset) => stringField(preset, "id")),
    ),
  };
}

function buildConfigGeneration(input: {
  sourceCommit: string;
  agents: readonly Record<string, unknown>[];
  presets: readonly Record<string, unknown>[];
  servers: readonly Record<string, unknown>[];
  profiles: readonly Record<string, unknown>[];
  excluded: PortableConfigResponse["excluded"];
  envKeys: readonly string[];
}): string {
  const canonical = canonicalJson({
    source_commit: input.sourceCommit,
    agents: { agents: input.agents },
    model_catalog: { presets: input.presets },
    mcp_registry: { servers: input.servers },
    mcp_profiles: { profiles: input.profiles },
    excluded: input.excluded,
    env_keys: [...input.envKeys].sort(),
  });
  return `g-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

function rewriteSoulstreamServer(server: Record<string, unknown>): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  if (isRecord(server.headers)) {
    for (const [key, value] of Object.entries(server.headers)) {
      if (key.toLowerCase() === "authorization") continue;
      headers[key] = value;
    }
  }
  headers.Authorization = { env: PORTABLE_LOCAL_MCP_AUTHORIZATION_ENV };
  return { ...server, url: SOULSTREAM_LOCAL_MCP_URL, headers };
}

function headerRefsAllowed(
  headers: unknown,
  allowedEnvKeys: ReadonlySet<string>,
  hasEnvValue: (key: string) => boolean,
  skipAuthorization: boolean,
): boolean {
  if (!isRecord(headers)) return true;
  for (const [key, value] of Object.entries(headers)) {
    if (skipAuthorization && key.toLowerCase() === "authorization") continue;
    if (!isRecord(value)) continue;
    const envKey = value.env;
    if (typeof envKey !== "string") continue;
    if (!allowedEnvKeys.has(envKey) || !hasEnvValue(envKey)) return false;
  }
  return true;
}

function collectEnvRefs(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const keys: string[] = [];
  for (const entry of Object.values(value)) {
    if (typeof entry !== "string") continue;
    for (const match of entry.matchAll(/\$\{([^}]+)\}/g)) {
      const key = match[1];
      if (typeof key === "string" && key.length > 0) keys.push(key);
    }
  }
  return keys;
}

function collectHeaderEnvRefs(headers: unknown): string[] {
  if (!isRecord(headers)) return [];
  const keys: string[] = [];
  for (const value of Object.values(headers)) {
    if (!isRecord(value)) continue;
    if (typeof value.env === "string" && value.env.length > 0) keys.push(value.env);
  }
  return keys;
}

function isLocalMcpUrl(url: string): boolean {
  if (url.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const normalized = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return LOCAL_MCP_HOSTS.has(normalized);
}

function recordsAt(value: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const entries = value[key];
  if (!Array.isArray(entries)) return [];
  return entries.filter(isRecord);
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortJson(record[key])]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
