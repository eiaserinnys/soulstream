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
  router.get("/:id/events", async (req, res) => {
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

    if (cached.length > 0) {
      // in-memory 캐시에 이벤트가 있으면 그대로 사용
      for (const event of cached) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } else {
      // 캐시가 없으면 soul-server HTTP API에서 히스토리를 프록시
      // (서버 재시작 후 in-memory 캐시가 비워진 경우 등)
      try {
        const baseUrl = node.getHttpBaseUrl();
        const historyUrl = `${baseUrl}/sessions/${sessionId}/history`;
        const upstream = await fetch(historyUrl, {
          headers: { Accept: "text/event-stream" },
          signal: AbortSignal.timeout(5000),
        });

        if (upstream.ok && upstream.body) {
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          outer: while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const raw = line.slice(5).trim();
              if (!raw) continue;

              try {
                const parsed = JSON.parse(raw) as Record<string, unknown>;
                const eventType = parsed.type as string | undefined;

                // history_sync = 히스토리 재생 완료 신호
                if (eventType === "history_sync") break outer;
                if (eventType === "keepalive") continue;

                // soul-server 이벤트를 soul-stream 포맷으로 래핑
                const wrapped = {
                  type: "event",
                  session_id: sessionId,
                  event: parsed,
                };
                res.write(`data: ${JSON.stringify(wrapped)}\n\n`);
                // in-memory 캐시에도 저장 (이후 재요청 시 재활용)
                globalEventStore.append(sessionId, wrapped);
              } catch {
                // 파싱 실패 — 건너뜀
              }
            }
          }

          reader.cancel().catch(() => {});
        }
      } catch {
        // soul-server 접근 실패 시 조용히 계속 (라이브 구독만 유지)
      }
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
