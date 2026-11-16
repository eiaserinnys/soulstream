import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";

const registeredApps = new WeakSet<FastifyInstance>();

/**
 * How long clients get to finish the close handshake before the socket is
 * destroyed. `ws` otherwise waits its 30s default, which is the same as the
 * service manager's stop timeout and is why deploys used to hang until SIGKILL.
 */
export const WEBSOCKET_CLIENT_CLOSE_GRACE_MS = 1_500;

export function registerWebsocketPlugin(app: FastifyInstance): void {
  if (registeredApps.has(app)) return;
  registeredApps.add(app);
  app.register(websocket, {
    preClose(done) {
      const server = app.websocketServer;
      const startedAt = Date.now();
      const clients = [...server.clients];
      let terminated = 0;
      for (const client of clients) client.close();
      const graceTimer = setTimeout(() => {
        for (const client of server.clients) {
          if (client.readyState === WebSocket.CLOSED) continue;
          client.terminate();
          terminated += 1;
        }
      }, WEBSOCKET_CLIENT_CLOSE_GRACE_MS);
      graceTimer.unref();
      server.close(() => {
        clearTimeout(graceTimer);
        app.log.info(
          {
            event: "orchestrator.shutdown_step",
            step: "websocket_clients",
            elapsed_ms: Math.max(0, Date.now() - startedAt),
            clients: clients.length,
            terminated,
          },
          "websocket clients closed",
        );
        done();
      });
    },
  });
}
