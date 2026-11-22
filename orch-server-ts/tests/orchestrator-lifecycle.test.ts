import Fastify from "fastify";
import { createProductionOrchestrator } from "../src/production.js";
import { loadOrchServerEnvironment } from "../src/config.js";
import { mkdtemp, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  DashboardBuildInfo,
  OrchestratorLifecycle,
  readDashboardBuildId,
} from "../src/runtime/orchestrator_lifecycle.js";
import {
  InMemorySseReplayBroadcaster,
  type SessionStreamEvent,
} from "../src/sse/replay_broadcaster.js";
import { registerSseReplayRoutes } from "../src/sse/sse_replay_routes.js";
import { registerPublicStatusRoutes } from "../src/public/public_status_routes.js";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";

const catalog = repositoryModelCatalog();

async function writeBuildInfo(
  path: string,
  buildId: string,
  modifiedAtMs: number,
): Promise<void> {
  await writeFile(path, JSON.stringify({ build_id: buildId }));
  // A Date (not a bare number) so utimes takes milliseconds, not seconds. Some
  // CI filesystems clamp far-future second values to one mtime, which would
  // hide the mtime change this helper exists to create.
  await utimes(path, new Date(modifiedAtMs), new Date(modifiedAtMs));
}


describe("orchestrator lifecycle", () => {
  it("reads the deployed manifest and keeps test identity explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dashboard-build-"));
    try {
      await expect(readDashboardBuildId(dir, "production")).rejects.toThrow();
      await writeFile(
        join(dir, "build-info.json"),
        JSON.stringify({ build_id: "a".repeat(40) }),
      );
      expect(await readDashboardBuildId(dir, "production")).toBe(
        "a".repeat(40),
      );
      expect(await readDashboardBuildId(dir, "test")).toBe("dev");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("follows build-info.json changes while keeping the process build id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dashboard-build-refresh-"));
    const path = join(dir, "build-info.json");
    try {
      await writeBuildInfo(path, "a".repeat(40), Date.now() + 1_000);
      const info = await DashboardBuildInfo.open(dir, "production");
      expect(info.processBuildId).toBe("a".repeat(40));
      expect(await info.currentBuildId()).toBe("a".repeat(40));

      await writeBuildInfo(path, "b".repeat(40), Date.now() + 21_000);
      expect(await info.currentBuildId()).toBe("b".repeat(40));
      expect(info.processBuildId).toBe("a".repeat(40));

      await writeFile(path, "{not json");
      await utimes(path, Date.now() + 41_000, Date.now() + 41_000);
      expect(await info.currentBuildId()).toBe("b".repeat(40));

      await rm(path);
      expect(await info.currentBuildId()).toBe("b".repeat(40));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("serves the deployed build as build_id and the started build as process_build_id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dashboard-health-"));
    const path = join(dir, "build-info.json");
    const app = Fastify({ logger: false });
    try {
      await writeBuildInfo(path, "a".repeat(40), Date.now() + 1_000);
      const info = await DashboardBuildInfo.open(dir, "production");
      const lifecycle = new OrchestratorLifecycle(
        info,
        new InMemorySseReplayBroadcaster<SessionStreamEvent>(),
      );
      registerPublicStatusRoutes(app, {
        configProvider: {
          getConfig: () => ({ authEnabled: false, atomEnabled: false }),
        },
        folderCountsProvider: {
          getFolderCounts: () => ({}),
          listFolders: () => [],
          resolveAccess: () => ({ restricted: false }),
        },
        lifecycle,
      });

      await writeBuildInfo(path, "b".repeat(40), Date.now() + 21_000);
      const response = await app.inject({ method: "GET", url: "/api/health" });
      expect(response.json()).toMatchObject({
        build_id: "b".repeat(40),
        process_build_id: "a".repeat(40),
      });
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("writes shutdown to a real SSE socket before closing, with draining health", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dashboard-sse-"));
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
    const app = Fastify({ forceCloseConnections: true });
    try {
      await writeBuildInfo(
        join(dir, "build-info.json"),
        "a".repeat(40),
        Date.now() + 1_000,
      );
      const lifecycle = new OrchestratorLifecycle(
        await DashboardBuildInfo.open(dir, "production"),
        broadcaster,
      );
      app.get("/api/health", async () => await lifecycle.snapshot());
      registerSseReplayRoutes(app, {
        session: {
          broadcaster,
          loadSnapshot: async () => ({ sessions: [] }),
          filterEvent: async (_request, event) => event,
        },
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      lifecycle.markReady();
      const abort = new AbortController();
      try {
        const response = await fetch(address + "/api/sessions/stream", {
          signal: abort.signal,
        });
        const reader = response.body!.getReader();
        let text = new TextDecoder().decode((await reader.read()).value);
        expect(text).toContain("session_list");
        const closed = (async () => {
          await lifecycle.beginShutdown();
          expect(await lifecycle.snapshot()).toMatchObject({
            healthy: false,
            draining: true,
            ready: false,
          });
          await app.close();
        })();
        while (!text.includes("orchestrator_shutdown")) {
          const next = await reader.read();
          if (next.done) break;
          text += new TextDecoder().decode(next.value);
        }
        expect(text).toContain("event: orchestrator_shutdown");
        expect(text).toContain('"build_id":"' + "a".repeat(40) + '"');
        expect(text).toContain('"process_build_id":"' + "a".repeat(40) + '"');
        await closed;
        await lifecycle.beginShutdown();
        expect(broadcaster.bufferedEvents).toHaveLength(1);
      } finally {
        abort.abort();
      }
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("production.close delivers shutdown before app close and resource disposal", async () => {
    const events: string[] = [];
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
    const lifecycle = new OrchestratorLifecycle(
      await DashboardBuildInfo.open(join(tmpdir(), "unused-dashboard"), "test"),
      broadcaster,
    );
    const server = await createProductionOrchestrator({
      modelCatalog: catalog,
      config: loadOrchServerEnvironment({
        HOST: "127.0.0.1",
    SOULSTREAM_PUBLIC_URL: "https://dashboard.example.test",
        PORT: "0",
        ENVIRONMENT: "test",
        DATABASE_URL: "postgres://unused/unused",
        CLAUDE_OAUTH_CLIENT_ID: "test",
        CLAUDE_OAUTH_CALLBACK_URL: "http://localhost/callback",
      }),
      applicationFactory: async () => {
        const app = Fastify({ forceCloseConnections: true });
        registerSseReplayRoutes(app, {
          session: {
            broadcaster,
            loadSnapshot: async () => ({ sessions: [] }),
            filterEvent: async (_request, event) => event,
          },
        });
        app.addHook("onClose", async () => {
          events.push("app-close");
        });
        return {
          app,
          startBackground: async () => lifecycle.markReady(),
          beginShutdown: async () => {
            await lifecycle.beginShutdown();
            events.push("notice-written");
          },
          closeResources: async () => {
            events.push("resources-close");
          },
        };
      },
    });
    const address = await server.listen();
    const abort = new AbortController();
    try {
      const response = await fetch(address + "/api/sessions/stream", {
        signal: abort.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      const closing = server.close();
      let text = "";
      while (!text.includes("orchestrator_shutdown")) {
        const next = await reader.read();
        if (next.done) break;
        text += new TextDecoder().decode(next.value);
      }
      expect(text).toContain("orchestrator_shutdown");
      await closing;
      expect(events).toEqual([
        "notice-written",
        "app-close",
        "resources-close",
      ]);
    } finally {
      abort.abort();
      await server.close();
    }
  });
});
