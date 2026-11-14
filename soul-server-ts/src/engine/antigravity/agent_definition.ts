import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";
import { parse, stringify } from "yaml";
import type { ResolvedMcpServer } from "../../mcp_config_service.js";
import {
  isSoulstreamMcpServerName, mergeSoulstreamAgentSessionHeader,
  normalizeSoulstreamInternalMcpUrl,
} from "../soulstream_internal_mcp.js";
import { ANTIGRAVITY_AGENT_TOOLS } from "./agent_tools.js";
import { ANTIGRAVITY_MCP_GATEWAY_CONFIG_ENV, type AntigravityMcpProxyLaunch } from "./mcp_schema_proxy_launch.js";
import { antigravityGatewayServerName, type AntigravityMcpGatewayUpstream } from "./mcp_gateway.js";

export interface DefinitionOptions {
  agentId: string;
  agentSessionId: string;
  systemPrompt: string;
  gatewayConfigPath: string;
  resolvedMcpServers?: ResolvedMcpServer[];
  internalMcpUrl?: string;
  useMcp?: boolean;
  mcpGatewayLaunch?: AntigravityMcpProxyLaunch;
  logger: Pick<Logger, "warn">;
  /** 제한 모드의 정의 `tools`. 없으면 ANTIGRAVITY_AGENT_TOOLS 전체. */
  tools?: readonly string[];
  /** 제한 모드의 PreToolUse 훅 파일 절대 경로 목록. */
  hooks?: readonly string[];
  /** 시스템 프롬프트 뒤에 붙일 본문(하위 에이전트 절). */
  bodySuffix?: string;
}

function mcpServers(options: DefinitionOptions): object[] {
  if (options.useMcp === false) return [];
  const servers: object[] = [];
  for (const server of options.resolvedMcpServers ?? []) {
    const name = server.name;
    if (!name || !isSoulstreamMcpServerName(name)) continue;
    if (!("url" in server) || !server.url) throw new Error(`Antigravity MCP server ${name} requires a URL`);
    if (!options.internalMcpUrl) throw new Error("Antigravity internal MCP URL is required");
    servers.push({ name, url: normalizeSoulstreamInternalMcpUrl(options.internalMcpUrl),
      headers: mergeSoulstreamAgentSessionHeader(server.headers, options.agentSessionId) });
  }
  const launch = options.mcpGatewayLaunch;
  if (!launch) throw new Error("Antigravity MCP proxy launch is required for external MCP servers");
  servers.push({ name: antigravityGatewayServerName(options.agentId), command: launch.command, args: launch.args,
    env: { [ANTIGRAVITY_MCP_GATEWAY_CONFIG_ENV]: options.gatewayConfigPath } });
  return servers;
}

export function antigravityMcpGatewayUpstreams(options: {
  resolvedMcpServers?: ResolvedMcpServer[];
  useMcp?: boolean;
  logger: Pick<Logger, "warn">;
}): AntigravityMcpGatewayUpstream[] {
  if (options.useMcp === false) return [];
  const servers: AntigravityMcpGatewayUpstream[] = [];
  for (const server of options.resolvedMcpServers ?? []) {
    const name = server.name;
    if (!name) throw new Error("Antigravity MCP server name is required");
    if (isSoulstreamMcpServerName(name)) continue;
    if (name.includes("__")) throw new Error(`Antigravity MCP server ${name} name must not contain "__"`);
    if (server.type === "sse") {
      options.logger.warn({ serverName: name }, "Antigravity skips unsupported SSE MCP server");
      continue;
    }
    if (server.type === "stdio") {
      if (!server.command || server.full_command) throw new Error(`Antigravity MCP server ${name} requires command and args`);
      servers.push({ name, upstream: {
        type: "stdio", command: server.command,
        ...(server.args !== undefined ? { args: server.args } : {}),
        ...(server.env !== undefined ? { env: server.env } : {}),
        ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
      } });
      continue;
    }
    if (!server.url) throw new Error(`Antigravity MCP server ${name} requires a URL`);
    servers.push({ name, upstream: { type: "streamable_http", url: server.url,
      ...(server.headers !== undefined ? { headers: server.headers } : {}) } });
  }
  return servers;
}

export async function writeAntigravityMcpGatewayConfig(path: string, upstreams: AntigravityMcpGatewayUpstream[]): Promise<void> {
  await writeFile(path, JSON.stringify({ version: 1, servers: upstreams }), { mode: 0o600 });
  await chmod(path, 0o600);
}

export function antigravityDefinitionName(agentSessionId: string): string {
  return `soulstream-${createHash("sha256").update(agentSessionId).digest("hex").slice(0, 24)}`;
}

/** The CLI grammar requires YAML frontmatter; these delimiters are not document separators. */
export function antigravityAgentDefinitionText(options: DefinitionOptions): { name: string; text: string } {
  const name = antigravityDefinitionName(options.agentSessionId);
  const frontmatter = stringify({ name, description: "Soulstream session instructions", mainAgent: true,
    subagent: false, tools: [...(options.tools ?? ANTIGRAVITY_AGENT_TOOLS)],
    ...(options.hooks ? { hooks: [...options.hooks] } : {}), mcpServers: mcpServers(options) });
  return { name, text: `---\n${frontmatter}---\n${options.systemPrompt}${options.bodySuffix ?? ""}\n` };
}

export async function writeAntigravityAgentDefinition(options: DefinitionOptions) {
  const { name, text } = antigravityAgentDefinitionText(options);
  const directory = join(homedir(), ".gemini", "config", "agents");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${name}.md`);
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600);
  return { directory, name, remove: async () => await rm(file, { force: true }) };
}

export interface ClaudeSubagentDefinition {
  name: string;
  description: string;
  tools: string[];
  body: string;
}

/** 프로필 작업 폴더의 `.claude/agents/*.md`를 agy 하위 정의의 재료로 읽는다. */
export async function readClaudeSubagentDefinitions(
  profileWorkspaceDir: string,
  logger: Pick<Logger, "warn">,
): Promise<ClaudeSubagentDefinition[]> {
  const directory = join(profileWorkspaceDir, ".claude", "agents");
  let files: string[];
  try {
    files = (await readdir(directory)).filter(name => name.endsWith(".md")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const definitions: ClaudeSubagentDefinition[] = [];
  for (const file of files) {
    try {
      const text = await readFile(join(directory, file), "utf8");
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
      if (!match) throw new Error("missing YAML frontmatter");
      const frontmatter = parse(match[1]!) as Record<string, unknown> | null;
      const name = typeof frontmatter?.name === "string" ? frontmatter.name : file.replace(/\.md$/, "");
      const description = frontmatter?.description;
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("invalid subagent name");
      if (typeof description !== "string" || description.trim() === "") {
        throw new Error("missing subagent description");
      }
      definitions.push({ name, description, tools: subagentToolNames(frontmatter?.tools), body: match[2]! });
    } catch (error) {
      logger.warn({ file, error: error instanceof Error ? error.message : String(error) },
        "Antigravity skips an unreadable Claude subagent definition");
    }
  }
  return definitions;
}

function subagentToolNames(tools: unknown): string[] {
  if (typeof tools === "string") return tools.split(",").map(name => name.trim()).filter(Boolean);
  if (Array.isArray(tools)) {
    return tools.filter((name): name is string => typeof name === "string")
      .map(name => name.trim()).filter(Boolean);
  }
  return [];
}

export interface AntigravitySubagentListing {
  originalName: string;
  invokeName: string;
  description: string;
}

export function antigravitySubagentSection(entries: readonly AntigravitySubagentListing[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map(entry =>
    `- ${entry.originalName} → ${entry.invokeName}: ${entry.description.replace(/\s+/g, " ").trim()}`);
  return `\n## 하위 에이전트\n\n${lines.join("\n")}\n`;
}

export function antigravitySubagentDefinitionText(options: {
  name: string;
  description: string;
  tools: readonly string[];
  body: string;
}): string {
  const frontmatter = stringify({ name: options.name, description: options.description,
    mainAgent: false, subagent: true, model: "inherit", tools: [...options.tools] });
  return `---\n${frontmatter}---\n${options.body}`;
}
