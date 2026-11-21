import { createHmac } from "node:crypto";

import { constantTimeStringEqual } from "@soulstream/mcp-contract";

/**
 * 내부 MCP 세션 자격 증명.
 *
 * restricted(ssr1)와 full 세션(ssf1)은 같은 형식과 HMAC, 상수 시간 비교를
 * 쓰고 접두사와 서명 컨텍스트만 다르다. 접두사로 인증 계층이 tier를 가른다.
 *
 * 형식: `<prefix><session_id>.<base64url(HMAC-SHA256(key=AUTH_BEARER_TOKEN, message))>`
 * message: `soulstream/internal-mcp/<scope>/v1\n<session_id>`
 *
 * 토큰 원문·키·서명은 로그에 남기지 않는다. 반환값에는 세션 ID와 판정만 담는다.
 */
export const RESTRICTED_MCP_TOKEN_PREFIX = "ssr1.";
export const FULL_SESSION_MCP_TOKEN_PREFIX = "ssf1.";

interface SessionMcpTokenSpec {
  prefix: string;
  context: string;
}

const RESTRICTED_TOKEN: SessionMcpTokenSpec = {
  prefix: RESTRICTED_MCP_TOKEN_PREFIX,
  context: "soulstream/internal-mcp/restricted/v1\n",
};

const FULL_SESSION_TOKEN: SessionMcpTokenSpec = {
  prefix: FULL_SESSION_MCP_TOKEN_PREFIX,
  context: "soulstream/internal-mcp/full-session/v1\n",
};

const CANONICAL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_LENGTH = 256;

export type SessionMcpTokenVerification =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "format" | "signature" | "unconfigured" };

/** 기존 호출부가 쓰는 restricted 판정 타입. full 세션도 같은 모양이다. */
export type RestrictedMcpTokenVerification = SessionMcpTokenVerification;

export function isRestrictedMcpToken(token: string | undefined): token is string {
  return typeof token === "string" && token.startsWith(RESTRICTED_MCP_TOKEN_PREFIX);
}

export function isFullSessionMcpToken(token: string | undefined): token is string {
  return typeof token === "string" && token.startsWith(FULL_SESSION_MCP_TOKEN_PREFIX);
}

/** 발급자(B2 호스트 포트)가 쓴다. 세션 ID는 canonical lowercase UUID여야 한다. */
export function createRestrictedMcpToken(sessionId: string, bearerToken: string): string {
  return createSessionMcpToken(RESTRICTED_TOKEN, sessionId, bearerToken);
}

/**
 * full(상자 밖) 세션 발급자(런너 스폰 조립)가 쓴다. 서명 컨텍스트가
 * restricted와 달라 ssr1과 서로 바꿔 쓸 수 없다.
 */
export function createFullSessionMcpToken(sessionId: string, bearerToken: string): string {
  return createSessionMcpToken(FULL_SESSION_TOKEN, sessionId, bearerToken);
}

/**
 * 형식 검사 → HMAC 재계산(상수 시간 비교) 순서로 판정한다.
 * DB 존재 확인은 호출자(transport)가 따로 수행한다.
 */
export function verifyRestrictedMcpToken(
  token: string,
  bearerToken: string,
): SessionMcpTokenVerification {
  return verifySessionMcpToken(RESTRICTED_TOKEN, token, bearerToken);
}

export function verifyFullSessionMcpToken(
  token: string,
  bearerToken: string,
): SessionMcpTokenVerification {
  return verifySessionMcpToken(FULL_SESSION_TOKEN, token, bearerToken);
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

function createSessionMcpToken(
  spec: SessionMcpTokenSpec,
  sessionId: string,
  bearerToken: string,
): string {
  if (!CANONICAL_SESSION_ID.test(sessionId)) {
    throw new Error("session MCP token requires a canonical lowercase session id");
  }
  if (!bearerToken) {
    throw new Error("session MCP token requires AUTH_BEARER_TOKEN");
  }
  return `${spec.prefix}${sessionId}.${signSession(sessionId, bearerToken, spec)}`;
}

function verifySessionMcpToken(
  spec: SessionMcpTokenSpec,
  token: string,
  bearerToken: string,
): SessionMcpTokenVerification {
  if (!bearerToken) return { ok: false, reason: "unconfigured" };
  if (token.length > MAX_TOKEN_LENGTH || !token.startsWith(spec.prefix)) {
    return { ok: false, reason: "format" };
  }
  const body = token.slice(spec.prefix.length);
  const separator = body.indexOf(".");
  if (separator <= 0 || body.indexOf(".", separator + 1) !== -1) {
    return { ok: false, reason: "format" };
  }
  const sessionId = body.slice(0, separator);
  const signature = body.slice(separator + 1);
  if (!CANONICAL_SESSION_ID.test(sessionId) || !SIGNATURE_BASE64URL.test(signature)) {
    return { ok: false, reason: "format" };
  }
  if (!constantTimeStringEqual(signature, signSession(sessionId, bearerToken, spec))) {
    return { ok: false, reason: "signature" };
  }
  return { ok: true, sessionId };
}

function signSession(
  sessionId: string,
  bearerToken: string,
  spec: SessionMcpTokenSpec,
): string {
  return createHmac("sha256", bearerToken)
    .update(`${spec.context}${sessionId}`)
    .digest("base64url");
}
