import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

const registeredApps = new WeakSet<FastifyInstance>();

export function registerWebsocketPlugin(app: FastifyInstance): void {
  if (registeredApps.has(app)) return;
  registeredApps.add(app);
  app.register(websocket);
}
