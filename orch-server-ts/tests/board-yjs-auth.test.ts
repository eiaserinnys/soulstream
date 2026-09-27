import { describe, expect, it, vi } from "vitest";

import {
  DASHBOARD_AUTH_COOKIE_NAME,
  authenticateBoardYjsConnection,
} from "../src/board-yjs/board_yjs_auth.js";

describe("orch board Yjs websocket auth", () => {
  it("accepts the configured service bearer token", async () => {
    await expect(authenticateBoardYjsConnection({
      token: "service-token",
      requestHeaders: {},
      config: productionAuth({ authBearerToken: "service-token" }),
    })).resolves.toEqual({ source: "bearer", subject: "bearer" });
  });

  it("reuses the dashboard user resolver for cookie authentication", async () => {
    const resolveDashboardUserFromHeaders = vi.fn().mockResolvedValue({
      payload: { sub: "user-1" },
      carrier: "cookie",
    });

    await expect(authenticateBoardYjsConnection({
      token: "cookie",
      requestHeaders: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=signed-dashboard-token`,
      },
      config: productionAuth({
        dashboardAuthEnabled: true,
        resolveDashboardUserFromHeaders,
      }),
    })).resolves.toEqual({ source: "cookie", subject: "user-1" });
    expect(resolveDashboardUserFromHeaders).toHaveBeenCalledWith({
      cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=signed-dashboard-token`,
    });
  });

  it("accepts a dashboard JWT bearer through the shared user resolver", async () => {
    const resolveDashboardUserFromHeaders = vi.fn().mockResolvedValue({
      payload: { email: "user@example.com" },
      carrier: "bearer",
    });

    await expect(authenticateBoardYjsConnection({
      token: null,
      requestHeaders: { authorization: "Bearer dashboard-jwt" },
      config: productionAuth({
        dashboardAuthEnabled: true,
        resolveDashboardUserFromHeaders,
      }),
    })).resolves.toEqual({ source: "bearer", subject: "user@example.com" });
    expect(resolveDashboardUserFromHeaders).toHaveBeenCalledWith({
      authorization: "Bearer dashboard-jwt",
    });
  });

  it("allows the explicit development bypass when dashboard auth is disabled", async () => {
    await expect(authenticateBoardYjsConnection({
      token: null,
      requestHeaders: {},
      config: {
        authBearerToken: "",
        environment: "development",
        dashboardAuthEnabled: false,
        resolveDashboardUserFromHeaders: vi.fn().mockResolvedValue(null),
      },
    })).resolves.toEqual({ source: "development", subject: "development" });
  });

  it("rejects an invalid configured service token in development", async () => {
    await expect(authenticateBoardYjsConnection({
      token: "wrong-token",
      requestHeaders: {},
      config: {
        authBearerToken: "service-token",
        environment: "development",
        dashboardAuthEnabled: false,
        resolveDashboardUserFromHeaders: vi.fn().mockResolvedValue(null),
      },
    })).rejects.toThrow(/invalid board workspace websocket bearer token/);
  });

  it("rejects production connections without a usable auth path", async () => {
    await expect(authenticateBoardYjsConnection({
      token: null,
      requestHeaders: {},
      config: productionAuth(),
    })).rejects.toThrow(/authentication is not configured/);
  });
});

function productionAuth(
  overrides: Partial<Parameters<typeof authenticateBoardYjsConnection>[0]["config"]> = {},
) {
  return {
    authBearerToken: "",
    environment: "production",
    dashboardAuthEnabled: false,
    resolveDashboardUserFromHeaders: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}
