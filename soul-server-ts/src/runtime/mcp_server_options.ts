import type { Env } from "../config.js";
import type { McpRestrictedAuthConfig } from "../mcp/auth.js";
import type { McpRuntime } from "../mcp/runtime.js";
import {
  createIsolationPolicyProvider,
  defaultIsolationPolicyPath,
} from "../security/session_isolation_policy.js";
import type { ServerParams } from "../server.js";

export function buildMcpServerOptions(
  env: Env,
  runtime: McpRuntime,
): NonNullable<ServerParams["mcp"]> | undefined {
  if (!env.MCP_ENABLED) return undefined;
  return {
    runtime,
    path: env.MCP_PATH,
    auth: {
      requireAuth: env.MCP_REQUIRE_AUTH,
      bearerToken: env.AUTH_BEARER_TOKEN,
      allowedHosts: env.MCP_ALLOWED_HOSTS,
    },
    // restricted 자격 증명은 인증이 켜진 노드에서만 받는다. MCP_REQUIRE_AUTH=false면
    // restricted config 자체가 없으므로 ssr1은 401로 거부된다.
    ...(env.MCP_REQUIRE_AUTH ? { restricted: buildRestrictedAuth(runtime) } : {}),
  };
}

/**
 * restricted 요청의 DB 존재 확인과 격리 정책 공급.
 *
 * 정책 파일은 release 상대 경로(기본)에서 읽는다. 읽기·검증 실패는 restricted
 * 요청만 거부하고 full 요청은 그대로 동작한다(정책을 503으로 알린다).
 */
export function buildRestrictedAuth(runtime: McpRuntime): McpRestrictedAuthConfig {
  return {
    policyProvider: createIsolationPolicyProvider({ path: defaultIsolationPolicyPath() }),
    sessionExists: async (sessionId) => (await runtime.db.getSession(sessionId)) !== null,
  };
}
