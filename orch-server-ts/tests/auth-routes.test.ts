import { describe, expect, it, vi } from "vitest";

import {
  AUTH_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  RETURN_TO_COOKIE_NAME,
  authRouteAuthRequirements,
  createApp,
  loadContractFixtures,
} from "../src/index.js";
import {
  config,
  createAuthRouteOptions,
  createHttpClient,
  createJwtHelper,
  createNativeVerifier,
  createTokenResolver,
  enabledConfig,
  setCookieHeaders,
} from "./auth-route-test-helpers.js";

describe("Auth route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps auth routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["GET", "/api/auth/token"],
      ["POST", "/api/auth/google/native", { id_token: "token" }],
      ["GET", "/api/auth/config"],
      ["GET", "/api/auth/google"],
      ["GET", "/api/auth/google/callback?code=c&state=s"],
      ["GET", "/api/auth/status"],
      ["POST", "/api/auth/logout"],
      ["POST", "/api/auth/dev-login", { email: "dev@example.com" }],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 113-120", () => {
    expect(authRouteAuthRequirements).toEqual({
      "GET /api/auth/token": true,
      "POST /api/auth/google/native": false,
      "GET /api/auth/config": false,
      "GET /api/auth/google": false,
      "GET /api/auth/google/callback": false,
      "GET /api/auth/status": false,
      "POST /api/auth/logout": false,
      "POST /api/auth/dev-login": false,
    });

    expect(
      fixtures.routeInventory.routes
        .filter((route) => route.order >= 113 && route.order <= 120)
        .map((route) => [route.order, route.methods[0], route.path, route.authRequired]),
    ).toEqual([
      [113, "GET", "/api/auth/token", true],
      [114, "POST", "/api/auth/google/native", false],
      [115, "GET", "/api/auth/config", false],
      [116, "GET", "/api/auth/google", false],
      [117, "GET", "/api/auth/google/callback", false],
      [118, "GET", "/api/auth/status", false],
      [119, "POST", "/api/auth/logout", false],
      [120, "POST", "/api/auth/dev-login", false],
    ]);
  });

  it("returns cookie auth token before Bearer fallback after route-owned auth succeeds", async () => {
    const resolveTokenAccess = createTokenResolver();
    const app = createApp({
      config,
      authRoutes: createAuthRouteOptions({ resolveTokenAccess }),
    });

    const cookieResponse = await app.inject({
      method: "GET",
      url: "/api/auth/token",
      headers: {
        authorization: "Bearer bearer-token",
        cookie: `${AUTH_COOKIE_NAME}=cookie-token`,
      },
    });
    const bearerResponse = await app.inject({
      method: "GET",
      url: "/api/auth/token",
      headers: { authorization: "Bearer bearer-token" },
    });

    expect(cookieResponse.json()).toEqual({ token: "cookie-token" });
    expect(bearerResponse.json()).toEqual({ token: "bearer-token" });
    expect(resolveTokenAccess).toHaveBeenCalledTimes(2);

    await app.close();
  });

  it("maps auth token resolver failures and missing token to detail responses", async () => {
    const rejected = createApp({
      config,
      authRoutes: createAuthRouteOptions({
        resolveTokenAccess: vi.fn(async () => ({
          ok: false,
          statusCode: 403,
          detail: "Forbidden auth token",
        })),
      }),
    });
    const rejectedResponse = await rejected.inject({
      method: "GET",
      url: "/api/auth/token",
    });
    expect(rejectedResponse.statusCode).toBe(403);
    expect(rejectedResponse.json()).toEqual({ detail: "Forbidden auth token" });
    await rejected.close();

    const missing = createApp({
      config,
      authRoutes: createAuthRouteOptions(),
    });
    const missingResponse = await missing.inject({
      method: "GET",
      url: "/api/auth/token",
    });
    expect(missingResponse.statusCode).toBe(401);
    expect(missingResponse.json()).toEqual({ detail: "No auth token in session" });
    await missing.close();
  });

  it("verifies native Google ID tokens through injected verifier and JWT issuer", async () => {
    const nativeVerifier = createNativeVerifier();
    const jwt = createJwtHelper();
    const app = createApp({
      config,
      authRoutes: createAuthRouteOptions({ nativeVerifier, jwt }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/google/native",
      payload: { id_token: "google-id-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ token: "jwt:native@example.com:https://example.com/native.png" });
    expect(nativeVerifier).toHaveBeenCalledWith("google-id-token");
    expect(jwt.issueToken).toHaveBeenCalledWith({
      email: "native@example.com",
      name: "Native User",
      picture: "https://example.com/native.png",
    });

    await app.close();
  });

  it("keeps native Google validation errors explicit", async () => {
    const app = createApp({ config, authRoutes: createAuthRouteOptions() });

    expect((await app.inject({
      method: "POST",
      url: "/api/auth/google/native",
      payload: {},
    })).statusCode).toBe(422);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/auth/google/native",
      payload: { id_token: "bad-token" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ detail: "Invalid ID token: Wrong issuer" });

    const noEmail = await app.inject({
      method: "POST",
      url: "/api/auth/google/native",
      payload: { id_token: "no-email" },
    });
    expect(noEmail.statusCode).toBe(400);
    expect(noEmail.json()).toEqual({ detail: "ID token missing email" });

    await app.close();
  });

  it("returns OAuth config and redirects Google auth with safe state and return_to cookies", async () => {
    const app = createApp({ config, authRoutes: createAuthRouteOptions() });

    const configResponse = await app.inject({ method: "GET", url: "/api/auth/config" });
    expect(configResponse.json()).toEqual({ authEnabled: true, devModeEnabled: true });

    const google = await app.inject({
      method: "GET",
      url: "/api/auth/google?return_to=/folder/a",
    });
    expect(google.statusCode).toBe(302);
    const location = new URL(String(google.headers.location));
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("google-client-id");
    expect(location.searchParams.get("state")).toBe("state-1");
    const googleCookies = setCookieHeaders(google);
    expect(googleCookies.some((header) => header.startsWith(`${OAUTH_STATE_COOKIE_NAME}=state-1;`))).toBe(true);
    expect(googleCookies.find((header) => header.startsWith(`${OAUTH_STATE_COOKIE_NAME}=state-1;`))).toContain("Path=/");
    expect(googleCookies.some((header) => header.startsWith(`${RETURN_TO_COOKIE_NAME}=/folder/a;`))).toBe(true);
    expect(googleCookies.find((header) => header.startsWith(`${RETURN_TO_COOKIE_NAME}=/folder/a;`))).toContain("Path=/");

    const unsafe = await app.inject({
      method: "GET",
      url: "/api/auth/google?return_to=//evil.example/path",
    });
    expect(setCookieHeaders(unsafe).some((header) => header.startsWith(`${RETURN_TO_COOKIE_NAME}=`))).toBe(false);

    await app.close();
  });

  it("keeps OAuth disabled Google auth as 404", async () => {
    const app = createApp({
      config,
      authRoutes: createAuthRouteOptions({
        configProvider: {
          getConfig: vi.fn(async () => ({ ...enabledConfig, authEnabled: false })),
        },
      }),
    });

    const response = await app.inject({ method: "GET", url: "/api/auth/google" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ detail: "Auth not enabled" });

    await app.close();
  });

  it("maps OAuth callback failure and authorization failure to Python redirect wire", async () => {
    const app = createApp({
      config,
      authRoutes: createAuthRouteOptions({
        authorizeUser: vi.fn(async () => "no_user"),
      }),
    });

    const stateMismatch = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=c&state=bad",
      headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state-1` },
    });
    expect(stateMismatch.statusCode).toBe(302);
    expect(stateMismatch.headers.location).toBe("/?error=auth_failed");

    const denied = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=c&state=state-1",
      headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state-1` },
    });
    expect(denied.statusCode).toBe(302);
    expect(denied.headers.location).toBe("/?error=no_user");

    const providerError = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?error=access_denied&state=state-1",
      headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=state-1` },
    });
    expect(providerError.headers.location).toBe("/?error=access_denied");

    await app.close();
  });

  it("exchanges OAuth callback code through injected HTTP client and sets JWT cookie", async () => {
    const httpClient = createHttpClient();
    const jwt = createJwtHelper();
    const app = createApp({
      config,
      authRoutes: createAuthRouteOptions({ httpClient, jwt }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=auth-code&state=state-1",
      headers: {
        host: "orch.example.com",
        cookie: `${OAUTH_STATE_COOKIE_NAME}=state-1; ${RETURN_TO_COOKIE_NAME}=/after-login`,
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/after-login");
    expect(httpClient.post).toHaveBeenCalledWith({
      url: "https://oauth2.googleapis.com/token",
      data: {
        code: "auth-code",
        client_id: "google-client-id",
        client_secret: "google-client-secret",
        redirect_uri: "http://orch.example.com/api/auth/google/callback",
        grant_type: "authorization_code",
      },
    });
    expect(httpClient.get).toHaveBeenCalledWith({
      url: "https://www.googleapis.com/oauth2/v2/userinfo",
      headers: { Authorization: "Bearer google-access-token" },
    });
    expect(jwt.issueToken).toHaveBeenCalledWith({
      email: "oauth@example.com",
      name: "OAuth User",
      picture: "https://example.com/oauth.png",
    });
    const cookies = setCookieHeaders(response);
    expect(cookies.some((header) => header.startsWith(`${AUTH_COOKIE_NAME}=jwt:oauth@example.com:`))).toBe(true);
    expect(cookies.find((header) => header.startsWith(`${AUTH_COOKIE_NAME}=jwt:oauth@example.com:`))).toContain("Path=/");
    expect(cookies.some((header) => header.startsWith(`${OAUTH_STATE_COOKIE_NAME}=;`))).toBe(true);
    expect(cookies.find((header) => header.startsWith(`${OAUTH_STATE_COOKIE_NAME}=;`))).toContain("Path=/");
    expect(cookies.some((header) => header.startsWith(`${RETURN_TO_COOKIE_NAME}=;`))).toBe(true);
    expect(cookies.find((header) => header.startsWith(`${RETURN_TO_COOKIE_NAME}=;`))).toContain("Path=/");

    await app.close();
  });

  it("returns auth status from injected JWT verifier and keeps disabled auth permissive", async () => {
    const jwt = createJwtHelper();
    const app = createApp({
      config,
      authRoutes: createAuthRouteOptions({
        jwt,
        userPayloadExtra: (payload) => ({ dashboardAccess: payload.dashboardAccess }),
      }),
    });

    expect((await app.inject({ method: "GET", url: "/api/auth/status" })).json()).toEqual({
      authenticated: false,
      user: null,
    });
    expect((await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie: `${AUTH_COOKIE_NAME}=valid-jwt` },
    })).json()).toEqual({
      authenticated: true,
      user: {
        email: "user@example.com",
        name: "User",
        picture: "https://example.com/pic.png",
        dashboardAccess: { restricted: true },
      },
    });
    await app.close();

    const disabled = createApp({
      config,
      authRoutes: createAuthRouteOptions({
        configProvider: {
          getConfig: vi.fn(async () => ({ ...enabledConfig, authEnabled: false })),
        },
      }),
    });
    expect((await disabled.inject({ method: "GET", url: "/api/auth/status" })).json()).toEqual({
      authenticated: true,
      user: null,
    });
    await disabled.close();
  });

  it("logs out by deleting auth cookie", async () => {
    const app = createApp({ config, authRoutes: createAuthRouteOptions() });

    const response = await app.inject({ method: "POST", url: "/api/auth/logout" });

    expect(response.json()).toEqual({ success: true });
    const cookies = setCookieHeaders(response);
    expect(cookies.some((header) => header.startsWith(`${AUTH_COOKIE_NAME}=;`))).toBe(true);
    expect(cookies.find((header) => header.startsWith(`${AUTH_COOKIE_NAME}=;`))).toContain("Path=/");

    await app.close();
  });

  it("keeps dev-login gates, defaults, authorization, and auth cookie wire", async () => {
    const jwt = createJwtHelper();
    const app = createApp({
      config,
      authRoutes: createAuthRouteOptions({ jwt }),
    });

    const missingEmail = await app.inject({
      method: "POST",
      url: "/api/auth/dev-login",
      payload: {},
    });
    expect(missingEmail.statusCode).toBe(400);
    expect(missingEmail.json()).toEqual({ detail: "Email is required" });

    const success = await app.inject({
      method: "POST",
      url: "/api/auth/dev-login",
      payload: { email: "dev user@example.com" },
    });
    const picture = "https://api.dicebear.com/7.x/identicon/svg?seed=dev%20user%40example.com";
    expect(success.json()).toEqual({ success: true });
    expect(jwt.issueToken).toHaveBeenCalledWith({
      email: "dev user@example.com",
      name: "Developer",
      picture,
    });
    const successCookies = setCookieHeaders(success);
    expect(successCookies.some((header) => header.startsWith(`${AUTH_COOKIE_NAME}=jwt:dev%20user%40example.com:`))).toBe(false);
    expect(successCookies.some((header) => header.startsWith(`${AUTH_COOKIE_NAME}=jwt:dev user@example.com:`))).toBe(true);
    expect(successCookies.find((header) => header.startsWith(`${AUTH_COOKIE_NAME}=jwt:dev user@example.com:`))).toContain("Path=/");

    await app.close();

    const unavailable = createApp({
      config,
      authRoutes: createAuthRouteOptions({
        configProvider: {
          getConfig: vi.fn(async () => ({
            ...enabledConfig,
            devModeEnabled: false,
          })),
        },
      }),
    });
    const unavailableResponse = await unavailable.inject({
      method: "POST",
      url: "/api/auth/dev-login",
      payload: { email: "dev@example.com" },
    });
    expect(unavailableResponse.statusCode).toBe(403);
    expect(unavailableResponse.json()).toEqual({ detail: "Dev login not available" });
    await unavailable.close();

    const noSecret = createApp({
      config,
      authRoutes: createAuthRouteOptions({
        configProvider: {
          getConfig: vi.fn(async () => ({
            ...enabledConfig,
            jwtSecretConfigured: false,
          })),
        },
      }),
    });
    const noSecretResponse = await noSecret.inject({
      method: "POST",
      url: "/api/auth/dev-login",
      payload: { email: "dev@example.com" },
    });
    expect(noSecretResponse.statusCode).toBe(500);
    expect(noSecretResponse.json()).toEqual({ detail: "JWT_SECRET not configured" });
    await noSecret.close();
  });

  it("does not let static auth routes match the wrong Google handler", async () => {
    const app = createApp({ config, authRoutes: createAuthRouteOptions() });

    const native = await app.inject({
      method: "POST",
      url: "/api/auth/google/native",
      payload: { id_token: "google-id-token" },
    });
    const callback = await app.inject({
      method: "GET",
      url: "/api/auth/google/callback?code=c&state=bad",
    });
    const google = await app.inject({ method: "GET", url: "/api/auth/google" });

    expect(native.statusCode).toBe(200);
    expect(callback.headers.location).toBe("/?error=auth_failed");
    expect(String(google.headers.location)).toContain("https://accounts.google.com");

    await app.close();
  });
});
