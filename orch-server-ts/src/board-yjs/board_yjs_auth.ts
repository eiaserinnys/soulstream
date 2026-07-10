import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { AUTH_COOKIE_NAME } from "../auth/auth_routes.js";

export const DASHBOARD_AUTH_COOKIE_NAME = AUTH_COOKIE_NAME;

export interface BoardYjsAuthConfig {
  authBearerToken: string;
  environment: string;
  dashboardAuthEnabled: boolean;
  verifyDashboardToken: (
    token: string,
  ) => Promise<Record<string, unknown> | null>;
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

export async function authenticateBoardYjsConnection({
  token,
  requestHeaders,
  config,
}: BoardYjsAuthInput): Promise<BoardYjsAuthResult> {
  const authorization = firstHeaderValue(requestHeaders.authorization);
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const providedToken = token || bearer;
  if (
    config.authBearerToken &&
    providedToken &&
    constantTimeEqual(providedToken, config.authBearerToken)
  ) {
    return { source: "bearer", subject: "bearer" };
  }

  if (config.dashboardAuthEnabled) {
    const cookieToken = parseCookieHeader(
      firstHeaderValue(requestHeaders.cookie) ?? "",
    )[DASHBOARD_AUTH_COOKIE_NAME];
    if (!cookieToken) throw new Error("missing dashboard auth cookie");
    const payload = await config.verifyDashboardToken(cookieToken);
    if (!payload) throw new Error("invalid dashboard auth cookie");
    return { source: "cookie", subject: getJwtSubject(payload) };
  }

  if (isDevelopmentEnvironment(config.environment)) {
    return { source: "development", subject: "development" };
  }
  if (config.authBearerToken && providedToken) {
    throw new Error("invalid board workspace websocket bearer token");
  }
  throw new Error("board workspace websocket authentication is not configured");
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
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

function getJwtSubject(payload: Record<string, unknown>): string {
  if (typeof payload.sub === "string" && payload.sub.trim()) return payload.sub;
  if (typeof payload.email === "string" && payload.email.trim()) return payload.email;
  return "dashboard-user";
}

function isDevelopmentEnvironment(environment: string): boolean {
  const normalized = environment.trim().toLowerCase();
  return normalized === "development" || normalized === "dev";
}

function constantTimeEqual(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
