import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const AUTH_COOKIE_NAME = "soul_dashboard_auth";
export const OAUTH_STATE_COOKIE_NAME = "soul_oauth_state";
export const RETURN_TO_COOKIE_NAME = "soul_return_to";
export const DEV_DEFAULT_AVATAR_URL_TEMPLATE =
  "https://api.dicebear.com/7.x/identicon/svg?seed={seed}";

export type AuthRouteConfig = {
  authEnabled: boolean;
  devModeEnabled: boolean;
  googleClientId: string;
  googleClientSecret: string;
  callbackUrl: string;
  jwtSecretConfigured: boolean;
  cookieName?: string;
};

export type AuthRouteConfigProvider = {
  getConfig: () => AuthRouteConfig | Promise<AuthRouteConfig>;
};

export type AuthTokenAccessResult =
  | { ok: true }
  | { ok: false; detail: string; statusCode?: number };

export type AuthTokenResolver = (
  request: FastifyRequest,
) => AuthTokenAccessResult | Promise<AuthTokenAccessResult>;

export type AuthUserPayload = {
  email: string;
  name?: string;
  picture?: string;
  [key: string]: unknown;
};

export type AuthJwtPayload = {
  sub?: string;
  email: string;
  name?: string;
  picture?: string;
  exp?: number;
  [key: string]: unknown;
};

export type AuthJwtHelper = {
  issueToken: (user: AuthUserPayload) => string | Promise<string>;
  verifyToken: (token: string) => AuthJwtPayload | null | Promise<AuthJwtPayload | null>;
};

export type AuthNativeProfile = {
  email?: string | null;
  name?: string | null;
  picture?: string | null;
  [key: string]: unknown;
};

export type AuthNativeVerifier = (
  idToken: string,
) => AuthNativeProfile | Promise<AuthNativeProfile>;

export type AuthHttpPostRequest = {
  url: string;
  data: Record<string, string>;
};

export type AuthHttpGetRequest = {
  url: string;
  headers: Record<string, string>;
};

export type AuthHttpResponse = {
  statusCode: number;
  body: unknown;
};

export type AuthHttpClient = {
  post: (request: AuthHttpPostRequest) => Promise<AuthHttpResponse>;
  get: (request: AuthHttpGetRequest) => Promise<AuthHttpResponse>;
};

export type AuthUserAuthorizer = (
  user: AuthUserPayload,
) => string | null | undefined | Promise<string | null | undefined>;

export type AuthUserPayloadExtra = (
  payload: AuthJwtPayload,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export type AuthRouteOptions = {
  configProvider: AuthRouteConfigProvider;
  resolveTokenAccess: AuthTokenResolver;
  nativeVerifier: AuthNativeVerifier;
  jwt: AuthJwtHelper;
  httpClient: AuthHttpClient;
  generateState?: () => string;
  authorizeUser?: AuthUserAuthorizer;
  userPayloadExtra?: AuthUserPayloadExtra;
};

export const authRouteAuthRequirements = {
  "GET /api/auth/token": true,
  "POST /api/auth/google/native": false,
  "GET /api/auth/config": false,
  "GET /api/auth/google": false,
  "GET /api/auth/google/callback": false,
  "GET /api/auth/status": false,
  "POST /api/auth/logout": false,
  "POST /api/auth/dev-login": false,
} as const;

type GoogleQuery = {
  return_to?: string;
};

type CallbackQuery = {
  code?: string;
  state?: string;
  error?: string;
};

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  app.get("/api/auth/token", async (request, reply) => {
    const access = await options.resolveTokenAccess(request);
    if (!access.ok) {
      return routeError(reply, access.statusCode ?? 401, access.detail);
    }
    const token = extractCookieToken(request, await getCookieName(options))
      ?? extractBearerToken(request);
    if (!token) return routeError(reply, 401, "No auth token in session");
    return { token };
  });

  app.post("/api/auth/google/native", async (request, reply) => {
    const body = parseObjectBody(request.body);
    if (!body.ok) return routeError(reply, 422, body.detail);
    const idToken = body.value.id_token;
    if (typeof idToken !== "string") return routeError(reply, 422, "id_token is required");

    let profile: AuthNativeProfile;
    try {
      profile = await options.nativeVerifier(idToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return routeError(reply, 400, `Invalid ID token: ${message}`);
    }

    const email = normalizeOptionalString(profile.email);
    if (!email) return routeError(reply, 400, "ID token missing email");
    const user = {
      email,
      name: normalizeOptionalString(profile.name) ?? "",
      picture: normalizeOptionalString(profile.picture) ?? "",
    };
    const authError = await authorizeUser(options, user);
    if (authError) return routeError(reply, 403, authError);

    const token = await options.jwt.issueToken(user);
    return { token };
  });

  app.get<{ Querystring: CallbackQuery }>(
    "/api/auth/google/callback",
    async (request, reply) => handleGoogleCallback(request, reply, options),
  );

  app.get("/api/auth/config", async () => {
    const authConfig = await options.configProvider.getConfig();
    return {
      authEnabled: authConfig.authEnabled,
      devModeEnabled: authConfig.devModeEnabled,
    };
  });

  app.get<{ Querystring: GoogleQuery }>(
    "/api/auth/google",
    async (request, reply) => {
      const authConfig = await options.configProvider.getConfig();
      if (!authConfig.authEnabled) return routeError(reply, 404, "Auth not enabled");

      const state = options.generateState?.() ?? defaultState();
      const params = new URLSearchParams({
        client_id: authConfig.googleClientId,
        redirect_uri: callbackUrl(request, authConfig.callbackUrl),
        response_type: "code",
        scope: "openid email profile",
        access_type: "offline",
        state,
      });
      const cookies = [
        serializeCookie(OAUTH_STATE_COOKIE_NAME, state, {
          httpOnly: true,
          sameSite: "Lax",
          maxAge: 600,
          secure: isHttpsRequest(request),
        }),
      ];
      const returnTo = request.query.return_to;
      if (isSafeReturnTo(returnTo)) {
        cookies.push(
          serializeCookie(RETURN_TO_COOKIE_NAME, returnTo, {
            httpOnly: true,
            sameSite: "Lax",
            maxAge: 600,
            secure: isHttpsRequest(request),
          }),
        );
      }
      return redirectWithCookies(
        reply,
        `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
        cookies,
      );
    },
  );

  app.get("/api/auth/status", async (request) => {
    const authConfig = await options.configProvider.getConfig();
    if (!authConfig.authEnabled) return { authenticated: true, user: null };

    const token = extractCookieToken(request, cookieName(authConfig));
    if (!token) return { authenticated: false, user: null };
    const payload = await options.jwt.verifyToken(token);
    if (!payload) return { authenticated: false, user: null };

    const payloadExtra = await options.userPayloadExtra?.(payload);
    return {
      authenticated: true,
      user: {
        email: payload.email,
        name: payload.name ?? "",
        picture: payload.picture ?? "",
        ...(payloadExtra ?? {}),
      },
    };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    const authConfig = await options.configProvider.getConfig();
    return reply
      .header("set-cookie", deleteCookie(cookieName(authConfig)))
      .send({ success: true });
  });

  app.post("/api/auth/dev-login", async (request, reply) => {
    const authConfig = await options.configProvider.getConfig();
    if (!authConfig.devModeEnabled) {
      return routeError(reply, 403, "Dev login not available");
    }
    if (!authConfig.jwtSecretConfigured) {
      return routeError(reply, 500, "JWT_SECRET not configured");
    }
    const body = parseObjectBody(request.body);
    if (!body.ok) return routeError(reply, 400, body.detail);
    const email = normalizeOptionalString(body.value.email);
    if (!email) return routeError(reply, 400, "Email is required");

    const name = normalizeOptionalString(body.value.name) ?? "Developer";
    const picture = normalizeOptionalString(body.value.picture)
      ?? devDefaultAvatarUrl(email);
    const user = { email, name, picture };
    const authError = await authorizeUser(options, user);
    if (authError) return routeError(reply, 403, authError);

    const token = await options.jwt.issueToken(user);
    return reply
      .header(
        "set-cookie",
        serializeCookie(cookieName(authConfig), token, {
          httpOnly: true,
          sameSite: "Lax",
          maxAge: 7 * 24 * 3600,
        }),
      )
      .send({ success: true });
  });
}

async function handleGoogleCallback(
  request: FastifyRequest<{ Querystring: CallbackQuery }>,
  reply: FastifyReply,
  options: AuthRouteOptions,
): Promise<FastifyReply> {
  const errorCode = normalizeOptionalString(request.query.error);
  if (errorCode) return reply.redirect(`/?error=${encodeURIComponent(errorCode)}`);

  const state = normalizeOptionalString(request.query.state);
  const expectedState = parseCookies(request.headers.cookie)[OAUTH_STATE_COOKIE_NAME];
  if (!expectedState || state !== expectedState) {
    return reply.redirect("/?error=auth_failed");
  }
  const code = normalizeOptionalString(request.query.code);
  if (!code) return reply.redirect("/?error=auth_failed");

  const authConfig = await options.configProvider.getConfig();
  try {
    const tokenResponse = await options.httpClient.post({
      url: "https://oauth2.googleapis.com/token",
      data: {
        code,
        client_id: authConfig.googleClientId,
        client_secret: authConfig.googleClientSecret,
        redirect_uri: callbackUrl(request, authConfig.callbackUrl),
        grant_type: "authorization_code",
      },
    });
    if (!isSuccessStatus(tokenResponse.statusCode) || !isRecord(tokenResponse.body)) {
      return reply.redirect("/?error=auth_failed");
    }
    const accessToken = normalizeOptionalString(tokenResponse.body.access_token);
    if (!accessToken) return reply.redirect("/?error=auth_failed");

    const userinfoResponse = await options.httpClient.get({
      url: "https://www.googleapis.com/oauth2/v2/userinfo",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!isSuccessStatus(userinfoResponse.statusCode) || !isRecord(userinfoResponse.body)) {
      return reply.redirect("/?error=auth_failed");
    }
    const email = normalizeOptionalString(userinfoResponse.body.email);
    if (!email) return reply.redirect("/?error=auth_failed");
    const user = {
      email,
      name: normalizeOptionalString(userinfoResponse.body.name) ?? "",
      picture: normalizeOptionalString(userinfoResponse.body.picture) ?? "",
    };
    const authError = await authorizeUser(options, user);
    if (authError) return reply.redirect(`/?error=${encodeURIComponent(authError)}`);

    const token = await options.jwt.issueToken(user);
    const returnTo = safeReturnTo(parseCookies(request.headers.cookie)[RETURN_TO_COOKIE_NAME]);
    return redirectWithCookies(reply, returnTo, [
      serializeCookie(cookieName(authConfig), token, {
        httpOnly: true,
        sameSite: "Lax",
        maxAge: 7 * 24 * 3600,
        secure: isHttpsRequest(request),
      }),
      deleteCookie(OAUTH_STATE_COOKIE_NAME),
      deleteCookie(RETURN_TO_COOKIE_NAME),
    ]);
  } catch {
    return reply.redirect("/?error=auth_failed");
  }
}

async function authorizeUser(
  options: AuthRouteOptions,
  user: AuthUserPayload,
): Promise<string | null> {
  const result = await options.authorizeUser?.(user);
  return result ? String(result) : null;
}

async function getCookieName(options: AuthRouteOptions): Promise<string> {
  return cookieName(await options.configProvider.getConfig());
}

function cookieName(config: AuthRouteConfig): string {
  return config.cookieName ?? AUTH_COOKIE_NAME;
}

function routeError(reply: FastifyReply, statusCode: number, detail: string): FastifyReply {
  return reply.code(statusCode).send({ detail });
}

function redirectWithCookies(
  reply: FastifyReply,
  location: string,
  cookies: readonly string[],
): FastifyReply {
  return reply.header("set-cookie", [...cookies]).redirect(location);
}

function parseObjectBody(
  body: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; detail: string } {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return { ok: true, value: body as Record<string, unknown> };
  }
  return { ok: false, detail: "Request body must be a JSON object" };
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractCookieToken(request: FastifyRequest, name: string): string | undefined {
  return parseCookies(request.headers.cookie)[name];
}

function extractBearerToken(request: FastifyRequest): string | undefined {
  const authorization = headerString(request.headers.authorization);
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7);
  }
  return undefined;
}

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const cookieHeader = Array.isArray(header) ? header.join("; ") : header;
  const result: Record<string, string> = {};
  for (const part of cookieHeader?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function callbackUrl(request: FastifyRequest, configuredCallbackUrl: string): string {
  if (configuredCallbackUrl.startsWith("http")) return configuredCallbackUrl;
  const host = headerString(request.headers.host) ?? "localhost";
  const scheme = headerString(request.headers["x-forwarded-proto"]) ?? request.protocol;
  return `${scheme}://${host}${configuredCallbackUrl}`;
}

function isHttpsRequest(request: FastifyRequest): boolean {
  return (headerString(request.headers["x-forwarded-proto"]) ?? request.protocol) === "https";
}

function isSafeReturnTo(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//");
}

function safeReturnTo(value: unknown): string {
  return isSafeReturnTo(value) ? value : "/";
}

function defaultState(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function isSuccessStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function devDefaultAvatarUrl(email: string): string {
  return DEV_DEFAULT_AVATAR_URL_TEMPLATE.replace("{seed}", encodeURIComponent(email));
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly?: boolean;
    sameSite?: "Lax";
    maxAge?: number;
    path?: string;
    secure?: boolean;
  },
): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function deleteCookie(name: string): string {
  return serializeCookie(name, "", { maxAge: 0 });
}
