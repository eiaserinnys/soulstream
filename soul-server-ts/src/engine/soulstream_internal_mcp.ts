import { internalMcpPath } from "../mcp/endpoint_paths.js";
import { SOULSTREAM_AGENT_SESSION_HEADER } from "../mcp/request_context.js";

const SOULSTREAM_MCP_SERVER_NAMES = new Set([
  "soulstream",
  "soulstream-cogito",
  "soul-server-ts",
]);

export function isSoulstreamMcpServerName(serverName: string): boolean {
  return SOULSTREAM_MCP_SERVER_NAMES.has(serverName);
}

export function normalizeSoulstreamInternalMcpUrl(value: string): string {
  const url = new URL(value);
  url.pathname = internalMcpPath(url.pathname);
  return url.toString();
}

export function mergeSoulstreamAgentSessionHeader(
  headers: unknown,
  agentSessionId: string,
): Record<string, string> {
  const merged: Record<string, string> = {};
  if (isRecord(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === SOULSTREAM_AGENT_SESSION_HEADER) continue;
      if (typeof value === "string") merged[key] = value;
    }
  }
  merged[SOULSTREAM_AGENT_SESSION_HEADER] = agentSessionId;
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
