import {
  checkMcpAuth,
  extractHost,
  type AuthCheckResult,
  type McpAuthConfig,
} from "@soulstream/mcp-contract";

import {
  extractBearerToken,
  isRestrictedMcpToken,
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
 * - `ssr1.` 접두사는 restricted 전용이다. full bearer와 절대 섞지 않는다.
 * - full 경로는 기존 `checkMcpAuth` 의미(host 403, 미설정 500, 불일치 401)를
 *   그대로 쓴다.
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
