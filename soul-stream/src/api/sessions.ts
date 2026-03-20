/**
 * 세션 API — REST + SSE.
 */

import { Router } from "express";
import type { NodeManager } from "../nodes/node-manager";
import { SessionAggregator } from "../sessions/session-aggregator";
import { SessionRouter } from "../sessions/session-router";
import type { CreateSessionRequest } from "../sessions/types";
import { globalEventStore } from "../sessions/event-store";

export function createSessionsRouter(nodeManager: NodeManager): Router {
  const router = Router();
  const aggregator = new SessionAggregator(nodeManager);
  const sessionRouter = new SessionRouter(nodeManager);

  /** GET /api/sessions — 전체 세션 목록, ?nodeId=xxx로 노드별 필터. */
  router.get("/", (req, res) => {
    const nodeId = req.query.nodeId as string | undefined;
    const sessions = aggregator.getAllSessions(nodeId);
    res.json({ sessions });
  });

  /** POST /api/sessions — 세션 생성. */
  router.post("/", async (req, res) => {
    try {
      const body = req.body as CreateSessionRequest;
      if (!body.prompt) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      const result = await sessionRouter.createSession(body);
      res.status(201).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const status = message.includes("not found") || message.includes("No connected")
        ? 404
        : 500;
      res.status(status).json({ error: message });
    }
  });

  /** GET /api/sessions/:id/events — 세션 이벤트 히스토리 + 실시간 (SSE). */
  router.get("/:id/events", (req, res) => {
    const sessionId = req.params.id;
    const found = aggregator.findSession(sessionId);

    if (!found) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const node = nodeManager.getNode(found.nodeId);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // 초기 이벤트
    res.write(
      `data: ${JSON.stringify({ type: "init", sessionId, nodeId: found.nodeId })}\n\n`
    );

    // 캐시된 이벤트 replay
    const cached = globalEventStore.getEvents(sessionId);
    for (const event of cached) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // 라이브 구독
    const unsub = node.onSessionEvent(sessionId, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.on("close", () => {
      unsub();
    });
  });

  /** POST /api/sessions/:id/intervene — 세션 개입. */
  router.post("/:id/intervene", async (req, res) => {
    const sessionId = req.params.id;
    const found = aggregator.findSession(sessionId);

    if (!found) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const node = nodeManager.getNode(found.nodeId);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    const { text, user } = req.body as { text: string; user?: string };
    if (!text) {
      res.status(400).json({ error: "text is required" });
      return;
    }

    await node.intervene(sessionId, text, user ?? "dashboard");
    res.json({ sent: true });
  });

  /** POST /api/sessions/:id/respond — AskUserQuestion 응답. */
  router.post("/:id/respond", async (req, res) => {
    const sessionId = req.params.id;
    const found = aggregator.findSession(sessionId);

    if (!found) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const node = nodeManager.getNode(found.nodeId);
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    const { request_id, answers } = req.body as {
      request_id: string;
      answers: Record<string, unknown>;
    };
    if (!request_id || !answers) {
      res.status(400).json({ error: "request_id and answers are required" });
      return;
    }

    await node.respond(sessionId, request_id, answers);
    res.json({ sent: true });
  });

  return router;
}
