import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  AgentsSdkHostedToolSchema,
  type AgentsSdkHostedTool,
  type AgentsSdkMcpServer,
  type AgentProfile,
} from "./agent_registry.js";

export const DEFAULT_MCP_REGISTRY_BASENAME = "mcp-registry.yaml";
export const DEFAULT_MCP_PROFILES_BASENAME = "mcp-profiles.yaml";

const SecretRefSchema = z.object({ env: z.string().min(1) });
const SecretValueSchema = z.union([z.string(), SecretRefSchema]);
const SecretRecordSchema = z.record(z.string(), SecretValueSchema);

const RegistryStdioServerSchema = z.object({
  id: z.string().min(1),
  type: z.literal("stdio"),
  name: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  full_command: z.string().min(1).optional(),
  env: SecretRecordSchema.optional(),
  cwd: z.string().optional(),
  cache_tools_list: z.boolean().optional(),
  timeout: z.number().positive().optional(),
  headers: SecretRecordSchema.optional(),
}).superRefine((server, ctx) => {
  if (!server.command && !server.full_command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: "stdio mcp registry server requires command or full_command",
    });
  }
});

const RegistryStreamableHttpServerSchema = z.object({
  id: z.string().min(1),
  type: z.literal("streamable_http"),
  name: z.string().min(1).optional(),
  url: z.string().min(1, "streamable_http mcp registry server url required"),
  headers: SecretRecordSchema.optional(),
  cache_tools_list: z.boolean().optional(),
  timeout: z.number().positive().optional(),
  session_id: z.string().min(1).optional(),
});

const RegistrySseServerSchema = z.object({
  id: z.string().min(1),
  type: z.literal("sse"),
  name: z.string().min(1).optional(),
  url: z.string().min(1, "sse mcp registry server url required"),
  headers: SecretRecordSchema.optional(),
  cache_tools_list: z.boolean().optional(),
  timeout: z.number().positive().optional(),
});

const McpRegistryServerSchema = z.union([
  RegistryStdioServerSchema,
  RegistryStreamableHttpServerSchema,
  RegistrySseServerSchema,
]);

const McpRegistryConfigSchema = z.object({
  servers: z.array(McpRegistryServerSchema).default([]),
}).superRefine((config, ctx) => {
  checkDuplicateIds(config.servers, ctx, "servers");
});

const McpProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  mcp_servers: z.array(z.string().min(1)).default([]),
  hosted_tools: z.array(AgentsSdkHostedToolSchema).default([]),
});

const McpProfilesConfigSchema = z.object({
  profiles: z.array(McpProfileSchema).default([]),
}).superRefine((config, ctx) => {
  checkDuplicateIds(config.profiles, ctx, "profiles");
});

export type McpRegistryServer = z.infer<typeof McpRegistryServerSchema>;
export type McpRegistryConfig = z.infer<typeof McpRegistryConfigSchema>;
export type McpProfile = z.infer<typeof McpProfileSchema>;
export type McpProfilesConfig = z.infer<typeof McpProfilesConfigSchema>;
export type ResolvedMcpServer = AgentsSdkMcpServer;

export interface ResolvedMcpProfile {
  mcp_servers: ResolvedMcpServer[];
  hosted_tools: AgentsSdkHostedTool[];
}

export interface McpConfigServiceOptions {
  agentsConfigPath: string;
  registryPath?: string;
  profilesPath?: string;
  processEnv?: Record<string, string | undefined>;
}

export function defaultMcpRegistryPath(agentsConfigPath: string): string {
  return path.join(path.dirname(agentsConfigPath), DEFAULT_MCP_REGISTRY_BASENAME);
}

export function defaultMcpProfilesPath(agentsConfigPath: string): string {
  return path.join(path.dirname(agentsConfigPath), DEFAULT_MCP_PROFILES_BASENAME);
}

export class McpConfigService {
  readonly registryPath: string;
  readonly profilesPath: string;

  private readonly processEnv: Record<string, string | undefined>;

  constructor(options: McpConfigServiceOptions) {
    this.registryPath = options.registryPath ?? defaultMcpRegistryPath(options.agentsConfigPath);
    this.profilesPath = options.profilesPath ?? defaultMcpProfilesPath(options.agentsConfigPath);
    this.processEnv = options.processEnv ?? process.env;
  }

  readRegistry(): McpRegistryConfig {
    return readOptionalYaml(
      this.registryPath,
      McpRegistryConfigSchema,
      { servers: [] },
    );
  }

  readProfiles(): McpProfilesConfig {
    const registry = this.readRegistry();
    return this.readProfilesForRegistry(registry);
  }

  listRegistry(): { registry_path: string; servers: Array<Record<string, unknown>> } {
    return {
      registry_path: this.registryPath,
      servers: this.readRegistry().servers.map((server) => sanitizeServer(server, this.processEnv)),
    };
  }

  listProfiles(): { profiles_path: string; profiles: Array<Record<string, unknown>> } {
    return {
      profiles_path: this.profilesPath,
      profiles: this.readProfiles().profiles.map((profile) => ({
        id: profile.id,
        ...(profile.name ? { name: profile.name } : {}),
        ...(profile.description ? { description: profile.description } : {}),
        mcp_servers: profile.mcp_servers,
        hosted_tools: profile.hosted_tools.map((tool) =>
          sanitizeHostedTool(tool, this.processEnv)
        ),
      })),
    };
  }

  resolveProfiles(profiles: AgentProfile[]): AgentProfile[] {
    return profiles.map((profile) => this.resolveAgentProfile(profile));
  }

  resolveMcpProfile(profile: AgentProfile): ResolvedMcpProfile | undefined {
    if (!profile.mcp_profile) return undefined;

    const registry = this.readRegistry();
    const profiles = this.readProfilesForRegistry(registry);
    const mcpProfile = profiles.profiles.find((entry) => entry.id === profile.mcp_profile);
    if (!mcpProfile) {
      throw new Error(`MCP profile not found: ${profile.mcp_profile}`);
    }
    return {
      mcp_servers: mcpProfile.mcp_servers.map((serverId) =>
        this.resolveRegistryServer(serverId, registry)
      ),
      hosted_tools: mcpProfile.hosted_tools,
    };
  }

  resolveAgentProfile(profile: AgentProfile): AgentProfile {
    if (!profile.mcp_profile) return profile;

    const resolvedMcpProfile = this.resolveMcpProfile(profile);
    if (!resolvedMcpProfile) return profile;
    if (!profile.agents_sdk) return profile;

    return {
      ...profile,
      agents_sdk: {
        ...profile.agents_sdk,
        agents: profile.agents_sdk.agents.map((agent) => ({
          ...agent,
          mcp_servers: mergeByKey(
            resolvedMcpProfile.mcp_servers,
            agent.mcp_servers,
            mcpServerKey,
          ),
          hosted_tools: mergeByKey(
            resolvedMcpProfile.hosted_tools,
            agent.hosted_tools,
            hostedToolKey,
          ),
        })),
      },
    };
  }

  private readProfilesForRegistry(registry: McpRegistryConfig): McpProfilesConfig {
    const profiles = readOptionalYaml(
      this.profilesPath,
      McpProfilesConfigSchema,
      { profiles: [] },
    );
    this.assertProfileServerReferences(profiles, registry);
    return profiles;
  }

  private resolveRegistryServer(
    serverId: string,
    registry: McpRegistryConfig,
  ): AgentsSdkMcpServer {
    const server = registry.servers.find((entry) => entry.id === serverId);
    if (!server) throw new Error(`MCP registry server not found: ${serverId}`);
    const { id, ...rest } = server;
    return normalizeRegistryServerSecrets(
      {
        ...rest,
        name: rest.name ?? id,
      },
      id,
      this.processEnv,
    ) as AgentsSdkMcpServer;
  }

  private assertProfileServerReferences(
    profiles: McpProfilesConfig,
    registry: McpRegistryConfig,
  ): void {
    const serverIds = new Set(registry.servers.map((server) => server.id));
    for (const profile of profiles.profiles) {
      for (const serverId of profile.mcp_servers) {
        if (!serverIds.has(serverId)) {
          throw new Error(
            `MCP profile ${profile.id} references missing registry server: ${serverId}`,
          );
        }
      }
    }
  }
}

function readOptionalYaml<T>(
  filePath: string,
  schema: z.ZodType<T>,
  emptyValue: T,
): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return emptyValue;
    throw err;
  }
  const parsed: unknown = parseYaml(raw) ?? {};
  return schema.parse(parsed);
}

function normalizeRegistryServerSecrets(
  server: Record<string, unknown>,
  serverId: string,
  processEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  return {
    ...server,
    ...(isRecord(server.env)
      ? { env: resolveSecretRecord(server.env, `MCP registry server ${serverId} env`, processEnv) }
      : {}),
    ...(isRecord(server.headers)
      ? {
          headers: resolveSecretRecord(
            server.headers,
            `MCP registry server ${serverId} header`,
            processEnv,
          ),
        }
      : {}),
  };
}

function resolveSecretRecord(
  record: Record<string, unknown>,
  label: string,
  processEnv: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (isSecretRef(value)) {
        const resolved = processEnv[value.env];
        if (!resolved) {
          throw new Error(`${label} ${key} env ${value.env} is not set`);
        }
        return [key, resolved];
      }
      return [key, String(value)];
    }),
  );
}

function sanitizeServer(
  server: McpRegistryServer,
  processEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  const { id, ...rest } = server;
  return {
    id,
    ...rest,
    ...("url" in server ? { url: sanitizeUrlQuerySecrets(server.url) } : {}),
    ...("env" in server && server.env
      ? { env: sanitizeSecretRecord(server.env, processEnv) }
      : {}),
    ...(server.headers ? { headers: sanitizeSecretRecord(server.headers, processEnv) } : {}),
  };
}

function sanitizeUrlQuerySecrets(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;

  const fragmentStart = url.indexOf("#", queryStart + 1);
  const queryEnd = fragmentStart === -1 ? url.length : fragmentStart;
  const query = url.slice(queryStart + 1, queryEnd);
  if (!query) return url;

  let changed = false;
  const sanitizedQuery = query
    .split("&")
    .map((entry) => {
      const separatorIndex = entry.indexOf("=");
      const rawName = separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
      if (!isSensitiveUrlQueryParam(rawName)) return entry;

      changed = true;
      return `${rawName}=<redacted>`;
    })
    .join("&");

  if (!changed) return url;
  return `${url.slice(0, queryStart + 1)}${sanitizedQuery}${url.slice(queryEnd)}`;
}

function sanitizeSecretRecord(
  record: Record<string, unknown>,
  processEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (isSecretRef(value)) {
        return [key, { env: value.env, resolved: Boolean(processEnv[value.env]) }];
      }
      if (isSensitiveKey(key)) return [key, { redacted: true }];
      return [key, value];
    }),
  );
}

function sanitizeHostedTool(
  tool: AgentsSdkHostedTool,
  processEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  if (tool.type !== "hosted_mcp") return tool;
  return {
    ...tool,
    ...(tool.server_url ? { server_url: sanitizeUrlQuerySecrets(tool.server_url) } : {}),
    ...(tool.authorization ? { authorization: { redacted: true } } : {}),
    ...(tool.headers ? { headers: sanitizeSecretRecord(tool.headers, processEnv) } : {}),
  };
}

function mergeByKey<T>(defaults: T[], overrides: T[], keyOf: (value: T) => string): T[] {
  const result = [...defaults];
  const indexByKey = new Map(result.map((entry, index) => [keyOf(entry), index]));
  for (const override of overrides) {
    const key = keyOf(override);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push(override);
    } else {
      result[existingIndex] = override;
    }
  }
  return result;
}

function mcpServerKey(server: AgentsSdkMcpServer): string {
  if (server.name) return `name:${server.name}`;
  if (server.type === "streamable_http" || server.type === "sse") {
    return `${server.type}:${server.url}`;
  }
  if (server.full_command) return `stdio:full:${server.full_command}`;
  return `stdio:${server.command ?? ""}:${(server.args ?? []).join("\u0000")}`;
}

function hostedToolKey(tool: AgentsSdkHostedTool): string {
  if ("name" in tool && tool.name) return `name:${tool.name}`;
  if (tool.type === "hosted_mcp") return `hosted_mcp:${tool.server_label}`;
  if (tool.type === "file_search") {
    return `file_search:${tool.vector_store_ids.join("\u0000")}`;
  }
  if (tool.type === "code_interpreter") {
    return `code_interpreter:${JSON.stringify(tool.container ?? "")}`;
  }
  return tool.type;
}

function checkDuplicateIds(
  entries: Array<{ id: string }>,
  ctx: z.RefinementCtx,
  pathName: string,
): void {
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [pathName, index, "id"],
        message: `Duplicate MCP ${pathName} id: ${entry.id}`,
      });
    }
    seen.add(entry.id);
  }
}

function isSecretRef(value: unknown): value is { env: string } {
  return isRecord(value) && typeof value.env === "string";
}

function isSensitiveKey(key: string): boolean {
  return /authorization|api[_-]?key|token|secret|password|cookie/i.test(key);
}

function isSensitiveUrlQueryParam(rawName: string): boolean {
  const decodedName = decodeUrlQueryParamName(rawName);
  const segments = decodedName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  if (
    segments.some((segment) =>
      [
        "auth",
        "authorization",
        "cookie",
        "credential",
        "credentials",
        "key",
        "password",
        "passwd",
        "secret",
        "sig",
        "signature",
        "token",
      ].includes(segment)
    )
  ) {
    return true;
  }

  const collapsed = segments.join("");
  return /apikey|accesskey|clientkey|privatekey|secretkey|signingkey|accesstoken|authtoken|refreshtoken|clientsecret/.test(
    collapsed,
  );
}

function decodeUrlQueryParamName(rawName: string): string {
  try {
    return decodeURIComponent(rawName.replace(/\+/g, " "));
  } catch {
    return rawName;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
