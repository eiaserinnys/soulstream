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

  it("falls back to the dashboard JWT cookie verifier", async () => {
    const verifyDashboardToken = vi.fn().mockResolvedValue({ sub: "user-1" });

    await expect(authenticateBoardYjsConnection({
      token: "cookie",
      requestHeaders: {
        cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=signed-dashboard-token`,
      },
      config: productionAuth({
        dashboardAuthEnabled: true,
        verifyDashboardToken,
      }),
    })).resolves.toEqual({ source: "cookie", subject: "user-1" });
    expect(verifyDashboardToken).toHaveBeenCalledWith("signed-dashboard-token");
  });

  it("allows the explicit development bypass when dashboard auth is disabled", async () => {
    await expect(authenticateBoardYjsConnection({
      token: null,
      requestHeaders: {},
      config: {
        authBearerToken: "",
        environment: "development",
        dashboardAuthEnabled: false,
        verifyDashboardToken: vi.fn(),
      },
    })).resolves.toEqual({ source: "development", subject: "development" });
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
    verifyDashboardToken: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}
