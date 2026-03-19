/**
 * 노드 API — GET /api/nodes, GET /api/nodes/stream (SSE).
 */

import { Router } from "express";
import type { NodeManager } from "../nodes/node-manager";

export function createNodesRouter(nodeManager: NodeManager): Router {
  const router = Router();

  /** GET /api/nodes — 전체 노드 목록. */
  router.get("/", (_req, res) => {
    res.json({ nodes: nodeManager.getNodes() });
  });

  /** GET /api/nodes/stream — 노드 상태 변경 실시간 스트림 (SSE). */
  router.get("/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // 초기 상태 전송
    res.write(
      `data: ${JSON.stringify({ type: "init", nodes: nodeManager.getNodes() })}\n\n`
    );

    const unsub = nodeManager.onNodeChange((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on("close", () => {
      unsub();
    });
  });

  return router;
}
