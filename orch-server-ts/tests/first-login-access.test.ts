import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  createLiveAuthenticatedUserResolvers,
  type AuthJwtHelper,
  type LiveConfigProviderBoundary,
} from "../src/index.js";
import {
  createLocalOwnerEnsurer,
  warnWhenProductionHasNoLogin,
} from "../src/auth/first_login_access.js";
import { config, createAuthRouteOptions } from "./auth-route-test-helpers.js";

const noLoginSnapshot = {
  google_client_id: "",
  dashboard_admin_password: "",
  tailscale_auth_enabled: false,
  auth_bearer_token: "",
};

function configWith(snapshot: Record<string, unknown>): LiveConfigProviderBoundary {
  return { getConfig: async () => snapshot } as unknown as LiveConfigProviderBoundary;
}

function requestWith(headers: Record<string, string> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

const jwt: AuthJwtHelper = {
  issueToken: async () => "token",
  verifyToken: async () => null,
};

function createResolvers(snapshot: Record<string, unknown>) {
  const ensureLocalOwner = vi.fn(async () => undefined);
  const resolvers = createLiveAuthenticatedUserResolvers({
    jwt,
    configProvider: configWith(snapshot),
    ensureLocalOwner,
  });
  return { resolvers, ensureLocalOwner };
}

describe("development default user without a login", () => {
  it("resolves a tokenless request as owner@local and guarantees the users row", async () => {
    const { resolvers, ensureLocalOwner } = createResolvers({
      ...noLoginSnapshot,
      environment: "development",
    });

    await expect(resolvers.resolveUser(requestWith())).resolves.toEqual({
      email: "owner@local",
      name: "Owner",
      picture: "",
    });
    await expect(resolvers.resolveEmail(requestWith())).resolves.toBe("owner@local");
    expect(ensureLocalOwner).toHaveBeenCalledTimes(1);
  });

  it("also applies to the dev environment name", async () => {
    const { resolvers } = createResolvers({ ...noLoginSnapshot, environment: "dev" });
    await expect(resolvers.resolveEmail(requestWith())).resolves.toBe("owner@local");
  });

  it("does not resolve a user in production without a login", async () => {
    const { resolvers, ensureLocalOwner } = createResolvers({
      ...noLoginSnapshot,
      environment: "production",
    });

    await expect(resolvers.resolveUser(requestWith())).resolves.toBeNull();
    expect(ensureLocalOwner).not.toHaveBeenCalled();
  });

  it("does not resolve a user when a login mode is configured", async () => {
    const { resolvers, ensureLocalOwner } = createResolvers({
      ...noLoginSnapshot,
      environment: "development",
      dashboard_admin_password: "hunter2",
    });

    await expect(resolvers.resolveUser(requestWith())).resolves.toBeNull();
    expect(ensureLocalOwner).not.toHaveBeenCalled();
  });

  it("does not resolve a user when a service token is configured or presented", async () => {
    const configured = createResolvers({
      ...noLoginSnapshot,
      environment: "development",
      auth_bearer_token: "service-token",
    });
    await expect(configured.resolvers.resolveUser(requestWith())).resolves.toBeNull();

    const presented = createResolvers({ ...noLoginSnapshot, environment: "development" });
    await expect(
      presented.resolvers.resolveUser(requestWith({ authorization: "Bearer anything" })),
    ).resolves.toBeNull();
  });

  it("reports the default user from /api/auth/status only in development", async () => {
    for (const [environment, expected] of [
      ["development", { authenticated: true, user: { email: "owner@local", name: "Owner", picture: "" } }],
      ["production", { authenticated: true, user: null }],
    ] as const) {
      const { resolvers } = createResolvers({ ...noLoginSnapshot, environment });
      const app = createApp({
        config,
        authRoutes: createAuthRouteOptions({
          configProvider: {
            getConfig: async () => ({
              loginMode: "none",
              devModeEnabled: environment === "development",
              dashboardAdminPasswordSha256: "",
              googleClientId: "",
              googleClientSecret: "",
              callbackUrl: "",
              jwtSecretConfigured: false,
            }),
          },
          resolveNoLoginUser: resolvers.resolveUser,
        }),
      });
      const response = await app.inject({ method: "GET", url: "/api/auth/status" });
      expect(response.json()).toEqual(expected);
      await app.close();
    }
  });
});

describe("local owner row", () => {
  it("inserts owner@local as admin without touching an existing row", async () => {
    const statements: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      statements.push(strings.join("?").replace(/\s+/g, " ").trim());
      return [];
    }) as never;
    await createLocalOwnerEnsurer({ resolveSql: async () => sql })();

    expect(statements).toEqual([
      "INSERT INTO users (email, display_name, is_admin) VALUES ('owner@local', 'Owner', TRUE) ON CONFLICT (email) DO NOTHING",
    ]);
  });
});

describe("startup warning for a deployment without a login", () => {
  const base = {
    google_client_id: "",
    dashboard_admin_password: "",
    tailscale_auth_enabled: false,
  };

  it("warns once in production without a login mode", () => {
    const warn = vi.fn();
    warnWhenProductionHasNoLogin({ ...base, environment: "production" }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("DASHBOARD_ADMIN_PASSWORD");
  });

  it("stays quiet in development and when a login mode exists", () => {
    const warn = vi.fn();
    warnWhenProductionHasNoLogin({ ...base, environment: "development" }, warn);
    warnWhenProductionHasNoLogin({ ...base, environment: "production", dashboard_admin_password: "x" }, warn);
    warnWhenProductionHasNoLogin({ ...base, environment: "production", google_client_id: "id" }, warn);
    warnWhenProductionHasNoLogin({ ...base, environment: "production", tailscale_auth_enabled: true }, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
