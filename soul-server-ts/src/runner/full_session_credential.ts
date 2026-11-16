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
 * - soulstream 계열 HTTP MCP 서버의 `Authorization`을 ssf1로 바꾼다. 러너 설정
 *   파일·Claude `--mcp-config`·Codex `http_headers`·antigravity 정의가 모두
 *   이 값을 읽는다.
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
    if (server.type === "stdio") return server;
    const name = typeof server.name === "string" ? server.name : undefined;
    if (name === undefined || !isSoulstreamMcpServerName(name)) return server;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      if (key.toLowerCase() === "authorization") continue;
      headers[key] = value;
    }
    headers.Authorization = `Bearer ${credential}`;
    return { ...server, headers };
  });
}
