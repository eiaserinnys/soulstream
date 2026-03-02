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
  CreateSessionResponse,
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

/**
 * Soul POST /execute의 SSE 응답에서 init 이벤트를 읽어 agent_session_id를 추출합니다.
 *
 * SSE 형식:
 *   event: init
 *   data: {"type": "init", "agent_session_id": "sess-..."}
 */
async function readInitEvent(
  response: globalThis.Response,
): Promise<string> {
  if (!response.body) {
    throw new Error("No response body from Soul server");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE stream ended before init event");

      buffer += decoder.decode(value, { stream: true });

      // SSE 이벤트는 빈 줄(\n\n)로 구분됨
      const eventEnd = buffer.indexOf("\n\n");
      if (eventEnd === -1) continue;

      const eventBlock = buffer.substring(0, eventEnd);
      const lines = eventBlock.split("\n");

      let data = "";
      for (const line of lines) {
        if (line.startsWith("data: ")) data = line.substring(6);
      }

      if (data) {
        const parsed = JSON.parse(data);
        if (parsed.type === "init" && parsed.agent_session_id) {
          return parsed.agent_session_id;
        }
      }

      // init이 아니면 다음 이벤트 블록으로
      buffer = buffer.substring(eventEnd + 2);
    }
  } finally {
    reader.cancel();
  }
}

export function createActionsRouter(options: ActionsRouterOptions): Router {
  const { soulBaseUrl, authToken, eventHub, sessionStore, soulClient } = options;
  const router = Router();

  /**
   * POST /api/sessions
   *
   * 대시보드에서 새 Claude Code 세션을 시작합니다.
   * Soul 서버가 agent_session_id를 생성하여 init SSE 이벤트로 전달합니다.
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

      // Soul 서버에 실행 요청 (SSE 응답)
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
            prompt: body.prompt,
            // resume 시 기존 agent_session_id 전달 (없으면 서버가 생성)
            ...(body.agentSessionId ? { agent_session_id: body.agentSessionId } : {}),
            use_mcp: true,
          }),
          signal: controller.signal,
        });
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
        console.error(`[actions] Soul execute failed (${soulResponse.status}):`, errorBody);
        res.status(502).json({
          error: {
            code: "SOUL_ERROR",
            message: `Soul server returned ${soulResponse.status}`,
            details: { body: errorBody },
          },
        });
        return;
      }

      // SSE init 이벤트에서 agent_session_id 추출
      let agentSessionId: string;
      try {
        agentSessionId = await readInitEvent(soulResponse);
      } catch (err) {
        console.error("[actions] Failed to read init event:", err);
        res.status(502).json({
          error: {
            code: "SOUL_ERROR",
            message: "Failed to read session ID from Soul server",
          },
        });
        return;
      }

      // SoulClient가 이 세션의 이벤트를 구독 (GET /events/{id}/stream)
      if (soulClient) {
        soulClient.subscribe(agentSessionId);
      }

      const response: CreateSessionResponse = {
        agentSessionId,
        status: "running",
      };
      res.status(201).json(response);
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

      // 자동 resume 시 SoulClient가 세션 이벤트를 다시 구독
      if (result.auto_resumed && soulClient) {
        soulClient.subscribe(agentSessionId);
      }

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
