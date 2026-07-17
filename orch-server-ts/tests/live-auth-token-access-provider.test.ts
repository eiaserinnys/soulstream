import { describe, expect, it, vi } from "vitest";

import {
  createLiveAuthTokenResolver,
  type AuthJwtHelper,
  type LiveConfigProviderBoundary,
} from "../src/index.js";

describe("live auth token access resolver", () => {
  it("accepts configured service Bearer before trying dashboard JWT", async () => {
    const jwt = jwtVerifier();
    const resolver = createLiveAuthTokenResolver({
      configProvider: configWith({
        auth_bearer_token: "service-token",
        environment: "production",
        google_client_id: "google-client",
        jwt_secret: "jwt-secret",
      }),
      jwt,
    });

    await expect(
      resolver(request({ authorization: "Bearer service-token" })),
    ).resolves.toEqual({ ok: true });
    expect(jwt.verifyToken).not.toHaveBeenCalled();
  });

  it("preserves Python bearer config error and dev bypass semantics", async () => {
    const production = createLiveAuthTokenResolver({
      configProvider: configWith({
        auth_bearer_token: "",
        environment: "production",
        google_client_id: "google-client",
        jwt_secret: "jwt-secret",
      }),
      jwt: jwtVerifier(),
    });
    const development = createLiveAuthTokenResolver({
      configProvider: configWith({
        auth_bearer_token: "",
        environment: "development",
        google_client_id: "google-client",
        jwt_secret: "jwt-secret",
      }),
      jwt: jwtVerifier(),
    });

    await expect(production(request({}))).resolves.toMatchObject({
      ok: false,
      statusCode: 500,
    });
    await expect(development(request({}))).resolves.toEqual({ ok: true });
  });

  it("falls back to dashboard JWT cookie or Bearer only when auth is enabled", async () => {
    const jwt = jwtVerifier("dashboard-jwt");
    const resolver = createLiveAuthTokenResolver({
      configProvider: configWith({
        auth_bearer_token: "service-token",
        environment: "production",
        google_client_id: "google-client",
        jwt_secret: "jwt-secret",
      }),
      jwt,
    });

    await expect(
      resolver(request({ cookie: "soul_dashboard_auth=dashboard-jwt" })),
    ).resolves.toEqual({ ok: true });
    await expect(
      resolver(request({ authorization: "Bearer dashboard-jwt" })),
    ).resolves.toEqual({ ok: true });
    expect(jwt.verifyToken).toHaveBeenCalledTimes(2);
  });

  it("reuses the canonical dashboard user resolver when one is supplied", async () => {
    const jwt = jwtVerifier();
    const resolveDashboardUser = vi.fn(async () => ({
      email: "user@example.com",
    }));
    const resolver = createLiveAuthTokenResolver({
      configProvider: configWith({
        auth_bearer_token: "service-token",
        environment: "production",
        google_client_id: "google-client",
        jwt_secret: "jwt-secret",
      }),
      jwt,
      resolveDashboardUser,
    });
    const dashboardRequest = request({
      cookie: "soul_dashboard_auth=dashboard-jwt",
    });

    await expect(resolver(dashboardRequest)).resolves.toEqual({ ok: true });
    expect(resolveDashboardUser).toHaveBeenCalledWith(dashboardRequest);
    expect(jwt.verifyToken).not.toHaveBeenCalled();
  });

  it("keeps Python verify_auth JWT fallback when production service Bearer is not configured", async () => {
    const jwt = jwtVerifier("dashboard-jwt");
    const resolver = createLiveAuthTokenResolver({
      configProvider: configWith({
        auth_bearer_token: "",
        environment: "production",
        google_client_id: "google-client",
        jwt_secret: "jwt-secret",
      }),
      jwt,
    });

    await expect(
      resolver(request({ cookie: "soul_dashboard_auth=dashboard-jwt" })),
    ).resolves.toEqual({ ok: true });
    await expect(resolver(request({}))).resolves.toMatchObject({
      ok: false,
      statusCode: 500,
    });
    expect(jwt.verifyToken).toHaveBeenCalledTimes(1);
  });

  it("does not turn auth-disabled JWT dependency into a bypass", async () => {
    const jwt = jwtVerifier("dashboard-jwt");
    const resolver = createLiveAuthTokenResolver({
      configProvider: configWith({
        auth_bearer_token: "service-token",
        environment: "production",
        google_client_id: "",
        jwt_secret: "jwt-secret",
      }),
      jwt,
    });

    await expect(
      resolver(request({ authorization: "Bearer dashboard-jwt" })),
    ).resolves.toMatchObject({ ok: false, statusCode: 401 });
    expect(jwt.verifyToken).not.toHaveBeenCalled();
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

function jwtVerifier(validToken?: string): AuthJwtHelper {
  return {
    issueToken: vi.fn(async () => "jwt"),
    verifyToken: vi.fn(async (token) =>
      token === validToken ? { email: "user@example.com" } : null
    ),
  };
}

function request(headers: Record<string, string>) {
  return { headers } as never;
}
