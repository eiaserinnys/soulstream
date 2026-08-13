import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  McpServerConfig,
  Options as ClaudeSdkOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ResolvedMcpServer } from "../mcp_config_service.js";
import type { ClaudeRunOptions } from "./claude_adapter.js";
import {
  asRecord,
  asString,
} from "./claude_sdk_helpers.js";
import {
  isSoulstreamMcpServerName,
  mergeSoulstreamAgentSessionHeader,
  normalizeSoulstreamInternalMcpUrl,
} from "./soulstream_internal_mcp.js";

const MCP_CONFIG_FILES = ["mcp_config.json", ".mcp.json"] as const;

export function buildMcpOptions(
  options: ClaudeRunOptions,
  logger: Logger,
): Partial<ClaudeSdkOptions> {
  const strictMcpConfig = options.resolvedMcpServers !== undefined;
  if (options.useMcp === false) {
    return strictMcpConfig
      ? { mcpServers: {}, strictMcpConfig: true }
      : {};
  }
  const mcpServers = strictMcpConfig
    ? toClaudeMcpServers(options.resolvedMcpServers ?? [])
    : loadMcpServers(options.workspaceDir, logger);
  if (mcpServers === undefined) return {};
  return {
    mcpServers: prepareSoulstreamInternalMcpServers(
      mcpServers,
      options.agentSessionId,
      options.internalMcpUrl,
    ),
    ...(strictMcpConfig ? { strictMcpConfig: true } : {}),
  };
}

function toClaudeMcpServers(
  servers: ResolvedMcpServer[],
): Record<string, McpServerConfig> {
  const resolved: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    const name = requiredServerName(server);
    if (resolved[name]) {
      throw new Error(`Claude MCP profile contains duplicate server name: ${name}`);
    }

    if (server.type === "stdio") {
      if (!server.command) {
        throw new Error(
          `Claude MCP stdio server ${name} requires command; full_command is unsupported`,
        );
      }
      if (server.cwd || server.headers) {
        throw new Error(
          `Claude MCP stdio server ${name} uses unsupported cwd or headers`,
        );
      }
      resolved[name] = {
        type: "stdio",
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
        ...(server.timeout ? { timeout: server.timeout } : {}),
      };
      continue;
    }

    resolved[name] = {
      type: server.type === "streamable_http" ? "http" : "sse",
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
      ...(server.timeout ? { timeout: server.timeout } : {}),
    };
  }
  return resolved;
}

function requiredServerName(server: ResolvedMcpServer): string {
  const name = server.name?.trim();
  if (!name) {
    throw new Error("Resolved MCP profile server requires a name");
  }
  return name;
}

function loadMcpServers(
  workspaceDir: string,
  logger: Logger,
): Record<string, McpServerConfig> | undefined {
  const configPath = MCP_CONFIG_FILES
    .map((fileName) => join(workspaceDir, fileName))
    .find((candidate) => existsSync(candidate));
  if (!configPath) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to read Claude MCP config at ${configPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new Error(`Claude MCP config at ${configPath} must be a JSON object`);
  }

  const servers = asRecord(root.mcpServers) ?? root;
  logger.debug(
    { configPath, serverNames: Object.keys(servers) },
    "Loaded Claude MCP config",
  );
  return servers as Record<string, McpServerConfig>;
}

function prepareSoulstreamInternalMcpServers(
  servers: Record<string, McpServerConfig>,
  agentSessionId: string | undefined,
  internalMcpUrl: string | undefined,
): Record<string, McpServerConfig> {
  const callerSessionId = agentSessionId?.trim();

  const patched: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    patched[name] = shouldPrepareSoulstreamInternalServer(name)
      ? prepareSoulstreamInternalMcpServer(config, callerSessionId, internalMcpUrl)
      : config;
  }
  return patched;
}

function shouldPrepareSoulstreamInternalServer(serverName: string): boolean {
  return isSoulstreamMcpServerName(serverName);
}

function prepareSoulstreamInternalMcpServer(
  config: McpServerConfig,
  agentSessionId: string | undefined,
  internalMcpUrl: string | undefined,
): McpServerConfig {
  const record = asRecord(config);
  const type = asString(record?.type);
  if (type !== "sse" && type !== "streamable_http" && type !== "http") {
    return config;
  }
  if (type !== "sse" && !internalMcpUrl) {
    throw new Error(
      "Soulstream internal HTTP MCP server requires a node-local internalMcpUrl",
    );
  }

  return {
    ...record,
    ...(type === "sse"
      ? {}
      : { url: normalizeSoulstreamInternalMcpUrl(internalMcpUrl!) }),
    ...(agentSessionId
      ? {
          headers: mergeSoulstreamAgentSessionHeader(
            record?.headers,
            agentSessionId,
          ),
        }
      : {}),
  } as McpServerConfig;
}
