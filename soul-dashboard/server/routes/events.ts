/**
 * Events Routes - SSE 이벤트 스트림 엔드포인트
 *
 * GET /api/sessions/:id/events - SSE 스트림 (세션의 실시간 이벤트)
 *
 * :id = agentSessionId
 *
 * 대시보드 클라이언트가 이 엔드포인트에 연결하면:
 * 1. JSONL에서 기존 이벤트를 재생 (Last-Event-ID 이후)
 * 2. EventHub에 등록하여 라이브 이벤트 수신
 */

import { Router } from "express";
import type { SessionStore } from "../session-store.js";
import type { EventHub } from "../event-hub.js";
import type { SoulClient } from "../soul-client.js";

export interface EventsRouterDeps {
  sessionStore: SessionStore;
  eventHub: EventHub;
  soulClient: SoulClient;
}

export function createEventsRouter(deps: EventsRouterDeps): Router {
  const { sessionStore, eventHub, soulClient } = deps;
  const router = Router();

  /**
   * GET /api/sessions/:id/events
   *
   * SSE 스트림 엔드포인트.
   * 대시보드 클라이언트가 세션의 실시간 이벤트를 구독합니다.
   *
   * :id = agentSessionId
   *
   * 헤더:
   * - Last-Event-ID: 재연결 시 마지막으로 수신한 이벤트 ID
   */
  router.get("/:id/events", async (req, res) => {
    try {
      const agentSessionId = req.params.id;

      if (!agentSessionId) {
        res.status(400).json({
          error: {
            code: "INVALID_SESSION_ID",
            message: "Session ID is required",
          },
        });
        return;
      }

      // Last-Event-ID 파싱
      const lastEventIdHeader = req.headers["last-event-id"];
      let lastEventId = 0;
      if (typeof lastEventIdHeader === "string") {
        const parsed = parseInt(lastEventIdHeader, 10);
        if (!isNaN(parsed)) {
          lastEventId = parsed;
        }
      }

      // JSONL에서 전체 이벤트를 한 번만 읽기
      let allEvents: Awaited<ReturnType<typeof sessionStore.readEvents>>;
      try {
        allEvents = await sessionStore.readEvents(agentSessionId);
      } catch (err) {
        console.warn(
          `[events] Failed to read events for ${agentSessionId}:`,
          err,
        );
        allEvents = [];
      }

      // EventHub에 클라이언트 등록 (SSE 헤더 설정 포함)
      // agentSessionId를 세션 키로 사용
      const dashClientId = eventHub.addClient(
        agentSessionId,
        res,
        lastEventId,
      );

      // 재생할 이벤트 결정
      const eventsToReplay =
        lastEventId > 0
          ? allEvents.filter((ev) => ev.id > lastEventId)
          : allEvents;

      if (eventsToReplay.length > 0) {
        eventHub.replayEvents(dashClientId, eventsToReplay);
      }

      // 연결이 끊어질 때 정리는 EventHub.addClient에서 자동 처리됨
    } catch (err) {
      console.error("[events] SSE connection error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: "INTERNAL_ERROR",
            message: "Failed to establish SSE connection",
          },
        });
      }
    }
  });

  return router;
}
