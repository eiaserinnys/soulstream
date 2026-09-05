import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUTH_COOKIE_NAME,
  createEnvironmentConfigProvider,
  createLiveAuthJwtHelper,
  createLiveProductionApplication,
  createProductionOrchestrator,
  loadOrchServerEnvironment,
} from "../src/index.js";
import type {
  LiveDbSqlResolver,
  LivePostgresSql,
} from "../src/runtime/live_db_sql.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("production orchestrator entrypoint", () => {
  it("assembles the complete live provider bundle without contacting external services", async () => {
    const config = loadOrchServerEnvironment(minimalEnvironment());
    const databaseSchema = {
      migration_id: "088_test_schema",
      checksum: "test-schema-checksum",
      ordinal: 88,
    };
    const schemaQuery = vi.fn(async (strings: TemplateStringsArray) => {
      expect(strings.join(" ")).toContain("FROM schema_migrations");
      return [databaseSchema];
    });
    const sql = Object.assign(schemaQuery, {
      json: (value: unknown) => value,
    }) as unknown as LivePostgresSql;
    const sqlResolver: LiveDbSqlResolver = {
      resolveSql: vi.fn(async () => sql),
      close: vi.fn(async () => undefined),
    };
    const application = await createLiveProductionApplication(
      config,
      { warn: vi.fn() },
      { sqlResolver },
    );
    const jwt = createLiveAuthJwtHelper({
      configProvider: createEnvironmentConfigProvider(config),
    });
    const jwtToken = await jwt.issueToken({
      email: "dashboard@example.com",
      name: "Dashboard User",
    });

    const health = await application.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      status: "ok",
      version: "0.1.0",
      database_schema: databaseSchema,
    });
    expect(sqlResolver.resolveSql).toHaveBeenCalledOnce();
    expect(schemaQuery).toHaveBeenCalledOnce();

    const protectedRoutes = ["/api/status", "/api/nodes", "/api/auth/token"];
    for (const url of protectedRoutes) {
      const unauthenticated = await application.app.inject({ method: "GET", url });
      expect(unauthenticated.statusCode, url).toBe(401);

      const serviceBearer = await application.app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer production-service-token" },
      });
      expect(serviceBearer.statusCode, url).toBe(200);

      const dashboardJwt = await application.app.inject({
        method: "GET",
        url,
        headers: { cookie: `${AUTH_COOKIE_NAME}=${jwtToken}` },
      });
      expect(dashboardJwt.statusCode, url).toBe(200);
    }
    expect(application.app.printRoutes()).toContain("ws/node");
    expect(application.app.hasRoute({ method: "POST", url: "/api/tasks" })).toBe(true);
    expect(application.app.hasRoute({ method: "GET", url: "/yjs/page/:pageId" }))
      .toBe(true);
    expect(application.app.hasRoute({ method: "POST", url: "/api/page-yjs/host/:operation" }))
      .toBe(true);
    expect(application.app.hasRoute({ method: "GET", url: "/api/pages" })).toBe(true);
    expect(application.app.hasRoute({ method: "GET", url: "/api/pages/:pageId" })).toBe(true);
    expect(application.app.hasRoute({ method: "GET", url: "/api/pages/search" })).toBe(true);
    expect(application.app.hasRoute({ method: "GET", url: "/api/pages/:pageId/backlinks" }))
      .toBe(true);
    expect(application.app.hasRoute({ method: "POST", url: "/api/pages/daily" })).toBe(true);
    expect(application.app.hasRoute({ method: "POST", url: "/api/pages/:pageId/operations" }))
      .toBe(true);
    expect(application.app.hasRoute({ method: "PATCH", url: "/api/pages/:pageId/starred" }))
      .toBe(true);
    expect(application.app.hasRoute({
      method: "GET",
      url: "/api/admin/runtime-memory",
    })).toBe(true);
    expect(await application.app.inject({
      method: "GET",
      url: "/api/admin/runtime-memory",
    })).toMatchObject({ statusCode: 401 });

    await application.app.close();
    await application.closeResources();
    expect(sqlResolver.close).toHaveBeenCalledOnce();
  });

  it("listens on an ephemeral port and serves health, status, and dashboard over real HTTP", async () => {
    const dashboardDir = await createDashboardDirectory();
    const events: string[] = [];
    const server = await createProductionOrchestrator({
      config: loadOrchServerEnvironment({
        ...minimalEnvironment(),
        PORT: "0",
        DASHBOARD_DIR: dashboardDir,
      }),
      applicationFactory: async () => {
        const app = Fastify({ forceCloseConnections: true });
        app.get("/api/health", async () => ({ status: "ok" }));
        app.get("/api/status", async () => ({ healthy: true }));
        app.addHook("onClose", async () => {
          events.push("app-close");
        });
        return {
          app,
          async startBackground() {
            events.push("background-start");
          },
          async closeResources() {
            events.push("resources-close");
          },
        };
      },
    });

    const address = await server.listen();
    expect(events).toEqual(["background-start"]);
    await expect(fetch(`${address}/api/health`).then((response) => response.json()))
      .resolves.toEqual({ status: "ok" });
    await expect(fetch(`${address}/api/status`).then((response) => response.json()))
      .resolves.toEqual({ healthy: true });
    const dashboard = await fetch(`${address}/nested/route`);
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toBe("production-dashboard");

    await server.close();
    await server.close();
    expect(events).toEqual([
      "background-start",
      "app-close",
      "resources-close",
    ]);
  });

  it("cleans resources without listening when background startup fails", async () => {
    const closeResources = vi.fn(async () => undefined);
    const server = await createProductionOrchestrator({
      config: loadOrchServerEnvironment({ ...minimalEnvironment(), PORT: "0" }),
      warn: vi.fn(),
      applicationFactory: async () => ({
        app: Fastify({ forceCloseConnections: true }),
        startBackground: async () => {
          throw new Error("LISTEN unavailable");
        },
        closeResources,
      }),
    });

    await expect(server.listen()).rejects.toThrow(/LISTEN unavailable/);
    expect(closeResources).toHaveBeenCalledTimes(1);
  });

});

async function createDashboardDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orch-production-dashboard-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "index.html"), "production-dashboard");
  return directory;
}

function minimalEnvironment(): Record<string, string> {
  return {
    HOST: "127.0.0.1",
    DATABASE_URL: "postgres://unused@localhost/unused",
    ENVIRONMENT: "production",
    CORS_ALLOWED_ORIGINS: "http://127.0.0.1",
    AUTH_BEARER_TOKEN: "production-service-token",
    GOOGLE_CLIENT_ID: "dashboard-google-client",
    JWT_SECRET: "production-jwt-secret",
    CLAUDE_OAUTH_CLIENT_ID: "test-client",
    CLAUDE_OAUTH_CALLBACK_URL: "http://127.0.0.1/claude/callback",
  };
}
