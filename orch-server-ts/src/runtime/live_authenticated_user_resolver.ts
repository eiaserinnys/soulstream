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

export type LiveAuthenticatedUserResolvers = {
  readonly resolveUser: LiveAuthenticatedUserResolver;
  readonly resolveEmail: LiveAuthenticatedEmailResolver;
};

export function createLiveAuthenticatedUserResolvers(
  options: CreateLiveAuthenticatedUserResolversOptions,
): LiveAuthenticatedUserResolvers {
  const cookieName = options.cookieName ?? AUTH_COOKIE_NAME;
  const resolveUser: LiveAuthenticatedUserResolver = async (request) => {
    const token = extractDashboardJwtToken(request, cookieName);
    if (token === undefined) return null;
    return await options.jwt.verifyToken(token);
  };

  return {
    resolveUser,
    async resolveEmail(request) {
      return (await resolveUser(request))?.email ?? null;
    },
  };
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
