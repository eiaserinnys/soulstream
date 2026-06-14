import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  McpServerConfig,
  Options as ClaudeSdkOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeRunOptions } from "./claude_adapter.js";
import {
  asRecord,
  asString,
} from "./claude_sdk_helpers.js";
import { SOULSTREAM_AGENT_SESSION_HEADER } from "../mcp/request_context.js";

const MCP_CONFIG_FILE = "mcp_config.json";

export function buildMcpOptions(
  options: ClaudeRunOptions,
  logger: Logger,
): Partial<ClaudeSdkOptions> {
  if (options.useMcp === false) return {};
  const mcpServers = loadMcpServers(options.workspaceDir, logger);
  if (mcpServers === undefined) return {};
  return {
    mcpServers: injectAgentSessionHeaderIntoMcpServers(
      mcpServers,
      options.agentSessionId,
    ),
  };
}

function loadMcpServers(
  workspaceDir: string,
  logger: Logger,
): Record<string, McpServerConfig> | undefined {
  const configPath = join(workspaceDir, MCP_CONFIG_FILE);
  if (!existsSync(configPath)) return undefined;

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

function injectAgentSessionHeaderIntoMcpServers(
  servers: Record<string, McpServerConfig>,
  agentSessionId: string | undefined,
): Record<string, McpServerConfig> {
  const callerSessionId = agentSessionId?.trim();
  if (!callerSessionId) return servers;

  const patched: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    patched[name] = injectAgentSessionHeaderIntoMcpServer(
      config,
      callerSessionId,
    );
  }
  return patched;
}

function injectAgentSessionHeaderIntoMcpServer(
  config: McpServerConfig,
  agentSessionId: string,
): McpServerConfig {
  const record = asRecord(config);
  const type = asString(record?.type);
  if (type !== "sse" && type !== "streamable_http" && type !== "http") {
    return config;
  }

  return {
    ...record,
    headers: mergeAgentSessionHeader(record?.headers, agentSessionId),
  } as McpServerConfig;
}

function mergeAgentSessionHeader(
  headers: unknown,
  agentSessionId: string,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const record = asRecord(headers);
  if (record) {
    for (const [key, value] of Object.entries(record)) {
      if (key.toLowerCase() === SOULSTREAM_AGENT_SESSION_HEADER) continue;
      if (typeof value === "string") {
        merged[key] = value;
      }
    }
  }
  merged[SOULSTREAM_AGENT_SESSION_HEADER] = agentSessionId;
  return merged;
}
