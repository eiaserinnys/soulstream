import { vi } from "vitest";

import {
  parseOrchServerConfig,
  type AuthHttpClient,
  type AuthJwtHelper,
  type AuthNativeVerifier,
  type AuthRouteConfig,
  type AuthRouteOptions,
  type AuthTokenResolver,
} from "../src/index.js";

export const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

export const enabledConfig: AuthRouteConfig = {
  authEnabled: true,
  devModeEnabled: true,
  googleClientId: "google-client-id",
  googleClientSecret: "google-client-secret",
  callbackUrl: "/api/auth/google/callback",
  jwtSecretConfigured: true,
};

export function createJwtHelper(): AuthJwtHelper {
  return {
    issueToken: vi.fn(async (user) => `jwt:${user.email}:${user.picture ?? ""}`),
    verifyToken: vi.fn(async (token) => {
      if (token === "valid-jwt") {
        return {
          email: "user@example.com",
          name: "User",
          picture: "https://example.com/pic.png",
          dashboardAccess: { restricted: true },
        };
      }
      return null;
    }),
  };
}

export function createNativeVerifier(): AuthNativeVerifier {
  return vi.fn(async (idToken) => {
    if (idToken === "bad-token") throw new Error("Wrong issuer");
    if (idToken === "no-email") return { name: "No Email" };
    return {
      email: "native@example.com",
      name: "Native User",
      picture: "https://example.com/native.png",
    };
  });
}

export function createHttpClient(): AuthHttpClient {
  return {
    post: vi.fn(async () => ({
      statusCode: 200,
      body: { access_token: "google-access-token" },
    })),
    get: vi.fn(async () => ({
      statusCode: 200,
      body: {
        email: "oauth@example.com",
        name: "OAuth User",
        picture: "https://example.com/oauth.png",
      },
    })),
  };
}

export function createTokenResolver(): AuthTokenResolver {
  return vi.fn<AuthTokenResolver>(async () => ({ ok: true }));
}

export function createAuthRouteOptions(
  overrides: Partial<AuthRouteOptions> = {},
): AuthRouteOptions {
  return {
    configProvider: { getConfig: vi.fn(async () => enabledConfig) },
    resolveTokenAccess: createTokenResolver(),
    nativeVerifier: createNativeVerifier(),
    jwt: createJwtHelper(),
    httpClient: createHttpClient(),
    generateState: () => "state-1",
    ...overrides,
  };
}

export function setCookieHeaders(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers["set-cookie"];
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined) return [];
  return [String(value)];
}
