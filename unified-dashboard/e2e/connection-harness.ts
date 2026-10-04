/** Foreground test harness: real production.close, SSE TCP and isolated nginx;
 * auth/catalog/planner data remain explicit local HTTP fixtures in the browser. */
import Fastify from "../../orch-server-ts/node_modules/fastify/fastify.js";
import { createProductionOrchestrator } from "../../orch-server-ts/src/production.js";
import { loadOrchServerEnvironment } from "../../orch-server-ts/src/config.js";
import {
  OrchestratorLifecycle,
  readDashboardBuildId,
} from "../../orch-server-ts/src/runtime/orchestrator_lifecycle.js";
import {
  InMemorySseReplayBroadcaster,
  type SessionStreamEvent,
} from "../../orch-server-ts/src/sse/replay_broadcaster.js";
import { registerSseReplayRoutes } from "../../orch-server-ts/src/sse/sse_replay_routes.js";
import { connectionQaSessions } from "./v3-visual-fixtures.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
const root = resolve(import.meta.dirname, "../.."),
  dist = join(root, "unified-dashboard/dist");
const buildId = await readDashboardBuildId(dist, "production");
let server:
  | Awaited<ReturnType<typeof createProductionOrchestrator>>
  | undefined;
let lifecycle: OrchestratorLifecycle;
let instance = 0;
const events: string[] = [];
async function start(nextBuild = buildId) {
  const broadcaster = new InMemorySseReplayBroadcaster<SessionStreamEvent>();
  lifecycle = new OrchestratorLifecycle(nextBuild, broadcaster);
  instance++;
  server = await createProductionOrchestrator({
    config: loadOrchServerEnvironment({
      HOST: "127.0.0.1",
      PORT: "52106",
      ENVIRONMENT: "test",
      DASHBOARD_DIR: dist,
      DATABASE_URL: "postgres://unused/unused",
      CLAUDE_OAUTH_CLIENT_ID: "qa",
      CLAUDE_OAUTH_CALLBACK_URL: "http://localhost/callback",
    }),
    applicationFactory: async () => {
      const app = Fastify({ forceCloseConnections: true });
      app.get("/api/health", async () => ({
        ...lifecycle.snapshot(),
        status: "ok",
      }));
      app.addHook("onRequest", async (request, reply) => {
        if (
          request.url.startsWith("/api/sessions/stream") &&
          !request.headers.cookie?.includes("connection-qa=authenticated")
        )
          return reply
            .code(401)
            .send({ error: "Fixture authentication required" });
      });
      registerSseReplayRoutes(app, {
        session: {
          broadcaster,
          loadSnapshot: async () => ({
            sessions: connectionQaSessions,
            total: connectionQaSessions.length,
          }),
          filterEvent: async (_request, event) => event,
        },
      });
      app.addHook("onClose", async () => {
        events.push(`app-close:${instance}`);
      });
      return {
        app,
        startBackground: async () => lifecycle.markReady(),
        beginShutdown: async () => {
          await lifecycle.beginShutdown();
          events.push(`shutdown-written:${instance}`);
        },
        closeResources: async () => {
          events.push(`resources-close:${instance}`);
        },
      };
    },
  });
  await server.listen();
}
await start();
const temp = await mkdtemp(join(tmpdir(), "connection-nginx-"));
const proxy = join(temp, "proxy.conf");
await writeFile(
  proxy,
  "proxy_http_version 1.1; proxy_set_header Host $host; proxy_buffering off; proxy_read_timeout 60s; proxy_connect_timeout 5s;",
);
let snippet = await readFile(
  join(root, "deploy/nginx/dashboard-connection-recovery.conf"),
  "utf8",
);
snippet = snippet
  .replaceAll(
    "/home/eias/migration/netcup-core-bootstrap/production-staging/repo/unified-dashboard/dist",
    dist,
  )
  .replaceAll("/etc/nginx/snippets/netcup-core-proxy.conf", proxy);
const config = join(temp, "nginx.conf");
await writeFile(
  config,
  `pid ${temp}/nginx.pid; error_log stderr; events {} http { include /etc/nginx/mime.types; access_log off; upstream netcup_core_soulstream_orchestrator {server 127.0.0.1:52106;} server { listen 127.0.0.1:52108; ${snippet} } }`,
);
const nginx = spawn(
  "/usr/sbin/nginx",
  ["-c", config, "-p", temp, "-g", "daemon off;"],
  { stdio: ["ignore", "inherit", "inherit"] },
);
nginx.on("exit", (code) => {
  if (code && !stopping) process.exitCode = code;
});
const control = Fastify();
control.get("/ready", () => ({ ready: true, build_id: buildId }));
control.get("/evidence", () => ({
  events,
  instance,
  health: server ? lifecycle.snapshot() : null,
}));
control.post("/close", async () => {
  await server?.close();
  server = undefined;
  return { events };
});
control.post("/start", async (request) => {
  const body = request.body as { newBuild?: boolean } | undefined;
  if (!server) await start(body?.newBuild ? "b".repeat(40) : buildId);
  return { instance };
});
await control.listen({ host: "127.0.0.1", port: 52107 });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  nginx.kill("SIGTERM");
  await server?.close();
  await control.close();
  await rm(temp, { recursive: true, force: true });
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
