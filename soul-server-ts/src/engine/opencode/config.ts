import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ResolvedMcpServer } from "../../mcp_config_service.js";
import {
  isSoulstreamMcpServerName,
  mergeSoulstreamAgentSessionHeader,
  normalizeSoulstreamInternalMcpUrl,
} from "../soulstream_internal_mcp.js";

export type OpenCodeMcpServer =
  | { type: "remote"; url: string; headers?: Record<string, string>; oauth: false }
  | { type: "local"; command: string[]; environment?: Record<string, string>; cwd?: string };

export interface PrepareOpenCodeSessionOptions {
  workspaceDir: string;
  model: string;
  sessionDirectory: string;
  agentSessionId: string;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  useMcp?: boolean;
  opencodeMcpToolAllowlist?: Record<string, string[]>;
  resolvedMcpServers?: ResolvedMcpServer[];
  internalMcpUrl?: string;
  processEnv: NodeJS.ProcessEnv;
}

export interface PreparedOpenCodeSession {
  configPath: string;
  instructionPath?: string;
  processEnv: NodeJS.ProcessEnv;
}

const CHILD_ENVIRONMENT_KEYS = [
  "PATH", "HOME", "LANG", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
] as const;

function childEnvironment(
  source: NodeJS.ProcessEnv,
  workspaceDir: string,
  configPath: string,
  sessionDirectory: string,
): NodeJS.ProcessEnv {
  const ghConfigDir = source.GH_CONFIG_DIR || (source.XDG_CONFIG_HOME
    ? join(source.XDG_CONFIG_HOME, "gh")
    : join(source.HOME || homedir(), ".config", "gh"));
  const env: NodeJS.ProcessEnv = {
    PWD: workspaceDir,
    OPENCODE_CONFIG: configPath,
    XDG_CONFIG_HOME: join(sessionDirectory, "xdg", "config"),
    XDG_DATA_HOME: join(sessionDirectory, "xdg", "data"),
    XDG_CACHE_HOME: join(sessionDirectory, "xdg", "cache"),
    XDG_STATE_HOME: join(sessionDirectory, "xdg", "state"),
    GH_CONFIG_DIR: ghConfigDir,
  };
  for (const name of CHILD_ENVIRONMENT_KEYS) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function sanitizeOpenCodeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function openCodeMcpToolName(serverName: string, toolName: string): string {
  return `${sanitizeOpenCodeMcpName(serverName)}_${sanitizeOpenCodeMcpName(toolName)}`;
}

function openCodeMcpServers(options: PrepareOpenCodeSessionOptions): Record<string, OpenCodeMcpServer> | undefined {
  if (options.useMcp === false) return undefined;
  const servers: Record<string, OpenCodeMcpServer> = {};
  for (const server of options.resolvedMcpServers ?? []) {
    const name = server.name;
    if (!name) throw new Error("OpenCode MCP server name is required");
    if (options.opencodeMcpToolAllowlist?.[name]?.length === 0) continue;
    if (server.type === "stdio") {
      if (!server.command || server.full_command) {
        throw new Error(`OpenCode MCP server ${name} requires command and args`);
      }
      servers[name] = {
        type: "local",
        command: [server.command, ...(server.args ?? [])],
        ...(server.env !== undefined ? { environment: server.env } : {}),
        ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
      };
      continue;
    }
    if (!server.url) throw new Error(`OpenCode MCP server ${name} requires a URL`);
    const internal = isSoulstreamMcpServerName(name);
    if (internal && !options.internalMcpUrl) {
      throw new Error("OpenCode internal MCP URL is required");
    }
    servers[name] = {
      type: "remote",
      url: internal ? normalizeSoulstreamInternalMcpUrl(options.internalMcpUrl!) : server.url,
      ...(internal
        ? { headers: mergeSoulstreamAgentSessionHeader(server.headers, options.agentSessionId) }
        : server.headers !== undefined ? { headers: server.headers } : {}),
      oauth: false,
    };
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

function openCodePermissions(
  allowlist: Record<string, string[]> | undefined,
): Record<string, "allow" | "deny"> {
  const permission: Record<string, "allow" | "deny"> = {
    "*": "allow",
    question: "deny",
    plan_exit: "deny",
  };
  for (const [serverName, tools] of Object.entries(allowlist ?? {})) {
    if (tools.length === 0) continue;
    const serverPrefix = sanitizeOpenCodeMcpName(serverName);
    permission[`${serverPrefix}_*`] = "deny";
    for (const toolName of tools) {
      permission[openCodeMcpToolName(serverName, toolName)] = "allow";
    }
  }
  return permission;
}

function configuration(
  options: PrepareOpenCodeSessionOptions,
  instructionPath: string | undefined,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    model: options.model,
    small_model: options.model,
    share: "disabled",
    autoupdate: false,
    permission: openCodePermissions(options.opencodeMcpToolAllowlist),
  };
  const mcp = openCodeMcpServers(options);
  if (mcp) config.mcp = mcp;
  if (instructionPath) config.instructions = [instructionPath];
  return config;
}

export async function prepareOpenCodeSession(
  options: PrepareOpenCodeSessionOptions,
): Promise<PreparedOpenCodeSession> {
  const workspaceDir = resolve(options.workspaceDir);
  const sessionDirectory = resolve(options.sessionDirectory);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await chmod(sessionDirectory, 0o700);

  const instructionDirectory = join(sessionDirectory, "opencode");
  const persistedInstructionPath = join(instructionDirectory, "system-prompt.md");
  if (options.systemPrompt !== undefined) {
    await mkdir(instructionDirectory, { recursive: true, mode: 0o700 });
    await chmod(instructionDirectory, 0o700);
    await writeFile(persistedInstructionPath, options.systemPrompt, { mode: 0o600 });
    await chmod(persistedInstructionPath, 0o600);
  }

  const configPath = join(sessionDirectory, "opencode.json");
  let instructionPath: string | undefined;
  try {
    await readFile(persistedInstructionPath);
    instructionPath = persistedInstructionPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const configContent = `${JSON.stringify(configuration(options, instructionPath), null, 2)}\n`;
  let currentConfig: string | undefined;
  try {
    currentConfig = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (currentConfig !== configContent) {
    await writeFile(configPath, configContent, { mode: 0o600 });
  }
  await chmod(configPath, 0o600);

  return {
    configPath,
    ...(instructionPath ? { instructionPath } : {}),
    processEnv: childEnvironment(options.processEnv, workspaceDir, configPath, sessionDirectory),
  };
}
