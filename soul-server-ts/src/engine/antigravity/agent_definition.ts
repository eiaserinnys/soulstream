import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";
import { stringify } from "yaml";
import type { ResolvedMcpServer } from "../../mcp_config_service.js";
import {
  isSoulstreamMcpServerName, mergeSoulstreamAgentSessionHeader,
  normalizeSoulstreamInternalMcpUrl,
} from "../soulstream_internal_mcp.js";
import { ANTIGRAVITY_AGENT_TOOLS } from "./agent_tools.js";

interface DefinitionOptions {
  agentSessionId: string;
  systemPrompt: string;
  resolvedMcpServers?: ResolvedMcpServer[];
  internalMcpUrl?: string;
  useMcp?: boolean;
  logger: Pick<Logger, "warn">;
}

function mcpServers(options: DefinitionOptions): object[] {
  if (options.useMcp === false) return [];
  const servers: object[] = [];
  for (const server of options.resolvedMcpServers ?? []) {
    const name = server.name;
    if (!name) throw new Error("Antigravity MCP server name is required");
    if (server.type === "sse") {
      options.logger.warn({ serverName: name }, "Antigravity skips unsupported SSE MCP server");
      continue;
    }
    if (server.type === "stdio") {
      if (!server.command || server.full_command) throw new Error(`Antigravity MCP server ${name} requires command and args`);
      servers.push({ name, command: server.command,
        ...(server.args !== undefined ? { args: server.args } : {}),
        ...(server.env !== undefined ? { env: server.env } : {}),
        ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
      });
      continue;
    }
    if (!server.url) throw new Error(`Antigravity MCP server ${name} requires a URL`);
    const internal = isSoulstreamMcpServerName(name);
    if (internal && !options.internalMcpUrl) throw new Error("Antigravity internal MCP URL is required");
    servers.push({ name,
      url: internal ? normalizeSoulstreamInternalMcpUrl(options.internalMcpUrl!) : server.url,
      ...(internal ? { headers: mergeSoulstreamAgentSessionHeader(server.headers, options.agentSessionId) }
        : server.headers !== undefined ? { headers: server.headers } : {}),
    });
  }
  return servers;
}

/** The CLI grammar requires YAML frontmatter; these delimiters are not document separators. */
export async function writeAntigravityAgentDefinition(options: DefinitionOptions) {
  const name = `soulstream-${createHash("sha256").update(options.agentSessionId).digest("hex").slice(0, 24)}`;
  const directory = join(homedir(), ".gemini", "config", "agents");
  const frontmatter = stringify({ name, description: "Soulstream session instructions", mainAgent: true,
    subagent: false, tools: [...ANTIGRAVITY_AGENT_TOOLS], mcpServers: mcpServers(options) });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${name}.md`);
  await writeFile(file, `---\n${frontmatter}---\n${options.systemPrompt}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return { directory, name, remove: async () => await rm(file, { force: true }) };
}
