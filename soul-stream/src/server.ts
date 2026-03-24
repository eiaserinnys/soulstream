/**
 * Express 서버 설정 — 포트 5200.
 */

import { existsSync } from "fs";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Pool } from "pg";
import { NodeManager } from "./nodes/node-manager";
import { SessionDB } from "./db/session-db";
import { createNodesRouter } from "./api/nodes";
import { createSessionsRouter } from "./api/sessions";
import { createFoldersRouter } from "./api/folders";
import { createCatalogRouter } from "./api/catalog";
import { setupNodeWebSocket } from "./ws/node-handler";

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  /** §8: orchestrator-dashboard dist 디렉토리 경로. 필수값. */
  dashboardDir: string;
}

export function createSoulStreamServer(config: ServerConfig) {
  const app = express();
  const server = createServer(app);

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Core modules
  const nodeManager = new NodeManager();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const sessionDB = new SessionDB(pool);

  // API routes
  app.use("/api/nodes", createNodesRouter(nodeManager));
  app.use("/api/sessions", createSessionsRouter(nodeManager, sessionDB));
  app.use("/api/folders", createFoldersRouter(sessionDB));
  app.use("/api", createCatalogRouter(sessionDB));

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      nodes: nodeManager.size,
      connectedNodes: nodeManager.getConnectedNodes().length,
    });
  });

  // Dashboard static files — orchestrator-dashboard dist 서빙
  if (existsSync(config.dashboardDir)) {
    app.use(express.static(config.dashboardDir));
    // SPA fallback
    app.get("{*path}", (_req, res) => {
      res.sendFile("index.html", { root: config.dashboardDir });
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
