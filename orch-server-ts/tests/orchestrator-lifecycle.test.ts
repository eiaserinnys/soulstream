import Fastify from "fastify";
import { createProductionOrchestrator } from "../src/production.js";
import { loadOrchServerEnvironment } from "../src/config.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  OrchestratorLifecycle,
  readDashboardBuildId,
} from "../src/runtime/orchestrator_lifecycle.js";
import {
  InMemorySseReplayBroadcaster,
  type SessionStreamEvent,
} from "../src/sse/replay_broadcaster.js";
import { registerSseReplayRoutes } from "../src/sse/sse_replay_routes.js";

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
  it("writes shutdown to a real SSE socket before closing, with draining health", async () => {
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
    const lifecycle = new OrchestratorLifecycle("a".repeat(40), broadcaster);
    const app = Fastify({ forceCloseConnections: true });
    app.get("/api/health", () => lifecycle.snapshot());
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
        expect(lifecycle.snapshot()).toMatchObject({
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
      await closed;
      await lifecycle.beginShutdown();
      expect(broadcaster.bufferedEvents).toHaveLength(1);
    } finally {
      abort.abort();
      await app.close();
    }
  });
  it("production.close delivers shutdown before app close and resource disposal", async () => {
    const events: string[] = [];
    const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
    const lifecycle = new OrchestratorLifecycle("dev", broadcaster);
    const server = await createProductionOrchestrator({
      config: loadOrchServerEnvironment({
        HOST: "127.0.0.1",
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
