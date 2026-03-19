/**
 * Express 서버 설정 — 포트 5200.
 */

import { existsSync } from "fs";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { NodeManager } from "./nodes/node-manager";
import { createNodesRouter } from "./api/nodes";
import { createSessionsRouter } from "./api/sessions";
import { setupNodeWebSocket } from "./ws/node-handler";

export interface ServerConfig {
  port: number;
  dashboardDir?: string;
}

export function createSoulStreamServer(config: ServerConfig) {
  const app = express();
  const server = createServer(app);

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Core modules
  const nodeManager = new NodeManager();

  // API routes
  app.use("/api/nodes", createNodesRouter(nodeManager));
  app.use("/api/sessions", createSessionsRouter(nodeManager));

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      nodes: nodeManager.size,
      connectedNodes: nodeManager.getConnectedNodes().length,
    });
  });

  // Dashboard static files (Phase 4에서 빌드 결과물 서빙)
  if (config.dashboardDir && existsSync(config.dashboardDir)) {
    app.use(express.static(config.dashboardDir));
    // SPA fallback
    app.get("*", (_req, res) => {
      res.sendFile("index.html", { root: config.dashboardDir! });
    });
  }

  // WebSocket
  const wss = setupNodeWebSocket(server, nodeManager);

  return {
    app,
    server,
    nodeManager,
    wss,
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(config.port, () => {
          console.log(`SoulStream server listening on port ${config.port}`);
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        wss.close();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
