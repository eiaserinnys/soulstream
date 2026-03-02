/**
 * Sessions Routes - 세션 목록 및 상세 조회 API
 *
 * GET /api/sessions         - 전체 세션 목록
 * GET /api/sessions/:id     - 특정 세션 상세 정보 (:id = agentSessionId)
 */

import { Router } from "express";
import type { SessionStore } from "../session-store.js";
import type { SessionDetail, SessionSummary } from "../../shared/types.js";

export function createSessionsRouter(sessionStore: SessionStore): Router {
  const router = Router();

  /**
   * GET /api/sessions
   *
   * 저장된 모든 세션의 요약 목록을 반환합니다.
   * JSONL 파일시스템을 스캔하여 세션 메타데이터를 수집합니다.
   */
  router.get("/", async (_req, res) => {
    try {
      const sessions: SessionSummary[] =
        await sessionStore.listSessions();
      res.json({ sessions });
    } catch (err) {
      console.error("[sessions] Failed to list sessions:", err);
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to list sessions",
        },
      });
    }
  });

  /**
   * GET /api/sessions/:id
   *
   * 특정 세션의 상세 정보를 반환합니다.
   * :id = agentSessionId
   */
  router.get("/:id", async (req, res) => {
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

      const events = await sessionStore.readEvents(agentSessionId);

      if (events.length === 0) {
        res.status(404).json({
          error: {
            code: "SESSION_NOT_FOUND",
            message: `Session not found: ${agentSessionId}`,
          },
        });
        return;
      }

      // 이벤트에서 세션 메타데이터 추출
      const lastEvent = events[events.length - 1];
      const lastEventType = lastEvent?.event?.type as string | undefined;
      const status = sessionStore.inferStatus(lastEventType);

      // session 이벤트에서 claude_session_id 추출
      let claudeSessionId: string | undefined;
      for (const record of events) {
        if (record.event.type === "session") {
          claudeSessionId = record.event.session_id as string;
        }
      }

      // complete 이벤트에서 result 추출
      let result: string | undefined;
      let error: string | undefined;
      for (const record of events) {
        if (record.event.type === "complete") {
          result = record.event.result as string;
        }
        if (record.event.type === "error") {
          error = record.event.message as string;
        }
      }

      // 첫 user_message에서 prompt 추출
      let prompt: string | undefined;
      for (const record of events) {
        if (record.event.type === "user_message" && typeof record.event.text === "string") {
          prompt = record.event.text as string;
          break;
        }
      }

      const detail: SessionDetail = {
        agentSessionId,
        status,
        eventCount: events.length,
        lastEventType,
        claudeSessionId,
        prompt,
        result,
        error,
        events,
      };

      res.json(detail);
    } catch (err) {
      console.error("[sessions] Failed to get session:", err);
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to get session details",
        },
      });
    }
  });

  return router;
}
