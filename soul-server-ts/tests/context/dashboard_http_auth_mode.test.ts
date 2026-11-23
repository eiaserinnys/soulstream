import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DASHBOARD_AUTH_COOKIE_NAME,
  authenticateDashboardHttpRequest,
  resolveDashboardAuthEnabled,
} from "../../src/context/dashboard_http_auth.js";

describe("resolveDashboardAuthEnabled", () => {
  it("GOOGLE_CLIENT_ID만 있으면 켠다", () => {
    expect(resolveDashboardAuthEnabled({
      ENVIRONMENT: "production",
      GOOGLE_CLIENT_ID: "google-client",
    })).toBe(true);
  });

  it("production에서 JWT_SECRET만 있으면 켠다", () => {
    expect(resolveDashboardAuthEnabled({
      ENVIRONMENT: "production",
      JWT_SECRET: "jwt-secret",
    })).toBe(true);
  });

  it("development에서 JWT_SECRET만 있으면 끈다", () => {
    expect(resolveDashboardAuthEnabled({
      ENVIRONMENT: "development",
      JWT_SECRET: "jwt-secret",
    })).toBe(false);
  });

  it("둘 다 없으면 끈다", () => {
    expect(resolveDashboardAuthEnabled({ ENVIRONMENT: "production" })).toBe(false);
  });
});

describe("production에서 JWT_SECRET만 있는 대시보드 HTTP 인증", () => {
  const config = {
    authBearerToken: "service-token",
    environment: "production" as const,
    dashboardAuthEnabled: resolveDashboardAuthEnabled({
      ENVIRONMENT: "production",
      JWT_SECRET: "jwt-secret",
    }),
    jwtSecret: "jwt-secret",
  };

  it("같은 비밀로 서명한 쿠키를 cookie로 통과시킨다", async () => {
    const token = signJwt(
      { sub: "owner@example.com", exp: Math.floor(Date.now() / 1000) + 60 },
      "jwt-secret",
    );
    await expect(authenticateDashboardHttpRequest({
      requestHeaders: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
      },
      config,
    })).resolves.toEqual({ source: "cookie", subject: "owner@example.com" });
  });

  it("다른 비밀로 서명한 쿠키를 거부한다", async () => {
    const token = signJwt(
      { sub: "owner@example.com", exp: Math.floor(Date.now() / 1000) + 60 },
      "other-secret",
    );
    await expect(authenticateDashboardHttpRequest({
      requestHeaders: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
      },
      config,
    })).rejects.toThrow(/invalid dashboard auth cookie signature/);
  });

  it("쿠키 없이 맞는 bearer를 통과시킨다", async () => {
    await expect(authenticateDashboardHttpRequest({
      requestHeaders: { authorization: "Bearer service-token" },
      config,
    })).resolves.toEqual({ source: "bearer", subject: "bearer" });
  });
});

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
