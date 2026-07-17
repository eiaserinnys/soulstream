import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  AUTH_COOKIE_NAME,
  DashboardAccessError,
  createLiveDashboardAccessProvider,
  createPostgresDashboardUserRepository,
  type AuthJwtHelper,
  type DashboardUserRecord,
  type DashboardUserRepository,
  type LiveConfigProviderBoundary,
} from "../src/index.js";

describe("live dashboard DB access provider", () => {
  it("resolves DB users table policy for admin, unrestricted, restricted, and unknown users", async () => {
    const { provider, repository } = createProviderHarness();

    await expect(provider.resolveAccess(cookieRequest("admin-token"))).resolves.toEqual({
      restricted: false,
      allowedFolderIds: [],
    });
    await expect(provider.resolveAccess(cookieRequest("unrestricted-token"))).resolves.toEqual({
      restricted: false,
      allowedFolderIds: [],
    });
    await expect(provider.resolveAccess(cookieRequest("restricted-token"))).resolves.toEqual({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });
    await expect(provider.resolveAccess(cookieRequest("unknown-token"))).resolves.toEqual({
      restricted: true,
      allowedFolderIds: [],
    });
    expect(repository.findUserByEmail).toHaveBeenNthCalledWith(1, "admin@example.com");
  });

  it("keeps service token requests unrestricted unless access_email is supplied", async () => {
    const { provider, repository } = createProviderHarness();

    await expect(
      provider.resolveAccess(requestWith({
        authorization: "Bearer service-token",
      })),
    ).resolves.toEqual({ restricted: false, allowedFolderIds: [] });
    expect(repository.findUserByEmail).not.toHaveBeenCalled();

    await expect(
      provider.resolveAccess(requestWith({
        authorization: "Bearer service-token",
        query: { access_email: " Restricted@Example.COM " },
      })),
    ).resolves.toEqual({ restricted: true, allowedFolderIds: ["folder-a"] });
    expect(repository.findUserByEmail).toHaveBeenCalledWith("restricted@example.com");
  });

  it("lets dashboard cookies win over service token access_email overrides", async () => {
    const { provider, repository } = createProviderHarness();

    await expect(
      provider.resolveAccess(
        requestWith({
          authorization: "Bearer service-token",
          cookie: `${AUTH_COOKIE_NAME}=restricted-token`,
        }),
        { accessEmail: "admin@example.com" },
      ),
    ).resolves.toEqual({ restricted: true, allowedFolderIds: ["folder-a"] });
    expect(repository.findUserByEmail).toHaveBeenCalledWith("restricted@example.com");
    expect(repository.findUserByEmail).not.toHaveBeenCalledWith("admin@example.com");
  });

  it("reuses a shared request-scoped dashboard token verifier", async () => {
    const { repository } = createProviderHarness();
    const jwt: AuthJwtHelper = {
      issueToken: vi.fn(async () => "token"),
      verifyToken: vi.fn(async () => null),
    };
    const verifyDashboardToken = vi.fn(async (_request, token: string) =>
      token === "restricted-token"
        ? { email: "restricted@example.com" }
        : null
    );
    const provider = createLiveDashboardAccessProvider({
      configProvider: configWith({
        auth_bearer_token: "service-token",
        google_client_id: "google-client",
        environment: "production",
      }),
      jwt,
      repository,
      verifyDashboardToken,
    });
    const request = cookieRequest("restricted-token");

    await expect(provider.resolveAccess(request)).resolves.toEqual({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });
    expect(verifyDashboardToken).toHaveBeenCalledWith(
      request,
      "restricted-token",
    );
    expect(jwt.verifyToken).not.toHaveBeenCalled();
  });

  it("denies missing or invalid dashboard JWT requests before resolving user access", async () => {
    const { provider, repository } = createProviderHarness();

    for (const request of [
      requestWith(),
      cookieRequest("invalid-token"),
    ]) {
      await expect(provider.resolveAccess(request)).rejects.toMatchObject({
        statusCode: 401,
      });
    }
    expect(repository.findUserByEmail).not.toHaveBeenCalled();
  });

  it("builds Python-compatible auth status payload extras from the DB user row", async () => {
    const { provider } = createProviderHarness();

    await expect(provider.isAdminEmail(" ADMIN@example.com ")).resolves.toBe(true);
    await expect(provider.isAdminEmail("missing@example.com")).resolves.toBe(false);

    await expect(provider.userPayloadExtra({ email: "ADMIN@example.com" })).resolves.toEqual({
      isAdmin: true,
      dashboardAccess: { restricted: false, allowedFolderIds: [] },
    });
    await expect(provider.userPayloadExtra({ email: "restricted@example.com" })).resolves.toEqual({
      isAdmin: false,
      dashboardAccess: { restricted: true, allowedFolderIds: ["folder-a"] },
    });
    await expect(provider.userPayloadExtra({ email: "missing@example.com" })).resolves.toEqual({
      isAdmin: false,
      dashboardAccess: { restricted: true, allowedFolderIds: [] },
    });
  });

  it("queries the Postgres users table through an injectable sql boundary", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values });
      return [{
        email: "restricted@example.com",
        is_admin: false,
        allowed_folder_ids: ["folder-a"],
      }];
    });
    const repository = createPostgresDashboardUserRepository({ sql });

    await expect(repository.findUserByEmail(" Restricted@Example.COM ")).resolves.toEqual({
      email: "restricted@example.com",
      isAdmin: false,
      allowedFolderIds: ["folder-a"],
    });
    expect(calls[0]?.text).toContain("FROM users");
    expect(calls[0]?.values).toEqual(["restricted@example.com"]);
  });

  it("owns and closes a postgres client created from databaseUrl", async () => {
    const end = vi.fn(async () => undefined);
    const sql = Object.assign(
      vi.fn(async () => []),
      { end },
    );
    const postgresFactory = vi.fn(() => sql);
    const repository = createPostgresDashboardUserRepository({
      databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
      postgresFactory,
    });

    await expect(repository.findUserByEmail("missing@example.com")).resolves.toBeNull();
    await repository.close();
    expect(postgresFactory).toHaveBeenCalledWith(
      "postgres://soulstream_test@localhost/soulstream_test",
      { max: 5 },
    );
    expect(end).toHaveBeenCalledWith({ timeout: 5 });
  });
});

function createProviderHarness() {
  const users = new Map<string, DashboardUserRecord>([
    ["admin@example.com", {
      email: "admin@example.com",
      isAdmin: true,
      allowedFolderIds: ["folder-secret"],
    }],
    ["unrestricted@example.com", {
      email: "unrestricted@example.com",
      isAdmin: false,
      allowedFolderIds: [],
    }],
    ["restricted@example.com", {
      email: "restricted@example.com",
      isAdmin: false,
      allowedFolderIds: ["folder-a"],
    }],
  ]);
  const repository: DashboardUserRepository = {
    findUserByEmail: vi.fn(async (email) => users.get(email) ?? null),
  };
  const jwt: AuthJwtHelper = {
    issueToken: vi.fn(async () => "token"),
    verifyToken: vi.fn(async (token) => {
      if (token === "admin-token") return { email: " Admin@Example.COM " };
      if (token === "unrestricted-token") return { email: "unrestricted@example.com" };
      if (token === "restricted-token") return { email: "restricted@example.com" };
      if (token === "unknown-token") return { email: "unknown@example.com" };
      return null;
    }),
  };
  const provider = createLiveDashboardAccessProvider({
    configProvider: configWith({
      auth_bearer_token: "service-token",
      google_client_id: "google-client",
      environment: "production",
    }),
    jwt,
    repository,
  });
  return { provider, repository, jwt };
}

function configWith(values: Record<string, unknown>): LiveConfigProviderBoundary {
  return {
    getConfig: vi.fn(async () => values),
    requireConfig: vi.fn(async (key: string) => {
      if (!(key in values)) throw new Error(`${key} is required`);
      return values[key];
    }),
  };
}

function cookieRequest(token: string): FastifyRequest {
  return requestWith({ cookie: `${AUTH_COOKIE_NAME}=${token}` });
}

function requestWith(input: {
  authorization?: string;
  cookie?: string;
  query?: Record<string, unknown>;
  body?: unknown;
} = {}): FastifyRequest {
  return {
    headers: {
      ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
      ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
    },
    query: input.query ?? {},
    body: input.body,
  } as unknown as FastifyRequest;
}

expect(DashboardAccessError).toBeDefined();
