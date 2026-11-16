import {
  checkMcpAuth,
  extractHost,
  type AuthCheckResult,
  type McpAuthConfig,
} from "@soulstream/mcp-contract";

import {
  extractBearerToken,
  isFullSessionMcpToken,
  isRestrictedMcpToken,
  verifyFullSessionMcpToken,
  verifyRestrictedMcpToken,
} from "../security/restricted_mcp_auth.js";
import { ISOLATION_POLICY_UNAVAILABLE } from "../security/session_execution_policy.js";
import type {
  IsolationPolicy,
  McpPrincipal,
} from "../security/session_isolation_contract.js";

export { checkMcpAuth, extractHost, type McpAuthConfig, type AuthCheckResult };

/** restricted 자격 증명의 DB 존재 확인과 정책 공급. transport가 주입한다. */
export interface McpRestrictedAuthConfig {
  policyProvider: {
    get(): { policy: IsolationPolicy; digest: string };
  };
  sessionExists(sessionId: string): Promise<boolean>;
}

export interface McpAuthHeaders {
  host?: string;
  authorization?: string;
}

export type McpPrincipalResolution =
  | {
    ok: true;
    principal: McpPrincipal;
    policy?: IsolationPolicy;
    policyDigest?: string;
  }
  | { ok: false; status: number; message: string };

/**
 * 요청마다 principal을 판정한다.
 *
 * - `ssr1.`은 restricted, `ssf1.`은 full 세션 전용이다. 서로 섞지 않는다.
 * - full 경로는 기존 `checkMcpAuth` 의미(host 403, 미설정 500, 불일치 401)를
 *   그대로 쓴다. 서비스 토큰은 지금처럼 세션 ID 없는 full이다.
 * - full 세션 토큰은 서명을 확인해 세션 ID를 principal에 채운다. 인증을
 *   요구하는 설정에서 위조·변조는 401이다. 인증을 요구하지 않는 설정에서는
 *   다른 값과 똑같이 통과시키되, 서버 키가 있고 서명이 맞을 때만 세션 ID를 채운다.
 * - restricted는 형식/서명/DB 존재/정책 순서로 확인하며, 실패는 그 요청만 거부한다.
 */
export async function resolveMcpPrincipal(
  config: McpAuthConfig,
  headers: McpAuthHeaders,
  restricted?: McpRestrictedAuthConfig,
): Promise<McpPrincipalResolution> {
  const host = extractHost(headers.host);
  if (config.allowedHosts.length > 0 && !config.allowedHosts.includes(host)) {
    return { ok: false, status: 403, message: `host not allowed: ${host || "(missing)"}` };
  }

  const token = extractBearerToken(headers.authorization);
  if (isFullSessionMcpToken(token)) {
    return resolveFullSessionPrincipal(config, token);
  }
  if (isRestrictedMcpToken(token)) {
    return await resolveRestrictedPrincipal(config, restricted, token);
  }

  const check = checkMcpAuth(config, headers);
  if (!check.ok) {
    return {
      ok: false,
      status: check.status ?? 401,
      message: check.message ?? "unauthorized",
    };
  }
  return { ok: true, principal: { tier: "full" } };
}

/**
 * full 세션 토큰 판정. 서비스 토큰과 같은 full 등급이므로 DB 존재나 격리
 * 정책을 보지 않고 HMAC만 확인한다. 인증을 요구하는 설정에서 틀리거나
 * 위조된 토큰은 401이다. 인증을 요구하지 않는 설정에서는 `checkMcpAuth`가
 * 다른 값에 하는 것처럼 통과시키되, 키가 설정돼 있고 서명이 맞으면 세션
 * ID를 principal에 채운다.
 */
function resolveFullSessionPrincipal(
  config: McpAuthConfig,
  token: string,
): McpPrincipalResolution {
  if (!config.requireAuth) {
    if (config.bearerToken) {
      const verification = verifyFullSessionMcpToken(token, config.bearerToken);
      if (verification.ok) {
        return {
          ok: true,
          principal: { tier: "full", sessionId: verification.sessionId },
        };
      }
    }
    return { ok: true, principal: { tier: "full" } };
  }
  if (!config.bearerToken) {
    return { ok: false, status: 500, message: "bearer token not configured" };
  }
  const verification = verifyFullSessionMcpToken(token, config.bearerToken);
  if (!verification.ok) {
    return { ok: false, status: 401, message: "invalid full session credential" };
  }
  return {
    ok: true,
    principal: { tier: "full", sessionId: verification.sessionId },
  };
}

async function resolveRestrictedPrincipal(
  config: McpAuthConfig,
  restricted: McpRestrictedAuthConfig | undefined,
  token: string,
): Promise<McpPrincipalResolution> {
  if (!restricted || !config.requireAuth) {
    return { ok: false, status: 401, message: "restricted credentials are not accepted" };
  }
  if (!config.bearerToken) {
    return { ok: false, status: 500, message: "bearer token not configured" };
  }
  const verification = verifyRestrictedMcpToken(token, config.bearerToken);
  if (!verification.ok) {
    return { ok: false, status: 401, message: "invalid restricted credential" };
  }

  let exists: boolean;
  try {
    exists = await restricted.sessionExists(verification.sessionId);
  } catch {
    return { ok: false, status: 503, message: "ISOLATION_AUTH_UNAVAILABLE" };
  }
  if (!exists) {
    return { ok: false, status: 401, message: "invalid restricted credential" };
  }

  let loaded: { policy: IsolationPolicy; digest: string };
  try {
    loaded = restricted.policyProvider.get();
  } catch {
    return { ok: false, status: 503, message: ISOLATION_POLICY_UNAVAILABLE };
  }

  return {
    ok: true,
    principal: { tier: "restricted", sessionId: verification.sessionId },
    policy: loaded.policy,
    policyDigest: loaded.digest,
  };
}
