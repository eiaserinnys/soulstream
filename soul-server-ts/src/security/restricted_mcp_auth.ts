import { createHmac } from "node:crypto";

import { constantTimeStringEqual } from "./constant_time_string_equal.js";

/**
 * restricted 세션용 내부 MCP 자격 증명(ssr1).
 *
 * 형식: `ssr1.<session_id>.<base64url(HMAC-SHA256(key=AUTH_BEARER_TOKEN, message))>`
 * message: `soulstream/internal-mcp/restricted/v1\n<session_id>`
 *
 * 토큰 원문·키·서명은 로그에 남기지 않는다. 반환값에는 세션 ID와 판정만 담는다.
 */
export const RESTRICTED_MCP_TOKEN_PREFIX = "ssr1.";

const RESTRICTED_MCP_TOKEN_CONTEXT = "soulstream/internal-mcp/restricted/v1\n";
const CANONICAL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_LENGTH = 256;

export type RestrictedMcpTokenVerification =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "format" | "signature" | "unconfigured" };

export function isRestrictedMcpToken(token: string | undefined): token is string {
  return typeof token === "string" && token.startsWith(RESTRICTED_MCP_TOKEN_PREFIX);
}

/** 발급자(B2 호스트 포트)가 쓴다. 세션 ID는 canonical lowercase UUID여야 한다. */
export function createRestrictedMcpToken(sessionId: string, bearerToken: string): string {
  if (!CANONICAL_SESSION_ID.test(sessionId)) {
    throw new Error("restricted MCP token requires a canonical lowercase session id");
  }
  if (!bearerToken) {
    throw new Error("restricted MCP token requires AUTH_BEARER_TOKEN");
  }
  return `${RESTRICTED_MCP_TOKEN_PREFIX}${sessionId}.${signRestrictedSession(sessionId, bearerToken)}`;
}

/**
 * 형식 검사 → HMAC 재계산(상수 시간 비교) 순서로 판정한다.
 * DB 존재 확인은 호출자(transport)가 따로 수행한다.
 */
export function verifyRestrictedMcpToken(
  token: string,
  bearerToken: string,
): RestrictedMcpTokenVerification {
  if (!bearerToken) return { ok: false, reason: "unconfigured" };
  if (token.length > MAX_TOKEN_LENGTH || !token.startsWith(RESTRICTED_MCP_TOKEN_PREFIX)) {
    return { ok: false, reason: "format" };
  }
  const body = token.slice(RESTRICTED_MCP_TOKEN_PREFIX.length);
  const separator = body.indexOf(".");
  if (separator <= 0 || body.indexOf(".", separator + 1) !== -1) {
    return { ok: false, reason: "format" };
  }
  const sessionId = body.slice(0, separator);
  const signature = body.slice(separator + 1);
  if (!CANONICAL_SESSION_ID.test(sessionId) || !SIGNATURE_BASE64URL.test(signature)) {
    return { ok: false, reason: "format" };
  }
  if (!constantTimeStringEqual(signature, signRestrictedSession(sessionId, bearerToken))) {
    return { ok: false, reason: "signature" };
  }
  return { ok: true, sessionId };
}

/** `Authorization` 헤더에서 bearer 값을 꺼낸다. 형식이 다르면 undefined. */
export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (typeof authorization !== "string") return undefined;
  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2) return undefined;
  const [scheme, value] = parts;
  if (!scheme || !value || scheme.toLowerCase() !== "bearer") return undefined;
  return value;
}

function signRestrictedSession(sessionId: string, bearerToken: string): string {
  return createHmac("sha256", bearerToken)
    .update(`${RESTRICTED_MCP_TOKEN_CONTEXT}${sessionId}`)
    .digest("base64url");
}
