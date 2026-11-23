import fs from "node:fs";
import path from "node:path";

import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  AgentsSdkHostedToolSchema,
  type AgentsSdkHostedTool,
  type AgentsSdkMcpServer,
  type AgentProfile,
} from "@soulstream/agent-profile-contract";
import { CentralMcpState, isPortableMcpNode, type CentralSync } from "./mcp_central/state.js";
import { sanitizeServer, sanitizeHostedTool } from "./mcp_central/display.js";
import { resolveCentralTemplate, resolveHostedTool } from "./mcp_central/templates.js";

import { isRecord } from "@soulstream/wire-schema/json-record";

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
  modePath?: string;
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
  private readonly central: CentralMcpState<McpRegistryConfig, McpProfilesConfig>;

  constructor(options: McpConfigServiceOptions) {
    this.registryPath = options.registryPath ?? defaultMcpRegistryPath(options.agentsConfigPath);
    this.profilesPath = options.profilesPath ?? defaultMcpProfilesPath(options.agentsConfigPath);
    this.processEnv = options.processEnv ?? process.env;
    this.central = new CentralMcpState(options.modePath, (input) => {
      const raw = z.object({ registry: McpRegistryConfigSchema, profiles: McpProfilesConfigSchema,
        agent_bindings: z.record(z.string(), z.string().min(1)) }).parse(input);
      this.assertProfileServerReferences(raw.profiles, raw.registry);
      const ids = new Set(raw.profiles.profiles.map((profile) => profile.id));
      for (const id of Object.values(raw.agent_bindings)) {
        if (!ids.has(id)) throw new Error(`MCP binding references missing profile: ${id}`);
      }
      return raw;
    });
  }

  configStatus() { return this.central.status(); }

  isPortableNode(): boolean { return isPortableMcpNode(this.processEnv); }

  async applyCentralSync(input: CentralSync): Promise<void> { await this.central.apply(input); }

  waitForInitialCentralSync(timeoutMs: number): Promise<void> { return this.central.wait(timeoutMs); }

  assertCentralReady(): void { this.central.assertReady(); }

  effectiveAgentMcpProfileId(profile: AgentProfile): string | undefined {
    const central = this.central.current("runtime");
    return central ? central.agent_bindings[profile.id] : profile.mcp_profile;
  }

  readRegistry(): McpRegistryConfig {
    const central = this.central.current("runtime");
    if (central) return central.registry;
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
      servers: (this.central.current("display")?.registry ?? this.readRegistry()).servers.map((server) => sanitizeServer(server, this.processEnv)),
    };
  }

  listProfiles(): { profiles_path: string; profiles: Array<Record<string, unknown>> } {
    return {
      profiles_path: this.profilesPath,
      profiles: (this.central.current("display")?.profiles ?? this.readProfiles()).profiles.map((profile) => ({
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

  resolveProfilesIsolated(
    profiles: AgentProfile[],
    logger: Pick<Logger, "warn">,
  ): AgentProfile[] {
    return profiles.map((profile) => {
      try {
        return this.resolveAgentProfile(profile);
      } catch (error) {
        logger.warn(
          {
            agentId: profile.id,
            err: error instanceof Error ? error : new Error(String(error)),
          },
          "Agent MCP profile resolution failed; other profiles remain available",
        );
        return profile;
      }
    });
  }

  resolveMcpProfile(profile: AgentProfile): ResolvedMcpProfile | undefined {
    const profileId = this.effectiveAgentMcpProfileId(profile);
    if (!profileId) return undefined;

    const registry = this.readRegistry();
    const profiles = this.readProfilesForRegistry(registry);
    const mcpProfile = profiles.profiles.find((entry) => entry.id === profileId);
    if (!mcpProfile) {
      throw new Error(`MCP profile not found: ${profileId}`);
    }
    return {
      mcp_servers: mcpProfile.mcp_servers.map((serverId) =>
        this.resolveRegistryServer(serverId, registry)
      ),
      hosted_tools: this.central.status().mode === "central"
        ? mcpProfile.hosted_tools.map((tool) => resolveHostedTool(tool, this.processEnv))
        : mcpProfile.hosted_tools,
    };
  }

  resolveAgentProfile(profile: AgentProfile): AgentProfile {
    if (!this.effectiveAgentMcpProfileId(profile)) return profile;

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
    const profiles = this.central.current("runtime")?.profiles ?? readOptionalYaml(
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
      this.central.status().mode === "central",
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
  central: boolean,
): Record<string, unknown> {
  return {
    ...server,
    ...(central && typeof server.url === "string" ? { url: resolveCentralTemplate(server.url, processEnv, `MCP registry server ${serverId} url`) } : {}),
    ...(isRecord(server.env)
      ? { env: resolveSecretRecord(server.env, `MCP registry server ${serverId} env`, processEnv, central) }
      : {}),
    ...(isRecord(server.headers)
      ? {
          headers: resolveSecretRecord(
            server.headers,
            `MCP registry server ${serverId} header`,
            processEnv,
            central,
          ),
        }
      : {}),
  };
}

function resolveSecretRecord(
  record: Record<string, unknown>,
  label: string,
  processEnv: Record<string, string | undefined>,
  central: boolean,
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
      return [key, central ? resolveCentralTemplate(String(value), processEnv, `${label} ${key}`) : String(value)];
    }),
  );
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

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
