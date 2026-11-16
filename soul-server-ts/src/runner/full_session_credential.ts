import type { ResolvedMcpServer } from "../mcp_config_service.js";
import { isSoulstreamMcpServerName } from "../engine/soulstream_internal_mcp.js";
import { createFullSessionMcpToken } from "../security/restricted_mcp_auth.js";

/**
 * full(상자 밖) 세션의 러너 자식에게 서비스 토큰 대신 줄 세션 범위 자격 증명.
 *
 * full 세션은 restricted와 달리 호스트 env와 resolved MCP 설정을 그대로 받는다.
 * 여기서 두 채널을 한 번에 바꾼다.
 *
 * - `AUTH_BEARER_TOKEN`과 호스트 서비스 토큰과 같은 값을 담은 다른 env 키
 *   (예: `PORTABLE_LOCAL_MCP_AUTHORIZATION`)를 ssf1로 바꾼다.
 * - 최종 대상이 soul-server 내부 MCP인 soulstream 계열 HTTP 서버의
 *   `Authorization`을 ssf1로 바꾼다. 러너 설정 파일·Claude `--mcp-config`·
 *   Codex `http_headers`·antigravity 정의가 모두 이 값을 읽는다. 이름이
 *   soulstream 계열이어도 내부 주소로 다시 쓰이지 않고 URL이 그대로 남는
 *   항목(예: `sse`)은 다른 곳을 가리키므로 헤더를 바꾸지 않는다.
 *
 * 호스트 서비스 토큰이 비어 있으면(개발 환경) 아무것도 바꾸지 않는다. 값은
 * 반환값·오류 메시지·로그에 남기지 않는다.
 */

export interface FullSessionCredentialSpawnInput {
  sessionId: string;
  resolvedMcpServers?: readonly ResolvedMcpServer[];
  childProcessEnv?: NodeJS.ProcessEnv;
}

export interface FullSessionCredentialOptions {
  /** 호스트 `AUTH_BEARER_TOKEN`. 비어 있으면 변환하지 않는다. */
  hostBearerToken: string | undefined;
  /**
   * spawn 입력에 env가 없을 때(복구 경로) 쓸 기본 env. 보통 호스트의
   * `buildChildProcessEnv()`다.
   */
  buildChildProcessEnv?: () => NodeJS.ProcessEnv;
}

/** 세션 ID와 호스트 키로 full 세션 자격 증명을 만든다. 키가 없으면 undefined. */
export function fullSessionCredential(
  sessionId: string,
  hostBearerToken: string | undefined,
): string | undefined {
  const hostToken = hostBearerToken?.trim();
  if (!hostToken) return undefined;
  return createFullSessionMcpToken(sessionId, hostToken);
}

/** full 세션의 spawn 입력에서 서비스 토큰을 세션 자격 증명으로 바꾼다. */
export function withFullSessionCredential<T extends FullSessionCredentialSpawnInput>(
  base: T,
  options: FullSessionCredentialOptions,
): T {
  const hostToken = options.hostBearerToken?.trim();
  const credential = hostToken
    ? fullSessionCredential(base.sessionId, hostToken)
    : undefined;
  if (!credential || !hostToken) return base;
  const baseEnv = base.childProcessEnv ?? options.buildChildProcessEnv?.();
  return {
    ...base,
    ...(base.resolvedMcpServers
      ? { resolvedMcpServers: replaceSoulstreamAuthorization(base.resolvedMcpServers, credential) }
      : {}),
    ...(baseEnv ? { childProcessEnv: replaceServiceTokenEnv(baseEnv, hostToken, credential) } : {}),
  };
}

function replaceServiceTokenEnv(
  baseEnv: NodeJS.ProcessEnv,
  hostToken: string,
  credential: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key === "AUTH_BEARER_TOKEN" || typeof value !== "string") {
      env[key] = value;
      continue;
    }
    env[key] = replaceServiceTokenValue(value, hostToken, credential);
  }
  env.AUTH_BEARER_TOKEN = credential;
  return env;
}

function replaceServiceTokenValue(
  value: string,
  hostToken: string,
  credential: string,
): string {
  if (value === hostToken) return credential;
  if (value === `Bearer ${hostToken}`) return `Bearer ${credential}`;
  return value;
}

function replaceSoulstreamAuthorization(
  servers: readonly ResolvedMcpServer[],
  credential: string,
): ResolvedMcpServer[] {
  return servers.map((server) => {
    if (!targetsSoulstreamInternalMcp(server)) return server;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      if (key.toLowerCase() === "authorization") continue;
      headers[key] = value;
    }
    headers.Authorization = `Bearer ${credential}`;
    return { ...server, headers };
  });
}

/**
 * 최종 대상이 soul-server 내부 MCP인 항목만 고른다.
 *
 * 백엔드가 URL을 노드 내부 주소로 다시 쓰는 것은 soulstream 계열 이름의
 * `streamable_http` 서버다(Claude `prepareSoulstreamInternalMcpServer`, Codex
 * `buildCodexMcpConfig`, antigravity 정의). `sse` 항목은 Claude가 URL을 그대로
 * 두고 Codex는 아예 보내지 않으므로, 다른 곳을 가리킬 수 있는 그 항목의
 * 헤더는 바꾸지 않는다. `stdio`에는 헤더가 없다.
 */
function targetsSoulstreamInternalMcp(server: ResolvedMcpServer): boolean {
  if (server.type !== "streamable_http") return false;
  const name = typeof server.name === "string" ? server.name : undefined;
  return name !== undefined && isSoulstreamMcpServerName(name);
}
