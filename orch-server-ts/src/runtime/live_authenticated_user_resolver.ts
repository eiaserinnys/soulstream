import type { FastifyRequest } from "fastify";

import {
  AUTH_COOKIE_NAME,
  type AuthJwtHelper,
  type AuthJwtPayload,
} from "../auth/auth_routes.js";

export type CreateLiveAuthenticatedUserResolversOptions = {
  readonly jwt: AuthJwtHelper;
  readonly cookieName?: string;
};

export type LiveAuthenticatedUserResolver = (
  request: FastifyRequest,
) => Promise<AuthJwtPayload | null>;

export type LiveAuthenticatedEmailResolver = (
  request: FastifyRequest,
) => Promise<string | null>;

export type LiveDashboardTokenVerifier = (
  request: FastifyRequest,
  token: string,
) => Promise<AuthJwtPayload | null>;

export type LiveCallerInfoResolver = (
  request: FastifyRequest,
  bodyCallerInfo: Record<string, unknown> | null | undefined,
  systemNodeId: string,
) => Promise<Record<string, unknown>>;

export type LiveAuthenticatedUserResolvers = {
  readonly verifyToken: LiveDashboardTokenVerifier;
  readonly resolveUser: LiveAuthenticatedUserResolver;
  readonly resolveEmail: LiveAuthenticatedEmailResolver;
  readonly resolveCallerInfo: LiveCallerInfoResolver;
};

type AuthenticatedDashboardUser = {
  readonly payload: AuthJwtPayload;
  readonly carrier: "cookie" | "bearer";
};

export function createLiveAuthenticatedUserResolvers(
  options: CreateLiveAuthenticatedUserResolversOptions,
): LiveAuthenticatedUserResolvers {
  const cookieName = options.cookieName ?? AUTH_COOKIE_NAME;
  const verificationCache = new WeakMap<
    FastifyRequest,
    Map<string, Promise<AuthJwtPayload | null>>
  >();
  const verifyToken: LiveDashboardTokenVerifier = async (request, token) => {
    let requestCache = verificationCache.get(request);
    if (requestCache === undefined) {
      requestCache = new Map();
      verificationCache.set(request, requestCache);
    }
    const cachedVerification = requestCache.get(token);
    if (cachedVerification !== undefined) return await cachedVerification;
    const verification = Promise.resolve(options.jwt.verifyToken(token));
    requestCache.set(token, verification);
    return await verification;
  };
  const resolveAuthenticatedUser = async (
    request: FastifyRequest,
  ): Promise<AuthenticatedDashboardUser | null> => {
    const cookieToken = extractDashboardJwtCookieToken(request, cookieName);
    if (cookieToken !== undefined) {
      const payload = await verifyToken(request, cookieToken);
      if (payload !== null) return { payload, carrier: "cookie" };
    }
    const bearerToken = extractDashboardBearerToken(request);
    if (bearerToken !== undefined && bearerToken !== cookieToken) {
      const payload = await verifyToken(request, bearerToken);
      if (payload !== null) return { payload, carrier: "bearer" };
    }
    return null;
  };
  const resolveUser: LiveAuthenticatedUserResolver = async (request) => {
    return (await resolveAuthenticatedUser(request))?.payload ?? null;
  };

  return {
    verifyToken,
    resolveUser,
    async resolveEmail(request) {
      return (await resolveUser(request))?.email ?? null;
    },
    async resolveCallerInfo(request, bodyCallerInfo, _systemNodeId) {
      const authenticated = await resolveAuthenticatedUser(request);
      if (authenticated !== null) {
        // Credential carrier is the server-owned provenance boundary. Browser
        // cookies can only become browser, while the dashboard JWT bearer is
        // reserved for the native Soul app. A body source can never downgrade
        // an identified browser request to system/llm or strip its identity.
        const source = authenticated.carrier === "cookie" ? "browser" : "soul-app";
        return authenticatedDirectCallerInfo(
          request,
          authenticated.payload,
          source,
        );
      }
      if (bodyCallerInfo !== null && bodyCallerInfo !== undefined &&
        Object.keys(bodyCallerInfo).length > 0) {
        return bodyCallerInfo;
      }
      const callerInfo: Record<string, unknown> = {
        source: "browser",
        ip: request.ip ?? null,
        user_agent: headerString(request.headers["user-agent"]) ?? null,
        referer: headerString(request.headers.referer) ?? null,
        forwarded_for: headerString(request.headers["x-forwarded-for"]) ?? null,
      };
      return callerInfo;
    },
  };
}

function authenticatedDirectCallerInfo(
  request: FastifyRequest,
  user: AuthJwtPayload,
  source: "browser" | "soul-app",
): Record<string, unknown> {
  const callerInfo: Record<string, unknown> = {
    source,
    ip: request.ip ?? null,
    user_agent: headerString(request.headers["user-agent"]) ?? null,
    referer: headerString(request.headers.referer) ?? null,
    forwarded_for: headerString(request.headers["x-forwarded-for"]) ?? null,
  };
  if (user.name) callerInfo.display_name = user.name;
  const userId = user.email || user.sub;
  if (userId) callerInfo.user_id = userId;
  if (user.picture) callerInfo.avatar_url = user.picture;
  if (user.email) callerInfo.email = user.email;
  return callerInfo;
}

export function extractDashboardJwtToken(
  request: FastifyRequest,
  cookieName: string = AUTH_COOKIE_NAME,
): string | undefined {
  return extractDashboardJwtCookieToken(request, cookieName) ??
    extractDashboardBearerToken(request);
}

export function extractDashboardJwtCookieToken(
  request: FastifyRequest,
  cookieName: string,
): string | undefined {
  return parseCookies(headerString(request.headers.cookie))[cookieName];
}

export function extractDashboardBearerToken(
  request: FastifyRequest,
): string | undefined {
  const authorization = headerString(request.headers.authorization);
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7);
  }
  return undefined;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
