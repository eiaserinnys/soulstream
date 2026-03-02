/**
 * Actions Routes - 세션 생성, 개입 API
 *
 * POST /api/sessions                  - 새 세션 생성 (Soul에 실행 요청)
 * POST /api/sessions/:id/intervene    - 실행 중/완료된 세션에 메시지 전송
 * POST /api/sessions/:id/message      - intervene의 레거시 호환 경로
 */

import { Router } from "express";
import type { Request, Response as ExpressResponse } from "express";
import type {
  CreateSessionRequest,
  SendMessageRequest,
} from "../../shared/types.js";
import type { EventHub } from "../event-hub.js";
import type { SessionStore } from "../session-store.js";

// Express Response와 fetch Response 구분을 위한 alias
type Response = ExpressResponse;

const MAX_PROMPT_LENGTH = 100_000;
const MAX_MESSAGE_LENGTH = 50_000;

/** 외부 API 호출 타임아웃 (밀리초) */
const SOUL_REQUEST_TIMEOUT_MS = 30_000;

/** 세션 ID 유효 문자 패턴 */
const VALID_ID_PATTERN = /^[a-zA-Z0-9_-]{1,100}$/;

export interface ActionsRouterOptions {
  /** Soul 서버 기본 URL */
  soulBaseUrl: string;
  /** 인증 토큰 */
  authToken?: string;
  /** EventHub 인스턴스 */
  eventHub?: EventHub;
  /** SessionStore 인스턴스 */
  sessionStore?: SessionStore;
  /** SoulClient 인스턴스 (새 세션 구독용) */
  soulClient?: import("../soul-client.js").SoulClient;
}

export function createActionsRouter(options: ActionsRouterOptions): Router {
  const { soulBaseUrl, authToken, eventHub, sessionStore, soulClient } = options;
  const router = Router();

  /**
   * POST /api/sessions
   *
   * 대시보드에서 새 Claude Code 세션을 시작합니다.
   * agent_session_id를 생성하여 Soul 서버에 전달합니다.
   */
  router.post("/", async (req, res) => {
    try {
      const body = req.body as CreateSessionRequest;

      if (!body.prompt || typeof body.prompt !== "string") {
        res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: "prompt is required",
          },
        });
        return;
      }

      if (body.prompt.length > MAX_PROMPT_LENGTH) {
        res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: `prompt exceeds maximum length of ${MAX_PROMPT_LENGTH}`,
          },
        });
        return;
      }

      const clientId = body.clientId ?? "dashboard";
      const requestId = generateRequestId();
      const agentSessionId = generateSessionId();
      const taskKey = `${clientId}:${requestId}`;

      // EventHub에 task→session 매핑 등록
      if (eventHub) {
        eventHub.registerTask(taskKey, agentSessionId);
      }

      // SoulClient가 새 태스크의 SSE를 구독
      if (soulClient) {
        soulClient.subscribe(clientId, requestId);
      }

      // Soul 서버에 실행 요청
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SOUL_REQUEST_TIMEOUT_MS);

      let soulResponse: globalThis.Response;
      try {
        soulResponse = await fetch(`${soulBaseUrl}/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            client_id: clientId,
            request_id: requestId,
            agent_session_id: agentSessionId,
            prompt: body.prompt,
            resume_session_id: body.resumeSessionId ?? null,
            use_mcp: true,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        // 실패 시 정리
        if (eventHub) eventHub.unregisterTask(taskKey);
        if (soulClient) soulClient.unsubscribe(clientId, requestId);

        if (err instanceof Error && err.name === "AbortError") {
          res.status(504).json({
            error: {
              code: "TIMEOUT",
              message: `Soul server request timed out after ${SOUL_REQUEST_TIMEOUT_MS / 1000}s`,
            },
          });
          return;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!soulResponse.ok) {
        const errorBody = await soulResponse.text();
        console.error(`[actions] Soul execute failed (${soulResponse.status}):`, errorBody);
        if (eventHub) eventHub.unregisterTask(taskKey);
        if (soulClient) soulClient.unsubscribe(clientId, requestId);
        res.status(502).json({
          error: {
            code: "SOUL_ERROR",
            message: `Soul server returned ${soulResponse.status}`,
            details: { body: errorBody },
          },
        });
        return;
      }

      // Soul이 SSE 스트림을 반환하지만, 대시보드에서는 세션 정보만 반환
      if (soulResponse.body) {
        await soulResponse.body.cancel();
      }

      // user_message 기록은 Soul 서버가 담당 (JSONL의 유일한 기록자)

      res.status(201).json({
        agentSessionId,
        status: "running",
      });
    } catch (err) {
      console.error("[actions] Failed to create session:", err);
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to create session",
        },
      });
    }
  });

  /**
   * POST /api/sessions/:id/intervene
   * POST /api/sessions/:id/message (레거시 호환)
   *
   * 실행 중이면 intervention, 완료되었으면 자동 resume.
   * Soul 서버가 태스크 상태에 따라 자동 분기합니다.
   */
  const handleIntervene = async (req: Request, res: Response) => {
    try {
      const agentSessionId = req.params.id as string;

      if (!agentSessionId || !VALID_ID_PATTERN.test(agentSessionId)) {
        res.status(400).json({
          error: {
            code: "INVALID_SESSION_ID",
            message: "Invalid agent session ID",
          },
        });
        return;
      }

      const body = req.body as SendMessageRequest;

      if (!body.text || typeof body.text !== "string") {
        res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: "text is required",
          },
        });
        return;
      }

      if (body.text.length > MAX_MESSAGE_LENGTH) {
        res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: `text exceeds maximum length of ${MAX_MESSAGE_LENGTH}`,
          },
        });
        return;
      }

      if (!body.user || typeof body.user !== "string") {
        res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: "user is required",
          },
        });
        return;
      }

      // Soul 서버에 intervention 전달 (Soul이 running/completed 자동 분기)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SOUL_REQUEST_TIMEOUT_MS);

      let soulResponse: globalThis.Response;
      try {
        soulResponse = await fetch(
          `${soulBaseUrl}/sessions/${encodeURIComponent(agentSessionId)}/intervene`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(authToken
                ? { Authorization: `Bearer ${authToken}` }
                : {}),
            },
            body: JSON.stringify({
              text: body.text,
              user: body.user,
              attachment_paths: body.attachmentPaths ?? [],
            }),
            signal: controller.signal,
          },
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          res.status(504).json({
            error: {
              code: "TIMEOUT",
              message: `Soul server request timed out after ${SOUL_REQUEST_TIMEOUT_MS / 1000}s`,
            },
          });
          return;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!soulResponse.ok) {
        const errorBody = await soulResponse.text();
        console.error(
          `[actions] Soul intervene failed (${soulResponse.status}):`,
          errorBody,
        );

        res.status(502).json({
          error: {
            code: "SOUL_ERROR",
            message: `Soul server returned ${soulResponse.status}`,
            details: { body: errorBody },
          },
        });
        return;
      }

      const result = await soulResponse.json();

      // 자동 resume로 새 태스크가 생성된 경우 → task→session 매핑 등록 + SoulClient 구독
      if (result.auto_resumed && result.task_key) {
        if (eventHub) {
          eventHub.registerTask(result.task_key, agentSessionId);
        }
        if (soulClient) {
          const [clientId, requestId] = result.task_key.split(":", 2);
          soulClient.subscribe(clientId, requestId);
        }
      }

      // user_message 기록은 Soul 서버가 담당 (JSONL의 유일한 기록자)

      res.json(result);
    } catch (err) {
      console.error("[actions] Failed to send message:", err);
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to send message",
        },
      });
    }
  };

  router.post("/:id/intervene", handleIntervene);
  router.post("/:id/message", handleIntervene);

  return router;
}

/**
 * 대시보드 요청용 고유 agent_session_id 생성.
 * "sess-" 접두사 + 타임스탬프 + 랜덤 4자리.
 */
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `sess-${timestamp}-${random}`;
}

/**
 * 대시보드 요청용 고유 request_id 생성.
 * "task-" 접두사 + 타임스탬프 + 랜덤 4자리.
 */
function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `task-${timestamp}-${random}`;
}
