import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { registerWebsocketPlugin } from "../src/websocket_plugin.js";

describe("websocket shutdown", () => {
  it("finishes app.close within 2s while a client never answers the close handshake", async () => {
    const app = Fastify({ forceCloseConnections: true, logger: false });
    registerWebsocketPlugin(app);
    // The plugin's onRoute hook only sees routes added after it is loaded.
    app.after(() => {
      app.get("/ws", { websocket: true }, () => {});
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new WebSocket(address.replace(/^http/, "ws") + "/ws");
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", () => resolve());
        client.once("error", reject);
      });
      // Keep the client from reading the server's close frame. Without the
      // plugin's terminate grace this held app.close() for ws's 30s default,
      // the same window as Haniel's stop timeout.
      const socket = (client as unknown as { _socket: { pause(): void } })._socket;
      socket.pause();
      const startedAt = Date.now();
      await app.close();
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(2_000);
      expect(elapsedMs).toBeGreaterThan(1_000);
    } finally {
      client.terminate();
      await app.close();
    }
  });
});
