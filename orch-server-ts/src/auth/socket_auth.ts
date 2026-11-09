import type { IncomingHttpHeaders } from "node:http";

import { AUTH_COOKIE_NAME } from "./auth_routes.js";
import { verifyServiceBearerAuthorization } from "./service_bearer.js";
import type { NodeCredentialResolver, NodePrincipal } from "../node_credentials/types.js";

export const DASHBOARD_AUTH_COOKIE_NAME = AUTH_COOKIE_NAME;

export interface SocketAuthConfig {
  authBearerToken: string;
  environment: string;
  /** Node pairing credentials; `null` is explicit outside production composition. */
  nodeCredentials: NodeCredentialResolver | null;
  dashboardAuthEnabled: boolean;
  resolveDashboardUserFromHeaders: (
    headers: Pick<IncomingHttpHeaders, "authorization" | "cookie">,
  ) => Promise<{
    payload: Record<string, unknown>;
    carrier: "cookie" | "bearer";
  } | null>;
}

export interface SocketAuthInput {
  token?: string | null;
  requestHeaders: IncomingHttpHeaders;
  config: SocketAuthConfig;
}

export interface SocketAuthResult {
  source: "bearer" | "cookie" | "development";
  subject: string;
  /** Present only when a node pairing credential authenticated the socket. */
  principal?: NodePrincipal;
}

export async function authenticateSocketConnection({
  token,
  requestHeaders,
  config,
}: SocketAuthInput): Promise<SocketAuthResult> {
  const serviceAuthorization = token
    ? `Bearer ${token}`
    : requestHeaders.authorization;
  const serviceBearer = verifyServiceBearerAuthorization(
    serviceAuthorization,
    {
      configuredToken: config.authBearerToken,
      environment: config.environment,
      nodeCredentials: config.nodeCredentials,
    },
  );
  if (serviceBearer.ok && !serviceBearer.developmentBypass) {
    return serviceBearer.principal === undefined
      ? { source: "bearer", subject: "bearer" }
      : { source: "bearer", subject: "bearer", principal: serviceBearer.principal };
  }

  if (config.dashboardAuthEnabled) {
    const dashboardUser = await config.resolveDashboardUserFromHeaders(requestHeaders);
    if (dashboardUser) {
      return {
        source: dashboardUser.carrier,
        subject: getJwtSubject(dashboardUser.payload),
      };
    }
    if (firstHeaderValue(requestHeaders.cookie)) {
      throw new Error("invalid dashboard authentication credentials");
    }
    if (firstHeaderValue(requestHeaders.authorization)) {
      throw new Error("invalid dashboard bearer token");
    }
    throw new Error("missing dashboard authentication credentials");
  }

  if (serviceBearer.ok) {
    return { source: "development", subject: "development" };
  }
  if (serviceBearer.reason === "not_configured") {
    throw new Error("board workspace websocket authentication is not configured");
  }
  if (serviceBearer.reason === "missing") {
    throw new Error("missing board workspace websocket bearer token");
  }
  if (serviceBearer.reason === "malformed" || serviceBearer.reason === "invalid") {
    throw new Error("invalid board workspace websocket bearer token");
  }
  throw new Error("board workspace websocket authentication is not configured");
}

function getJwtSubject(payload: Record<string, unknown>): string {
  if (typeof payload.sub === "string" && payload.sub.trim()) return payload.sub;
  if (typeof payload.email === "string" && payload.email.trim()) return payload.email;
  return "dashboard-user";
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
