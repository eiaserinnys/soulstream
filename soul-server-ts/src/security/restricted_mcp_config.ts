import { isIP } from "node:net";

import type { ResolvedMcpServer } from "../mcp_config_service.js";
import type { IsolationPolicy } from "./session_isolation_contract.js";

/**
 * restricted CLI가 처음부터 받는 정제 MCP config.
 *
 * full config를 파일에 쓴 뒤 지우지 않는다. 이 helper는 resolved profile의
 * 서버 목록에서 (1) Soulstream upstream을 노드 내부 MCP URL + ssr1로 강제하고,
 * (2) 정책이 승인한 localhost MCP만 canonical 127.0.0.1 포트로 남기며,
 * (3) 관리·미승인 local·사설 endpoint를 제거한다. 외부 공개 MCP는 기존 인증을
 * 유지한다. 반환값은 sanitizedServers와 approvedLocalMcp뿐이다.
 */

/** 정제 config와 pasta 전달에서 항상 제거하는 관리용 upstream. */
const MANAGEMENT_UPSTREAM_NAMES = new Set([
  "haniel",
  "chrome-devtools",
  "slack",
  "trello",
  "seosoyoung-mcp",
  "cloistermont",
]);

/** registry의 Soulstream upstream ID. 인증은 어떤 이름으로도 자식에게 넘기지 않는다. */
const SOULSTREAM_UPSTREAM_NAMES = new Set(["soulstream", "soulstream-cogito"]);
const SOULSTREAM_REGISTRY_PORT = 3105;

export interface ApprovedLocalMcp {
  serverId: string;
  hostPort: number;
}

export interface SanitizeRestrictedMcpInput {
  resolvedServers: readonly ResolvedMcpServer[];
  authenticatedSessionId: string;
  restrictedToken: string;
  localMcpPolicy: IsolationPolicy["localMcp"];
  actualInternalMcpUrl: string;
  /** 주어지면 정책의 nodeId가 일치하는 승인만 적용한다. */
  nodeId?: string;
}

export interface SanitizedRestrictedMcp {
  sanitizedServers: ResolvedMcpServer[];
  approvedLocalMcp: ApprovedLocalMcp[];
}

export function sanitizeRestrictedMcpServers(
  input: SanitizeRestrictedMcpInput,
): SanitizedRestrictedMcp {
  const approved = new Map<string, ApprovedLocalMcp>();
  const sanitizedServers: ResolvedMcpServer[] = [soulstreamUpstream(input)];

  for (const server of input.resolvedServers) {
    const name = serverName(server);
    if (isSoulstreamUpstream(server, name)) continue;
    if (name !== undefined && MANAGEMENT_UPSTREAM_NAMES.has(name)) continue;

    if (server.type === "stdio") {
      sanitizedServers.push(sanitizeStdioServer(server));
      continue;
    }

    const endpoint = parseEndpoint(server.url);
    if (!endpoint) continue;
    const approval = findApproval(input, name, endpoint.port);
    if (approval) {
      sanitizedServers.push(withCanonicalLocalUrl(server, endpoint));
      const key = `${approval.serverId}:${approval.port}`;
      approved.set(key, { serverId: approval.serverId, hostPort: approval.port });
      continue;
    }
    if (isPrivateOrSelfHost(endpoint.hostname)) continue;
    sanitizedServers.push(server);
  }

  return {
    sanitizedServers,
    approvedLocalMcp: [...approved.values()],
  };
}

function soulstreamUpstream(input: SanitizeRestrictedMcpInput): ResolvedMcpServer {
  return {
    type: "streamable_http",
    name: input.localMcpPolicy.requiredServerId,
    url: input.actualInternalMcpUrl,
    headers: {
      Authorization: `Bearer ${input.restrictedToken}`,
      "x-soulstream-agent-session-id": input.authenticatedSessionId,
    },
  };
}

function sanitizeStdioServer(
  server: Extract<ResolvedMcpServer, { type: "stdio" }>,
): ResolvedMcpServer {
  const { env: _env, headers: _headers, ...rest } = server;
  return rest;
}

function withCanonicalLocalUrl(
  server: Exclude<ResolvedMcpServer, { type: "stdio" }>,
  endpoint: ParsedEndpoint,
): ResolvedMcpServer {
  const canonical = new URL(endpoint.url);
  canonical.hostname = "127.0.0.1";
  canonical.port = String(endpoint.port);
  return { ...server, url: canonical.toString() };
}

function findApproval(
  input: SanitizeRestrictedMcpInput,
  serverId: string | undefined,
  port: number | undefined,
): { serverId: string; port: number } | undefined {
  if (serverId === undefined || port === undefined) return undefined;
  return input.localMcpPolicy.optional.find((entry) =>
    entry.serverId === serverId
    && entry.port === port
    && (input.nodeId === undefined || entry.nodeId === input.nodeId));
}

function isSoulstreamUpstream(server: ResolvedMcpServer, name: string | undefined): boolean {
  if (name !== undefined && SOULSTREAM_UPSTREAM_NAMES.has(name)) return true;
  if (server.type === "stdio") return false;
  const endpoint = parseEndpoint(server.url);
  return endpoint !== undefined
    && endpoint.port === SOULSTREAM_REGISTRY_PORT
    && isPrivateOrSelfHost(endpoint.hostname);
}

function serverName(server: ResolvedMcpServer): string | undefined {
  return typeof server.name === "string" && server.name.length > 0 ? server.name : undefined;
}

interface ParsedEndpoint {
  url: URL;
  hostname: string;
  port: number | undefined;
}

function parseEndpoint(rawUrl: string): ParsedEndpoint | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const port = url.port === "" ? undefined : Number(url.port);
  return { url, hostname: url.hostname, port };
}

/** localhost·사설·예약 대역. hostname은 DNS로 해석하지 않고 literal만 판정한다. */
function isPrivateOrSelfHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    return isIP(mapped) === 4 ? isPrivateIpv4(mapped) : true;
  }
  const family = isIP(host);
  if (family === 4) return isPrivateIpv4(host);
  if (family === 6) return isPrivateIpv6(host);
  return false;
}

function isPrivateIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return true;
  const head = address.split(":")[0] ?? "";
  if (head.length < 2) return false;
  const octet = Number.parseInt(head.slice(0, 2), 16);
  if (head.startsWith("fc") || head.startsWith("fd")) return true;
  if (Number.isInteger(octet) && octet >= 0xfe && octet <= 0xff) return true;
  return false;
}
