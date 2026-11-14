import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { createUpstreamTransport, parseAntigravityMcpUpstream, type AntigravityMcpProxyConfig, type ProxyIo } from "./mcp_schema_proxy.js";
import { ANTIGRAVITY_MCP_GATEWAY_CONFIG_ENV } from "./mcp_schema_proxy_launch.js";
import { sanitizeAntigravityInputSchema } from "./mcp_schema_sanitizer.js";

export type AntigravityMcpGatewayUpstream = { name: string; upstream: AntigravityMcpProxyConfig };

/** Gateway tool names and the tool-policy gate both split on this separator. */
export const ANTIGRAVITY_GATEWAY_TOOL_SEPARATOR = "__";

export function antigravityGatewayToolName(server: string, tool: string): string {
  return `${server}${ANTIGRAVITY_GATEWAY_TOOL_SEPARATOR}${tool}`;
}

export function splitAntigravityGatewayToolName(name: string): { server: string; tool: string } | undefined {
  const index = name.indexOf(ANTIGRAVITY_GATEWAY_TOOL_SEPARATOR);
  if (index <= 0 || index + ANTIGRAVITY_GATEWAY_TOOL_SEPARATOR.length === name.length) return undefined;
  return { server: name.slice(0, index), tool: name.slice(index + ANTIGRAVITY_GATEWAY_TOOL_SEPARATOR.length) };
}

export function antigravityGatewayServerName(agentId: string): string {
  return `profile-${agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

export function parseAntigravityMcpGatewayConfig(raw: string): AntigravityMcpGatewayUpstream[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error("Invalid Antigravity MCP gateway configuration"); }
  if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.servers)) {
    throw new Error("Invalid Antigravity MCP gateway configuration");
  }
  const names = new Set<string>();
  return parsed.servers.map((server: unknown) => {
    if (!isObject(server) || typeof server.name !== "string" || !server.name || server.name.includes("__") || names.has(server.name)) {
      throw new Error("Invalid Antigravity MCP gateway configuration");
    }
    names.add(server.name);
    return { name: server.name, upstream: parseAntigravityMcpUpstream(server.upstream) };
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Presents a single tools-only MCP server backed by this turn's external servers. */
export async function runAntigravityMcpGateway(upstreams: AntigravityMcpGatewayUpstream[], io: ProxyIo): Promise<void> {
  const server = new Server({ name: "antigravity-mcp-gateway", version: "1" }, { capabilities: { tools: {} } });
  const transport = new StdioServerTransport(io.stdin, io.stdout);
  const clients = new Map<string, Client>();
  const connected = new Map<string, Client>();
  const tools: Tool[] = [];

  const ready = Promise.allSettled(upstreams.map(async ({ name, upstream }) => {
    const client = new Client({ name: "antigravity-mcp-gateway", version: "1" });
    clients.set(name, client);
    try {
      await client.connect(createUpstreamTransport(upstream, io.inheritedEnv, ANTIGRAVITY_MCP_GATEWAY_CONFIG_ENV));
      const listed: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        listed.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      connected.set(name, client);
      return listed.map(tool => ({ ...tool, name: antigravityGatewayToolName(name, tool.name),
        inputSchema: sanitizeAntigravityInputSchema(tool.inputSchema) as Tool["inputSchema"] }));
    } catch {
      process.stderr.write(`Antigravity MCP gateway upstream ${name} unavailable\n`);
      await client.close().catch(() => undefined);
      return [];
    }
  })).then(results => {
    for (const result of results) if (result.status === "fulfilled") tools.push(...result.value);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await ready;
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    await ready;
    const name = splitAntigravityGatewayToolName(params.name);
    const client = name && connected.get(name.server);
    if (!name || !client) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
    return await client.callTool({ name: name.tool, arguments: params.arguments }, undefined, { timeout: 2_147_483_647 });
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  let closing: Promise<void> | undefined;
  const onEnd = () => { void close(); };
  const onAbort = () => { void close(); };
  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        io.stdin.removeListener("end", onEnd);
        io.signal.removeEventListener("abort", onAbort);
        server.onclose = undefined;
        await Promise.allSettled([server.close(), ...Array.from(clients.values(), client => client.close())]);
        resolveClosed();
      })();
    }
    return closing;
  };
  server.onclose = () => { void close(); };
  io.stdin.once("end", onEnd);
  io.signal.addEventListener("abort", onAbort);
  try {
    if (io.signal.aborted) await close();
    else await server.connect(transport);
    await closed;
  } finally {
    await close();
  }
}
