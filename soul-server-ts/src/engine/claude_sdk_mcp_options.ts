import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  McpServerConfig,
  Options as ClaudeSdkOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import { asRecord, isRecord } from "@soulstream/wire-schema/json-record";
import type { ResolvedMcpServer } from "../mcp_config_service.js";
import type { ClaudeRunOptions } from "./claude_adapter.js";
import {
  asString,
} from "./claude_sdk_helpers.js";
import {
  isSoulstreamInternalMcpServer,
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
      strictMcpConfig ? undefined : { bearerToken: sessionBearerToken(options.env) },
    ),
    ...(strictMcpConfig ? { strictMcpConfig: true } : {}),
  };
}

/**
 * 작업 공간 MCP 파일의 soulstream 내부 대상 항목에 넣을 세션 자격 증명.
 * 엔진에 넘어온 env의 `AUTH_BEARER_TOKEN`을 그대로 쓴다. full 세션이면 이
 * 값이 이미 ssf1이다.
 */
function sessionBearerToken(
  env: Record<string, string> | undefined,
): string | undefined {
  const token = env?.AUTH_BEARER_TOKEN?.trim();
  return token ? token : undefined;
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

export function loadMcpServers(
  workspaceDir: string,
  logger: Pick<Logger, "debug">,
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
  fileCredential: { bearerToken: string | undefined } | undefined,
): Record<string, McpServerConfig> {
  const callerSessionId = agentSessionId?.trim();

  const patched: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    patched[name] = prepareSoulstreamInternalMcpServer(
      name,
      config,
      callerSessionId,
      internalMcpUrl,
      fileCredential,
    );
  }
  return patched;
}

function prepareSoulstreamInternalMcpServer(
  name: string,
  config: McpServerConfig,
  agentSessionId: string | undefined,
  internalMcpUrl: string | undefined,
  fileCredential: { bearerToken: string | undefined } | undefined,
): McpServerConfig {
  const record = asRecord(config);
  const type = asString(record?.type);
  if (isSoulstreamInternalMcpServer({ name, type: type ?? "" })) {
    if (!internalMcpUrl) {
      throw new Error(
        "Soulstream internal HTTP MCP server requires a node-local internalMcpUrl",
      );
    }
    const mergedHeaders = agentSessionId
      ? mergeSoulstreamAgentSessionHeader(record?.headers, agentSessionId)
      : record?.headers;
    const headers = fileCredential === undefined
      ? mergedHeaders
      : withSessionAuthorization(mergedHeaders, fileCredential.bearerToken);
    return {
      ...record,
      url: normalizeSoulstreamInternalMcpUrl(internalMcpUrl),
      ...(headers !== undefined ? { headers } : {}),
    } as McpServerConfig;
  }
  if (type === "sse" && isSoulstreamMcpServerName(name) && agentSessionId) {
    return {
      ...record,
      headers: mergeSoulstreamAgentSessionHeader(
        record?.headers,
        agentSessionId,
      ),
    } as McpServerConfig;
  }
  return config;
}

/**
 * 파일에 적힌 authorization 헤더(대소문자 무관)를 지우고 세션 토큰을 넣는다.
 * 토큰이 없으면 헤더를 지우기만 한다.
 */
function withSessionAuthorization(
  headers: unknown,
  bearerToken: string | undefined,
): Record<string, string> | undefined {
  const replaced: Record<string, string> = {};
  if (isRecord(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "authorization") continue;
      if (typeof value === "string") replaced[key] = value;
    }
  }
  if (bearerToken) replaced.Authorization = `Bearer ${bearerToken}`;
  return Object.keys(replaced).length > 0 ? replaced : undefined;
}
