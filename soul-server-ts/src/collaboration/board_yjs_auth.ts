import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const DASHBOARD_AUTH_COOKIE_NAME = "soul_dashboard_auth";

export interface BoardYjsAuthConfig {
  authBearerToken: string;
  environment: "development" | "production";
  dashboardAuthEnabled: boolean;
  jwtSecret?: string;
}

export interface BoardYjsAuthInput {
  token?: string | null;
  requestHeaders: IncomingHttpHeaders;
  config: BoardYjsAuthConfig;
}

export interface BoardYjsAuthResult {
  source: "bearer" | "cookie" | "development";
  subject: string;
}

export interface DashboardHttpAuthInput {
  requestHeaders: IncomingHttpHeaders;
  config: BoardYjsAuthConfig;
}

export async function authenticateBoardYjsConnection({
  token,
  requestHeaders,
  config,
}: BoardYjsAuthInput): Promise<BoardYjsAuthResult> {
  const authorization = firstHeaderValue(requestHeaders.authorization);
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const providedToken = token || bearer;
  if (config.authBearerToken && providedToken) {
    if (constantTimeEqual(providedToken, config.authBearerToken)) {
      return { source: "bearer", subject: "bearer" };
    }
  }

  if (config.dashboardAuthEnabled) {
    const cookieToken = parseCookieHeader(firstHeaderValue(requestHeaders.cookie) ?? "")[
      DASHBOARD_AUTH_COOKIE_NAME
    ];
    if (!cookieToken) {
      throw new Error("missing dashboard auth cookie");
    }
    const payload = verifyHs256Jwt(cookieToken, config.jwtSecret ?? "");
    return {
      source: "cookie",
      subject: getJwtSubject(payload),
    };
  }

  if (config.environment === "development") {
    return { source: "development", subject: "development" };
  }

  if (config.authBearerToken && providedToken) {
    throw new Error("invalid board workspace websocket bearer token");
  }

  throw new Error("board workspace websocket authentication is not configured");
}

export async function authenticateDashboardHttpRequest({
  requestHeaders,
  config,
}: DashboardHttpAuthInput): Promise<BoardYjsAuthResult> {
  if (config.dashboardAuthEnabled) {
    const cookieToken = parseCookieHeader(firstHeaderValue(requestHeaders.cookie) ?? "")[
      DASHBOARD_AUTH_COOKIE_NAME
    ];
    if (!cookieToken) {
      throw new Error("missing dashboard auth cookie");
    }
    const payload = verifyHs256Jwt(cookieToken, config.jwtSecret ?? "");
    return {
      source: "cookie",
      subject: getJwtSubject(payload),
    };
  }

  if (config.environment === "development") {
    return { source: "development", subject: "development" };
  }

  const authorization = firstHeaderValue(requestHeaders.authorization);
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  if (config.authBearerToken && bearer && constantTimeEqual(bearer, config.authBearerToken)) {
    return { source: "bearer", subject: "bearer" };
  }

  throw new Error("dashboard HTTP authentication is not configured");
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function parseCookieHeader(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    result[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function verifyHs256Jwt(token: string, secret: string): Record<string, unknown> {
  if (!secret) {
    throw new Error("JWT_SECRET is required for dashboard cookie auth");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("invalid dashboard auth cookie");
  }
  const signed = `${parts[0]}.${parts[1]}`;
  const expected = base64UrlEncode(
    createHmac("sha256", secret).update(signed).digest(),
  );
  if (!constantTimeEqual(expected, parts[2])) {
    throw new Error("invalid dashboard auth cookie signature");
  }
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  if (exp !== null && exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("dashboard auth cookie expired");
  }
  return payload;
}

function getJwtSubject(payload: Record<string, unknown>): string {
  const sub = payload.sub;
  if (typeof sub === "string" && sub.trim()) return sub;
  const email = payload.email;
  if (typeof email === "string" && email.trim()) return email;
  return "dashboard-user";
}

function base64UrlEncode(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
