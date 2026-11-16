import { internalMcpPath } from "../mcp/endpoint_paths.js";
import { SOULSTREAM_AGENT_SESSION_HEADER } from "../mcp/request_context.js";

const SOULSTREAM_MCP_SERVER_NAMES = new Set([
  "soulstream",
  "soulstream-cogito",
  "soul-server-ts",
]);

/** 서버 이름 정규화. registry 이름에 섞인 앞뒤 공백을 판정에서 무시한다. */
export function normalizeSoulstreamMcpServerName(serverName: string): string {
  return serverName.trim();
}

/** 정규화한 이름이 soulstream 내부 이름 집합에 있는가. */
export function isSoulstreamMcpServerName(serverName: string): boolean {
  return SOULSTREAM_MCP_SERVER_NAMES.has(
    normalizeSoulstreamMcpServerName(serverName),
  );
}

/**
 * soulstream 내부 MCP 대상 판정의 정본.
 *
 * 이름을 정규화했을 때 soulstream 내부 이름 집합에 있고, 전송 방식이 `http`
 * 또는 `streamable_http`인 서버만 내부 대상이다. 네 백엔드(Claude, Codex,
 * antigravity, OpenCode), full 세션 자격 교체, restricted 정제가 모두 이
 * 함수로 같은 판정을 쓴다. `sse`는 최종 대상이 내부 MCP 리스너인지 확정할 수
 * 없으므로 내부 대상이 아니다.
 */
export function isSoulstreamInternalMcpServer(server: {
  name?: string | undefined;
  type: string;
}): boolean {
  if (server.type !== "http" && server.type !== "streamable_http") return false;
  const name = server.name?.trim();
  return name !== undefined && name.length > 0
    && SOULSTREAM_MCP_SERVER_NAMES.has(name);
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
