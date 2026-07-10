import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLiveProductionApplication,
  createProductionOrchestrator,
  loadOrchServerEnvironment,
} from "../src/index.js";

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
    const application = await createLiveProductionApplication(
      loadOrchServerEnvironment(minimalEnvironment()),
      { warn: vi.fn() },
    );

    const health = await application.app.inject({ method: "GET", url: "/api/health" });
    const status = await application.app.inject({ method: "GET", url: "/api/status" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", version: "0.1.0" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      is_draining: false,
      healthy: true,
      atom_enabled: false,
    });
    expect(application.app.printRoutes()).toContain("ws/node");
    expect(application.app.printRoutes()).toContain("runbooks/");

    await application.app.close();
    await application.closeResources();
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
    ENVIRONMENT: "test",
    CLAUDE_OAUTH_CLIENT_ID: "test-client",
    CLAUDE_OAUTH_CALLBACK_URL: "http://127.0.0.1/claude/callback",
  };
}
