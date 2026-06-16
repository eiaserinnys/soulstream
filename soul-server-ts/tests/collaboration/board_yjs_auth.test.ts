import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DASHBOARD_AUTH_COOKIE_NAME,
  authenticateBoardYjsConnection,
  authenticateDashboardHttpRequest,
} from "../../src/collaboration/board_yjs_auth.js";

describe("board_yjs_auth", () => {
  it("AUTH_BEARER_TOKEN과 일치하는 token은 허용", async () => {
    await expect(authenticateBoardYjsConnection({
      token: "secret",
      requestHeaders: {},
      config: {
        authBearerToken: "secret",
        environment: "production",
        dashboardAuthEnabled: false,
      },
    })).resolves.toEqual({ source: "bearer", subject: "bearer" });
  });

  it("dashboard auth가 켜져 있으면 쿠키 JWT를 검증", async () => {
    const token = signJwt({ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 60 }, "jwt-secret");

    await expect(authenticateBoardYjsConnection({
      token: "cookie",
      requestHeaders: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
      },
      config: {
        authBearerToken: "",
        environment: "production",
        dashboardAuthEnabled: true,
        jwtSecret: "jwt-secret",
      },
    })).resolves.toEqual({ source: "cookie", subject: "user-1" });
  });

  it("운영에서 인증 정보가 없으면 차단", async () => {
    await expect(authenticateBoardYjsConnection({
      token: null,
      requestHeaders: {},
      config: {
        authBearerToken: "",
        environment: "production",
        dashboardAuthEnabled: false,
      },
    })).rejects.toThrow(/authentication is not configured/);
  });

  it("잘못된 쿠키 서명은 차단", async () => {
    const token = signJwt({ sub: "user-1" }, "jwt-secret");

    await expect(authenticateBoardYjsConnection({
      token: "cookie",
      requestHeaders: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${token}`,
      },
      config: {
        authBearerToken: "",
        environment: "production",
        dashboardAuthEnabled: true,
        jwtSecret: "different",
      },
    })).rejects.toThrow(/signature/);
  });

  it("dashboard auth가 켜졌는데 JWT_SECRET이 없으면 명확히 차단", async () => {
    const token = signJwt({ sub: "user-1" }, "jwt-secret");

    await expect(authenticateBoardYjsConnection({
      token: "cookie",
      requestHeaders: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${token}`,
      },
      config: {
        authBearerToken: "",
        environment: "production",
        dashboardAuthEnabled: true,
      },
    })).rejects.toThrow(/JWT_SECRET is required/);
  });

  it("dashboard HTTP auth도 쿠키 JWT subject를 인증 사용자로 반환", async () => {
    const token = signJwt(
      { sub: "operator@example.com", exp: Math.floor(Date.now() / 1000) + 60 },
      "jwt-secret",
    );

    await expect(authenticateDashboardHttpRequest({
      requestHeaders: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
      },
      config: {
        authBearerToken: "",
        environment: "production",
        dashboardAuthEnabled: true,
        jwtSecret: "jwt-secret",
      },
    })).resolves.toEqual({ source: "cookie", subject: "operator@example.com" });
  });
});

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${header}.${body}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${body}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
