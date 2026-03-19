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

    // 초기 스냅샷 전송 (named event)
    const nodes = nodeManager.getNodes();
    res.write(`event: snapshot\ndata: ${JSON.stringify(nodes)}\n\n`);

    // 이벤트 타입을 클라이언트가 기대하는 이름으로 매핑
    const eventNameMap: Record<string, string> = {
      node_registered: "node_connected",
      node_status_changed: "node_updated",
      node_unregistered: "node_disconnected",
    };

    const unsub = nodeManager.onNodeChange((event) => {
      const sseEvent = eventNameMap[event.type] ?? event.type;
      const payload =
        "node" in event ? event.node : { nodeId: event.nodeId };
      res.write(`event: ${sseEvent}\ndata: ${JSON.stringify(payload)}\n\n`);
    });

    req.on("close", () => {
      unsub();
    });
  });

  return router;
}
