/**
 * 세션 API — REST + SSE.
 */

import { Router } from "express";
import type { Response } from "express";
import type { NodeManager } from "../nodes/node-manager";
import { SessionDB } from "../db/session-db";
import { SessionRouter } from "../sessions/session-router";
import type { CreateSessionRequest, SessionEvent } from "../sessions/types";

/**
 * typed SSE 전송 헬퍼. event_id를 포함한다.
 *
 * eventType: DB event_type 컬럼 값 그대로 (예: "text_start", "complete" 등)
 * id: SSE id 필드 (Last-Event-ID 재연결용). 0이면 생략.
 */
function writeTypedSSEWithId(
  res: Response,
  eventType: string,
  data: unknown,
  id: number
): void {
  const idLine = id > 0 ? `id: ${id}\n` : "";
  res.write(`${idLine}event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createSessionsRouter(
  nodeManager: NodeManager,
  sessionDB: SessionDB
): Router {
  const router = Router();
  const sessionRouter = new SessionRouter(nodeManager);

  /** GET /api/sessions — DB에서 세션 목록 직접 조회. */
  router.get("/", async (req, res) => {
    try {
      const folderId = req.query.folderId as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const cursor = req.query.cursor ? parseInt(req.query.cursor as string, 10) : undefined;
      const result = await sessionDB.listSessions({ folderId, limit, cursor });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  /** POST /api/sessions — 세션 생성. nodeId 지정 시 해당 노드로 직접 라우팅. */
  router.post("/", async (req, res) => {
    try {
      const { prompt, nodeId, profile, allowed_tools, disallowed_tools, use_mcp } =
        req.body as CreateSessionRequest;

      if (!prompt) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }

      if (nodeId) {
        // nodeId 직접 지정 — orchestrator-dashboard 전용 경로
        const nodeConnection = nodeManager.getNode(nodeId);
        if (!nodeConnection) {
          return res.status(503).json({ error: "node_unavailable", nodeId });
        }
        const sessionId = await nodeConnection.createSession(prompt, {
          profile,
          allowed_tools,
          disallowed_tools,
          use_mcp,
        });
        return res.status(201).json({ sessionId, nodeId });
      } else {
        // 기존 SessionRouter 자동 선택 유지
        const result = await sessionRouter.createSession(
          req.body as CreateSessionRequest
        );
        res.status(201).json(result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const status =
        message.includes("not found") || message.includes("No connected")
          ? 404
          : 500;
      res.status(status).json({ error: message });
    }
  });

  /**
   * GET /api/sessions/:id/events — DB 히스토리 → WS live relay (SSE).
   *
   * 1. DB에서 after_id 이후 이벤트를 순서대로 전송 (typed SSE + id 필드)
   * 2. subscribeEvents로 라이브 이벤트 relay
   */
  router.get("/:id/events", async (req, res) => {
    const sessionId = req.params.id;

    const session = await sessionDB.getSession(sessionId).catch(() => null);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }

    const node = nodeManager.getNode(session.node_id);
    if (!node) {
      res.status(503).json({ error: "node_unavailable", nodeId: session.node_id });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // 초기 이벤트
    res.write(
      `event: init\ndata: ${JSON.stringify({
        type: "init",
        sessionId,
        nodeId: session.node_id,
      })}\n\n`
    );

    // Last-Event-ID 헤더로 after_id 결정
    const lastEventIdHeader = req.headers["last-event-id"];
    const after_id = lastEventIdHeader ? parseInt(lastEventIdHeader as string, 10) : 0;
    let lastEventId = after_id;

    // DB 히스토리 재생
    for await (const event of sessionDB.streamEvents(sessionId, after_id)) {
      writeTypedSSEWithId(res, event.eventType, event.eventData, event.id);
      lastEventId = event.id;
    }

    // WS live relay
    // subscribeEvents는 soul-server 측에서 라이브 리스너를 먼저 등록 후
    // DB 재읽기를 수행하므로 DB-live 전환 구간 gap 없음 (Phase 1 §3 설계 참조)
    // sessionEvent.type = 내부 이벤트 타입 ("text_start", "complete", "error" 등)
    const unsubscribe = node.subscribeEvents(
      sessionId,
      lastEventId,
      (event: SessionEvent, eventId: number) =>
        writeTypedSSEWithId(res, event.type, event, eventId)
    );

    req.on("close", () => {
      unsubscribe();
    });
  });

  /** GET /api/sessions/:id/cards — 세션 이벤트 히스토리 스냅샷. */
  router.get("/:id/cards", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const events = await sessionDB.listEvents(sessionId);
      res.json({ events });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(500).json({ error: message });
    }
  });

  /** POST /api/sessions/:id/intervene — 세션 개입. 원래 노드로 라우팅. */
  router.post("/:id/intervene", async (req, res) => {
    const sessionId = req.params.id;

    const session = await sessionDB.getSession(sessionId).catch(() => null);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }

    const node = nodeManager.getNode(session.node_id);
    if (!node) {
      res.status(503).json({ error: "node_unavailable", nodeId: session.node_id });
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

  /** POST /api/sessions/:id/respond — AskUserQuestion 응답. 원래 노드로 라우팅. */
  router.post("/:id/respond", async (req, res) => {
    const sessionId = req.params.id;

    const session = await sessionDB.getSession(sessionId).catch(() => null);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }

    const node = nodeManager.getNode(session.node_id);
    if (!node) {
      res.status(503).json({ error: "node_unavailable", nodeId: session.node_id });
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
