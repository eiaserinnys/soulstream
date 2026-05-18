/**
 * MCP 라우트 인증·Host 검증. 사전 게이트로 transport에 도달 전에 401/403 결정.
 *
 * env 정합:
 *   - MCP_REQUIRE_AUTH true → Authorization: Bearer {AUTH_BEARER_TOKEN} 일치 강제
 *   - MCP_ALLOWED_HOSTS string[] → Host 헤더 host(port 제거 후)가 리스트에 포함
 *
 * DNS rebinding 방지: Host 헤더 검증은 *항상* 수행 — loopback 바인딩에서도 외부 사이트가
 * 임의 hostname으로 접속 가능하므로.
 */

export interface McpAuthConfig {
  requireAuth: boolean;
  bearerToken: string;
  allowedHosts: string[];
}

export interface AuthCheckResult {
  ok: boolean;
  status?: number;
  message?: string;
}

/** Host 헤더에서 port 제거한 host만 추출. IPv6는 brackets 안의 값만. */
export function extractHost(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const trimmed = hostHeader.trim();
  // IPv6 literal: [::1]:8080
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end > 0) return trimmed.slice(1, end);
  }
  const colonIdx = trimmed.indexOf(":");
  return colonIdx > 0 ? trimmed.slice(0, colonIdx) : trimmed;
}

export function checkMcpAuth(
  config: McpAuthConfig,
  headers: { host?: string; authorization?: string },
): AuthCheckResult {
  const host = extractHost(headers.host);
  if (config.allowedHosts.length > 0) {
    if (!config.allowedHosts.includes(host)) {
      return {
        ok: false,
        status: 403,
        message: `host not allowed: ${host || "(missing)"}`,
      };
    }
  }
  if (config.requireAuth) {
    if (!config.bearerToken) {
      return { ok: false, status: 500, message: "bearer token not configured" };
    }
    const expected = `Bearer ${config.bearerToken}`;
    if (headers.authorization !== expected) {
      return { ok: false, status: 401, message: "invalid bearer token" };
    }
  }
  return { ok: true };
}
