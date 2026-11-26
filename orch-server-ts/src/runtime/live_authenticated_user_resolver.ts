import { resolveTailscaleIdentity } from "../auth/tailscale_identity.js";
import { resolveDashboardLoginMode } from "../auth/login_mode.js";
import type { LiveConfigProviderBoundary } from "./live_provider_dependencies.js";
import { isServiceCaller, type ServiceCaller } from "../auth/service_caller.js";
import type { FastifyRequest } from "fastify";

import {
  AUTH_COOKIE_NAME,
  type AuthJwtHelper,
  type AuthJwtPayload,
} from "../auth/auth_routes.js";
import { extractBearerToken } from "../auth/service_bearer.js";
import type { OAuthAccessTokenResolver, OAuthResourceAccess } from "../oauth/oauth_access.js";
import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_NAME,
  isDevelopmentNoLoginRequest,
  type EnsureLocalOwner,
} from "../auth/first_login_access.js";

export type DashboardAuthHeaders = FastifyRequest["headers"];

export type CreateLiveAuthenticatedUserResolversOptions = {
  readonly jwt: AuthJwtHelper;
  readonly configProvider?: LiveConfigProviderBoundary;
  readonly cookieName?: string;
  readonly resolveOAuthToken?: OAuthAccessTokenResolver;
  readonly isServiceBearer?: (request: FastifyRequest) => Promise<boolean>;
  /** Guarantees the users row of the development default user (owner@local). */
  readonly ensureLocalOwner?: EnsureLocalOwner;
};

export type LiveAuthenticatedUserResolver = (
  request: FastifyRequest,
) => Promise<AuthJwtPayload | null>;

export type LiveAuthenticatedEmailResolver = (
  request: FastifyRequest,
) => Promise<string | null>;

/**
 * Dashboard JWT identity, or the OAuth access subject when no JWT is present.
 * Page and planner browser routes use this so an OAuth token reaches the same
 * user the dashboard cookie would.
 */
export type LiveBrowserUser = {
  readonly email?: string;
  readonly sub?: string;
};

export type LiveBrowserUserResolver = (
  request: FastifyRequest,
) => Promise<LiveBrowserUser | null>;

export type LiveDashboardTokenVerifier = (
  request: FastifyRequest,
  token: string,
) => Promise<AuthJwtPayload | null>;

export type LiveCallerInfoResolver = (
  request: FastifyRequest | ServiceCaller,
  bodyCallerInfo: Record<string, unknown> | null | undefined,
  systemNodeId: string,
) => Promise<Record<string, unknown>>;

export type LiveAuthenticatedUserResolvers = {
  readonly verifyToken: LiveDashboardTokenVerifier;
  readonly resolveOAuthAccess: (request: FastifyRequest) => Promise<OAuthResourceAccess | null>;
  readonly resolveUser: LiveAuthenticatedUserResolver;
  readonly resolveUserOrOAuthEmail: LiveBrowserUserResolver;
  readonly resolveUserFromHeaders: (
    headers: DashboardAuthHeaders,
  ) => Promise<AuthenticatedDashboardUser | null>;
  readonly resolveEmail: LiveAuthenticatedEmailResolver;
  readonly resolveCallerInfo: LiveCallerInfoResolver;
};

export type AuthenticatedDashboardUser = {
  readonly payload: AuthJwtPayload;
  readonly carrier: "cookie" | "bearer" | "tailscale" | "development";
};

export function createLiveAuthenticatedUserResolvers(
  options: CreateLiveAuthenticatedUserResolversOptions,
): LiveAuthenticatedUserResolvers {
  const cookieName = options.cookieName ?? AUTH_COOKIE_NAME;
  const verificationCache = new WeakMap<
    FastifyRequest,
    Map<string, Promise<AuthJwtPayload | null>>
  >();
  const oauthVerificationCache = new WeakMap<FastifyRequest, Promise<OAuthResourceAccess | null>>();
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
  let developmentOwnerReady: Promise<void> | undefined;
  const ensureDevelopmentOwner = async (): Promise<void> => {
    if (options.ensureLocalOwner === undefined) return;
    developmentOwnerReady ??= options.ensureLocalOwner().catch((error: unknown) => {
      developmentOwnerReady = undefined;
      throw error;
    });
    await developmentOwnerReady;
  };
  const resolveUserFromHeaders = async (
    headers: DashboardAuthHeaders,
    verify: (token: string) => Promise<AuthJwtPayload | null>,
    request?: FastifyRequest,
  ): Promise<AuthenticatedDashboardUser | null> => {
    const config = await options.configProvider?.getConfig();
    if (config && resolveDashboardLoginMode({
      google_client_id: typeof config.google_client_id === "string" ? config.google_client_id : "",
      dashboard_admin_password: typeof config.dashboard_admin_password === "string" ? config.dashboard_admin_password : "",
      tailscale_auth_enabled: config.tailscale_auth_enabled === true,
    }) === "tailscale") {
      if (request && await options.isServiceBearer?.(request)) return null;
      const email = resolveTailscaleIdentity(headers, typeof config.tailscale_allowed_login === "string" ? config.tailscale_allowed_login : "");
      return email ? { payload: { email, name: email }, carrier: "tailscale" } : null;
    }
    const cookieToken = extractDashboardJwtCookieTokenFromHeader(
      headers.cookie,
      cookieName,
    );
    if (cookieToken !== undefined) {
      const payload = await verify(cookieToken);
      if (payload !== null) return { payload, carrier: "cookie" };
    }
    const bearerToken = extractBearerToken(headers.authorization);
    if (bearerToken !== undefined && bearerToken !== cookieToken) {
      const payload = await verify(bearerToken);
      if (payload !== null) return { payload, carrier: "bearer" };
    }
    if (config && isDevelopmentNoLoginRequest(config, headers)) {
      await ensureDevelopmentOwner();
      return {
        payload: { email: LOCAL_OWNER_EMAIL, name: LOCAL_OWNER_NAME, picture: "" },
        carrier: "development",
      };
    }
    return null;
  };
  const resolveAuthenticatedUser = async (request: FastifyRequest) => {
    const authenticated = await resolveUserFromHeaders(
      request.headers,
      (token) => verifyToken(request, token),
      request,
    );
    return authenticated;
  };
  const resolveHeadersWithoutRequest = (headers: DashboardAuthHeaders) =>
    resolveUserFromHeaders(headers, (token) => Promise.resolve(options.jwt.verifyToken(token)));
  const resolveOAuthAccess = async (request: FastifyRequest): Promise<OAuthResourceAccess | null> => {
    const cached = oauthVerificationCache.get(request);
    if (cached !== undefined) return await cached;
    const token = extractBearerToken(request.headers.authorization);
    if (token === undefined || options.resolveOAuthToken === undefined) return null;
    if (await options.isServiceBearer?.(request) || await resolveAuthenticatedUser(request)) return null;
    const verification = options.resolveOAuthToken(token);
    oauthVerificationCache.set(request, verification);
    return await verification;
  };
  const resolveUser: LiveAuthenticatedUserResolver = async (request) => {
    return (await resolveAuthenticatedUser(request))?.payload ?? null;
  };
  const resolveUserOrOAuthEmail: LiveBrowserUserResolver = async (request) => {
    const authenticated = await resolveAuthenticatedUser(request);
    if (authenticated !== null) return authenticated.payload;
    if (isServiceCaller(request)) return null;
    const oauthAccess = await resolveOAuthAccess(request);
    return oauthAccess === null ? null : { email: oauthAccess.email };
  };

  return {
    verifyToken,
    resolveOAuthAccess,
    resolveUser,
    resolveUserOrOAuthEmail,
    resolveUserFromHeaders: resolveHeadersWithoutRequest,
    async resolveEmail(request) {
      const user = await resolveUser(request);
      if (user !== null) return user.email;
      if (isServiceCaller(request)) return null;
      return (await resolveOAuthAccess(request))?.email ?? null;
    },
    async resolveCallerInfo(request, bodyCallerInfo, systemNodeId) {
      const authenticated = isServiceCaller(request) ? null : await resolveAuthenticatedUser(request);
      if (authenticated !== null && !isServiceCaller(request)) {
        // Cookies and Serve identities are browser callers; dashboard JWT
        // bearers belong to the native app. The body cannot change provenance.
        const source = authenticated.carrier !== "bearer" ? "browser" : "soul-app";
        return authenticatedDirectCallerInfo(
          request,
          authenticated.payload,
          source,
        );
      }
      if (!isServiceCaller(request)) {
        const oauthAccess = await resolveOAuthAccess(request);
        if (oauthAccess !== null) {
          return {
            ...requestCallerMetadata(request),
            source: "browser",
            transport: "oauth",
            oauth_client_id: oauthAccess.clientId,
            oauth_client_name: oauthAccess.clientName,
            display_name: oauthAccess.displayName,
            user_id: oauthAccess.email,
            email: oauthAccess.email,
            ...(oauthAccess.avatarUrl ? { avatar_url: oauthAccess.avatarUrl } : {}),
          };
        }
      }
      if (bodyCallerInfo !== null && bodyCallerInfo !== undefined &&
        Object.keys(bodyCallerInfo).length > 0) {
        return bodyCallerInfo;
      }
      if (isServiceCaller(request) || await options.isServiceBearer?.(request)) {
        return {
          source: "system",
          agent_node: systemNodeId,
          display_name: "Soulstream",
          user_id: null,
          avatar_url: "/api/system/portraits/system",
        };
      }
      const callerInfo: Record<string, unknown> = {
        source: "browser",
        ...requestCallerMetadata(request),
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
    ...requestCallerMetadata(request),
  };
  if (user.name) callerInfo.display_name = user.name;
  const userId = user.email || user.sub;
  if (userId) callerInfo.user_id = userId;
  if (user.picture) callerInfo.avatar_url = user.picture;
  if (user.email) callerInfo.email = user.email;
  return callerInfo;
}

function requestCallerMetadata(request: FastifyRequest | ServiceCaller): Record<string, unknown> {
  if (isServiceCaller(request)) {
    return { ip: null, user_agent: null, referer: null, forwarded_for: null };
  }
  return {
    ip: request.ip ?? null,
    user_agent: headerString(request.headers["user-agent"]) ?? null,
    referer: headerString(request.headers.referer) ?? null,
    forwarded_for: headerString(request.headers["x-forwarded-for"]) ?? null,
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
  return extractDashboardJwtCookieTokenFromHeader(request.headers.cookie, cookieName);
}

function extractDashboardJwtCookieTokenFromHeader(
  header: string | string[] | undefined,
  cookieName: string,
): string | undefined {
  return parseCookies(headerString(header))[cookieName];
}

export function extractDashboardBearerToken(
  request: FastifyRequest,
): string | undefined {
  return extractBearerToken(request.headers.authorization);
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
