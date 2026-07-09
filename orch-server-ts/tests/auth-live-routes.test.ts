import { describe, expect, it, vi } from "vitest";

import {
  AUTH_COOKIE_NAME,
  createApp,
  createLiveAuthJwtHelper,
  createLiveAuthNativeVerifier,
  createLiveAuthTokenResolver,
  createLiveAuthUserAuthorizer,
  parseOrchServerConfig,
  type LiveConfigProviderBoundary,
} from "../src/index.js";

describe("auth routes with live providers", () => {
  const config = parseOrchServerConfig({
    environment: "test",
    databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
    authBearerToken: "service-token",
  });

  it("serves native Google auth success, invalid token, missing email, wrong audience, and allowed_email", async () => {
    const liveConfig = configWith({
      jwt_secret: "jwt-secret",
      google_ios_client_id: "ios-client-id",
      google_client_id: "google-client",
      auth_bearer_token: "service-token",
      environment: "production",
      allowed_email: "allowed@example.com",
    });
    const googleClient = {
      verifyIdToken: vi.fn(async ({ idToken, audience }) => {
        if (audience !== "ios-client-id") throw new Error("Wrong recipient");
        if (idToken === "invalid") throw new Error("Bad signature");
        if (idToken === "missing-email") return ticket({ name: "No Email" });
        if (idToken === "wrong-audience") throw new Error("Wrong recipient");
        return ticket({ email: "allowed@example.com", name: "Allowed" });
      }),
    };
    const jwt = createLiveAuthJwtHelper({
      configProvider: liveConfig,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const app = createApp({
      config,
      authRoutes: {
        configProvider: { getConfig: async () => ({
          authEnabled: true,
          devModeEnabled: true,
          googleClientId: "google-client",
          googleClientSecret: "google-secret",
          callbackUrl: "/api/auth/google/callback",
          jwtSecretConfigured: true,
          cookieName: AUTH_COOKIE_NAME,
        }) },
        httpClient: { post: vi.fn(), get: vi.fn() },
        jwt,
        nativeVerifier: createLiveAuthNativeVerifier({ configProvider: liveConfig, googleClient }),
        resolveTokenAccess: createLiveAuthTokenResolver({ configProvider: liveConfig, jwt }),
        authorizeUser: createLiveAuthUserAuthorizer({ configProvider: liveConfig }),
      },
    });

    const success = await app.inject({
      method: "POST",
      url: "/api/auth/google/native",
      payload: { id_token: "valid" },
    });
    expect(success.statusCode).toBe(200);
    await expect(jwt.verifyToken(success.json().token)).resolves.toMatchObject({
      email: "allowed@example.com",
      name: "Allowed",
    });

    for (const [idToken, detail] of [
      ["invalid", "Invalid ID token: Bad signature"],
      ["missing-email", "ID token missing email"],
      ["wrong-audience", "Invalid ID token: Wrong recipient"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/google/native",
        payload: { id_token: idToken },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ detail });
    }

    googleClient.verifyIdToken.mockResolvedValueOnce(ticket({ email: "other@example.com" }));
    const denied = await app.inject({
      method: "POST",
      url: "/api/auth/google/native",
      payload: { id_token: "other" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ detail: "no_user" });

    await app.close();
  });

  it("serves auth status, dev-login, and token handoff through live JWT/token providers", async () => {
    const liveConfig = configWith({
      jwt_secret: "jwt-secret",
      google_client_id: "google-client",
      auth_bearer_token: "service-token",
      environment: "production",
      allowed_email: "dev@example.com",
    });
    const jwt = createLiveAuthJwtHelper({
      configProvider: liveConfig,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const authConfig = {
      authEnabled: true,
      devModeEnabled: true,
      googleClientId: "google-client",
      googleClientSecret: "google-secret",
      callbackUrl: "/api/auth/google/callback",
      jwtSecretConfigured: true,
      cookieName: AUTH_COOKIE_NAME,
    };
    const app = createApp({
      config,
      authRoutes: {
        configProvider: { getConfig: async () => authConfig },
        httpClient: { post: vi.fn(), get: vi.fn() },
        jwt,
        nativeVerifier: vi.fn(),
        resolveTokenAccess: createLiveAuthTokenResolver({ configProvider: liveConfig, jwt }),
        authorizeUser: createLiveAuthUserAuthorizer({ configProvider: liveConfig }),
      },
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/dev-login",
      payload: { email: "dev@example.com", name: "Dev" },
    });
    const cookie = String(login.headers["set-cookie"]);
    const token = cookie.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`))?.[1];
    expect(token).toBeTruthy();

    expect((await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } })).json()).toMatchObject({
      authenticated: true,
      user: { email: "dev@example.com", name: "Dev" },
    });
    expect((await app.inject({ method: "GET", url: "/api/auth/token", headers: { cookie } })).json()).toEqual({
      token,
    });
    expect((await app.inject({
      method: "GET",
      url: "/api/auth/token",
      headers: { authorization: "Bearer service-token" },
    })).json()).toEqual({ token: "service-token" });

    const denied = await app.inject({
      method: "POST",
      url: "/api/auth/dev-login",
      payload: { email: "other@example.com" },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ detail: "no_user" });

    await app.close();
  });
});

function configWith(values: Record<string, unknown>): LiveConfigProviderBoundary {
  return {
    getConfig: vi.fn(async () => values),
    requireConfig: vi.fn(async (key: string) => {
      if (!(key in values)) throw new Error(`${key} is required`);
      return values[key];
    }),
  };
}

function ticket(payload: Record<string, unknown>) {
  return { getPayload: () => payload };
}
