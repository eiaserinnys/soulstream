import { createHmac, timingSafeEqual } from "node:crypto";

import { OAuth2Client } from "google-auth-library";

import type {
  AuthHttpClient,
  AuthHttpGetRequest,
  AuthJwtHelper,
  AuthJwtPayload,
  AuthNativeProfile,
  AuthNativeVerifier,
  AuthHttpPostRequest,
  AuthHttpResponse,
  AuthTokenResolver,
  AuthUserAuthorizer,
} from "../auth/auth_routes.js";
import { AUTH_COOKIE_NAME } from "../auth/auth_routes.js";
import type { LiveConfigProviderBoundary } from "./live_provider_dependencies.js";

export type LiveAuthHttpClientFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type CreateLiveAuthHttpClientOptions = {
  readonly fetch?: LiveAuthHttpClientFetch;
  readonly timeoutMs?: number;
};

export type CreateLiveAuthJwtHelperOptions = {
  readonly configProvider: LiveConfigProviderBoundary;
  readonly now?: () => Date;
  readonly expiresDays?: number;
};

export type LiveGoogleIdTokenClient = {
  readonly verifyIdToken: (options: {
    readonly idToken: string;
    readonly audience: string | string[];
  }) => Promise<{
    readonly getPayload: () => AuthNativeProfile | undefined;
  }>;
};

export type CreateLiveAuthNativeVerifierOptions = {
  readonly configProvider: LiveConfigProviderBoundary;
  readonly googleClient?: LiveGoogleIdTokenClient;
};

export type CreateLiveAuthTokenResolverOptions = {
  readonly configProvider: LiveConfigProviderBoundary;
  readonly jwt?: AuthJwtHelper;
  readonly cookieName?: string;
};

export type CreateLiveAuthUserAuthorizerOptions = {
  readonly configProvider: LiveConfigProviderBoundary;
};

const DEFAULT_AUTH_HTTP_TIMEOUT_MS = 5_000;
const JWT_ALGORITHM = "HS256";
const DEFAULT_JWT_EXPIRES_DAYS = 7;
const SECONDS_PER_DAY = 24 * 3600;

export function createLiveAuthHttpClient(
  options: CreateLiveAuthHttpClientOptions = {},
): AuthHttpClient {
  const fetch = options.fetch ?? globalThis.fetch;
  if (typeof fetch !== "function") {
    throw new Error("global fetch is required for live auth HTTP client");
  }
  const timeoutMs = normalizeAuthHttpTimeoutMs(options.timeoutMs);

  return {
    post: (request) => sendAuthPost(fetch, timeoutMs, request),
    get: (request) => sendAuthGet(fetch, timeoutMs, request),
  };
}

export function createLiveAuthJwtHelper(
  options: CreateLiveAuthJwtHelperOptions,
): AuthJwtHelper {
  const now = options.now ?? (() => new Date());
  const expiresDays = options.expiresDays ?? DEFAULT_JWT_EXPIRES_DAYS;
  if (!Number.isFinite(expiresDays)) {
    throw new Error(`JWT expiresDays must be finite: ${expiresDays}`);
  }

  return {
    issueToken: async (user) => {
      const secret = await requireNonEmptyConfigString(
        options.configProvider,
        "jwt_secret",
      );
      const exp = Math.floor(now().getTime() / 1000) +
        Math.floor(expiresDays * SECONDS_PER_DAY);
      const payload: Record<string, unknown> = {
        sub: user.email,
        email: user.email,
        name: user.name ?? "",
        exp,
      };
      if (user.picture) payload.picture = user.picture;
      return signJwt(payload, secret);
    },
    verifyToken: async (token) => {
      const secret = await requireNonEmptyConfigString(
        options.configProvider,
        "jwt_secret",
      );
      return verifyJwt(token, secret, Math.floor(now().getTime() / 1000));
    },
  };
}

export function createLiveAuthNativeVerifier(
  options: CreateLiveAuthNativeVerifierOptions,
): AuthNativeVerifier {
  const googleClient = options.googleClient ?? createDefaultGoogleIdTokenClient();
  return async (idToken) => {
    const audience = await requireNonEmptyConfigString(
      options.configProvider,
      "google_ios_client_id",
    );
    const ticket = await googleClient.verifyIdToken({ idToken, audience });
    return ticket.getPayload() ?? {};
  };
}

function createDefaultGoogleIdTokenClient(): LiveGoogleIdTokenClient {
  const client = new OAuth2Client();
  return {
    verifyIdToken: async (options) => {
      const ticket = await client.verifyIdToken(options);
      return {
        getPayload: () => {
          const payload = ticket.getPayload();
          return payload === undefined ? undefined : { ...payload };
        },
      };
    },
  };
}

export function createLiveAuthTokenResolver(
  options: CreateLiveAuthTokenResolverOptions,
): AuthTokenResolver {
  const jwt = options.jwt ?? createLiveAuthJwtHelper({
    configProvider: options.configProvider,
  });
  const cookieName = options.cookieName ?? AUTH_COOKIE_NAME;

  return async (request) => {
    const snapshot = await options.configProvider.getConfig();
    const configuredBearer = optionalConfigString(snapshot, "auth_bearer_token");
    const environment = requiredSnapshotString(snapshot, "environment");
    const googleClientId = requiredSnapshotString(snapshot, "google_client_id");

    if (!configuredBearer) {
      if (isProductionEnvironment(environment)) {
        return {
          ok: false,
          statusCode: 500,
          detail: "Authentication not configured",
        };
      }
      return { ok: true };
    }

    const bearer = verifyServiceBearer(request, configuredBearer);
    if (bearer.ok) return { ok: true };

    if (googleClientId.length > 0) {
      const dashboardToken = extractCookieToken(request, cookieName) ??
        extractBearerToken(request);
      if (dashboardToken) {
        const payload = await jwt.verifyToken(dashboardToken);
        if (payload) return { ok: true };
      }
    }

    return bearer;
  };
}

export function createLiveAuthUserAuthorizer(
  options: CreateLiveAuthUserAuthorizerOptions,
): AuthUserAuthorizer {
  return async (user) => {
    const snapshot = await options.configProvider.getConfig();
    const allowedEmail = optionalConfigString(snapshot, "allowed_email")
      ?.trim()
      .toLowerCase();
    if (!allowedEmail) return null;
    const email = user.email.trim().toLowerCase();
    return email === allowedEmail ? null : "no_user";
  };
}

async function sendAuthPost(
  fetch: LiveAuthHttpClientFetch,
  timeoutMs: number,
  request: AuthHttpPostRequest,
): Promise<AuthHttpResponse> {
  return sendAuthRequest(fetch, timeoutMs, request.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(request.data),
  });
}

async function sendAuthGet(
  fetch: LiveAuthHttpClientFetch,
  timeoutMs: number,
  request: AuthHttpGetRequest,
): Promise<AuthHttpResponse> {
  return sendAuthRequest(fetch, timeoutMs, request.url, {
    method: "GET",
    headers: request.headers,
  });
}

async function sendAuthRequest(
  fetch: LiveAuthHttpClientFetch,
  timeoutMs: number,
  url: string,
  init: RequestInit,
): Promise<AuthHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    if (response.status !== 200) {
      return {
        statusCode: response.status,
        body: await response.text(),
      };
    }
    return {
      statusCode: response.status,
      body: await response.json(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAuthHttpTimeoutMs(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? DEFAULT_AUTH_HTTP_TIMEOUT_MS;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`Auth HTTP timeoutMs must be a positive integer: ${resolved}`);
  }
  return resolved;
}

async function requireNonEmptyConfigString(
  configProvider: LiveConfigProviderBoundary,
  key: string,
): Promise<string> {
  let value: unknown;
  try {
    value = await configProvider.requireConfig(key);
  } catch {
    throw new Error(`${key} is required`);
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  if (value.length === 0) {
    throw new Error(`${key} must be configured`);
  }
  return value;
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: JWT_ALGORITHM, typ: "JWT" };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  return `${signingInput}.${hmacSha256(signingInput, secret)}`;
}

function verifyJwt(
  token: string,
  secret: string,
  nowSeconds: number,
): AuthJwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

  const header = decodeJsonRecord(encodedHeader);
  if (header?.alg !== JWT_ALGORITHM) return null;

  const expected = hmacSha256(`${encodedHeader}.${encodedPayload}`, secret);
  if (!constantTimeStringEqual(encodedSignature, expected)) return null;

  const payload = decodeJsonRecord(encodedPayload);
  if (!payload || typeof payload.email !== "string") return null;
  if (typeof payload.exp === "number" && payload.exp <= nowSeconds) return null;
  return payload as AuthJwtPayload;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hmacSha256(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyServiceBearer(
  request: Parameters<AuthTokenResolver>[0],
  configuredBearer: string,
): AuthTokenAccessResult {
  const authorization = headerString(request.headers.authorization);
  if (!authorization) {
    return {
      ok: false,
      statusCode: 401,
      detail: "Authorization 헤더가 필요합니다",
    };
  }
  const parts = authorization.split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    return {
      ok: false,
      statusCode: 401,
      detail: "Bearer 토큰 형식이 올바르지 않습니다",
    };
  }
  if (!constantTimeStringEqual(parts[1] ?? "", configuredBearer)) {
    return {
      ok: false,
      statusCode: 401,
      detail: "유효하지 않은 토큰입니다",
    };
  }
  return { ok: true };
}

type AuthTokenAccessResult = Awaited<ReturnType<AuthTokenResolver>>;

function requiredSnapshotString(
  snapshot: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = snapshot[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function optionalConfigString(
  snapshot: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = snapshot[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function isProductionEnvironment(environment: string): boolean {
  return environment.toLowerCase() === "production";
}

function extractCookieToken(
  request: Parameters<AuthTokenResolver>[0],
  name: string,
): string | undefined {
  return parseCookies(headerString(request.headers.cookie))[name];
}

function extractBearerToken(
  request: Parameters<AuthTokenResolver>[0],
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
