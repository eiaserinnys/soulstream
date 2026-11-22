import { describe, expect, it, vi } from "vitest";

import {
  DASHBOARD_AUTH_COOKIE_NAME,
  authenticateSocketConnection,
} from "../src/auth/socket_auth.js";
import { createLiveAuthenticatedUserResolvers } from "../src/runtime/live_authenticated_user_resolver.js";

describe("orch socket auth", () => {
  it("authenticates a Serve identity and retains node bearer precedence", async () => {
    const values = { google_client_id: "", tailscale_auth_enabled: true, tailscale_allowed_login: "owner@example.com" };
    const resolver = createLiveAuthenticatedUserResolvers({
      jwt: { issueToken: async () => "", verifyToken: async () => null },
      configProvider: { getConfig: () => values, requireConfig: async (key) => values[key as keyof typeof values] },
    });
    const config = productionAuth({ authBearerToken: "service-token", dashboardAuthEnabled: true, resolveDashboardUserFromHeaders: resolver.resolveUserFromHeaders });
    await expect(authenticateSocketConnection({ requestHeaders: { "tailscale-user-login": "OWNER@example.com" }, config })).resolves.toEqual({ source: "tailscale", subject: "owner@example.com" });
    for (const requestHeaders of [{}, { "tailscale-user-login": "other" }, { "tailscale-user-login": "owner@example.com", "tailscale-funnel-request": "?1" }]) {
      await expect(authenticateSocketConnection({ requestHeaders, config })).rejects.toThrow();
    }
    await expect(authenticateSocketConnection({ token: "service-token", requestHeaders: {}, config })).resolves.toEqual({ source: "bearer", subject: "bearer" });
  });
  it("accepts the configured service bearer token", async () => {
    await expect(authenticateSocketConnection({
      token: "service-token",
      requestHeaders: {},
      config: productionAuth({ authBearerToken: "service-token" }),
    })).resolves.toEqual({ source: "bearer", subject: "bearer" });
  });

  it("returns the node principal for a node pairing token", async () => {
    const principal = {
      credential_id: "credential-1",
      node_id: "node-1",
      company_pc: false,
    };
    await expect(authenticateSocketConnection({
      token: "node-token",
      requestHeaders: {},
      config: productionAuth({
        authBearerToken: "service-token",
        nodeCredentials: {
          resolve: (token: string) => (token === "node-token" ? principal : null),
          onRevoked: () => () => {},
        },
      }),
    })).resolves.toEqual({ source: "bearer", subject: "bearer", principal });
  });

  it("reuses the dashboard user resolver for cookie authentication", async () => {
    const resolveDashboardUserFromHeaders = vi.fn().mockResolvedValue({
      payload: { sub: "user-1" },
      carrier: "cookie",
    });

    await expect(authenticateSocketConnection({
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

    await expect(authenticateSocketConnection({
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
    await expect(authenticateSocketConnection({
      token: null,
      requestHeaders: {},
      config: {
        authBearerToken: "",
        nodeCredentials: null,
        environment: "development",
        dashboardAuthEnabled: false,
        resolveDashboardUserFromHeaders: vi.fn().mockResolvedValue(null),
      },
    })).resolves.toEqual({ source: "development", subject: "development" });
  });

  it("rejects an invalid configured service token in development", async () => {
    await expect(authenticateSocketConnection({
      token: "wrong-token",
      requestHeaders: {},
      config: {
        authBearerToken: "service-token",
        nodeCredentials: null,
        environment: "development",
        dashboardAuthEnabled: false,
        resolveDashboardUserFromHeaders: vi.fn().mockResolvedValue(null),
      },
    })).rejects.toThrow(/invalid board workspace websocket bearer token/);
  });

  it("requires the password-mode dashboard cookie on page sockets", async () => {
    const withCookie = vi.fn().mockResolvedValue({
      payload: { email: "owner@local" },
      carrier: "cookie",
    });

    await expect(authenticateSocketConnection({
      token: null,
      requestHeaders: {},
      config: productionAuth({
        dashboardAuthEnabled: true,
        resolveDashboardUserFromHeaders: vi.fn().mockResolvedValue(null),
      }),
    })).rejects.toThrow(/missing dashboard authentication credentials/);

    await expect(authenticateSocketConnection({
      token: "cookie-token",
      requestHeaders: { cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=signed-dashboard-token` },
      config: productionAuth({
        dashboardAuthEnabled: true,
        resolveDashboardUserFromHeaders: withCookie,
      }),
    })).resolves.toEqual({ source: "cookie", subject: "owner@local" });
  });

  it("rejects production connections without a usable auth path", async () => {
    await expect(authenticateSocketConnection({
      token: null,
      requestHeaders: {},
      config: productionAuth(),
    })).rejects.toThrow(/authentication is not configured/);
  });
});

function productionAuth(
  overrides: Partial<Parameters<typeof authenticateSocketConnection>[0]["config"]> = {},
) {
  return {
    authBearerToken: "",
    nodeCredentials: null,
    environment: "production",
    dashboardAuthEnabled: false,
    resolveDashboardUserFromHeaders: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}
