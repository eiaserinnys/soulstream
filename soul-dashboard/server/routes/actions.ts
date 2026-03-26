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
  SendRespondRequest,
} from "../../shared/types.js";

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
}

/**
 * Soul POST /execute의 SSE 응답에서 init 이벤트를 읽어 agent_session_id를 추출합니다.
 *
 * SSE 형식:
 *   event: init
 *   data: {"type": "init", "agent_session_id": "sess-..."}
 */
interface InitEventData {
  agentSessionId: string;
  nodeId?: string;
}

async function readInitEvent(
  response: globalThis.Response,
): Promise<InitEventData> {
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

      // SSE 스펙: CR, LF, CRLF 모두 줄 종료로 인정
      // sse_starlette는 기본적으로 \r\n을 사용하므로 \n으로 정규화
      // (parseSSEBuffer()와 동일한 정규화 전략)
      const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      const eventEnd = normalized.indexOf("\n\n");
      if (eventEnd === -1) continue;

      const eventBlock = normalized.substring(0, eventEnd);
      const lines = eventBlock.split("\n");

      let data = "";
      for (const line of lines) {
        if (line.startsWith("data: ")) data = line.substring(6);
      }

      if (data) {
        const parsed = JSON.parse(data);
        if (parsed.type === "init" && parsed.agent_session_id) {
          return {
            agentSessionId: parsed.agent_session_id,
            nodeId: parsed.node_id ?? undefined,
          };
        }
      }

      // init이 아니면 다음 이벤트 블록으로
      buffer = normalized.substring(eventEnd + 2);
    }
  } finally {
    // init 이벤트만 필요하므로 나머지 SSE 스트림은 의도적으로 취소합니다.
    // Soul 서버는 클라이언트 연결 종료를 gracefully 처리합니다.
    reader.cancel();
  }
}

export function createActionsRouter(options: ActionsRouterOptions): Router {
  const { soulBaseUrl, authToken } = options;
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
            ...(body.folderId ? { folder_id: body.folderId } : {}),
            ...(body.profile ? { profile: body.profile } : {}),
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

      // SSE init 이벤트에서 agent_session_id + node_id 추출
      let initData: InitEventData;
      try {
        initData = await readInitEvent(soulResponse);
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

      const agentSessionId = initData.agentSessionId;

      // 프록시 아키텍처에서는 대시보드가 세션을 직접 구독하지 않음
      // 대시보드 클라이언트가 /api/sessions/:id/events로 직접 구독

      const response: CreateSessionResponse = {
        agentSessionId,
        status: "running",
        ...(initData.nodeId ? { nodeId: initData.nodeId } : {}),
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

      // 프록시 아키텍처에서는 대시보드가 세션을 직접 구독하지 않음
      // 대시보드 클라이언트가 /api/sessions/:id/events로 직접 구독

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

  /**
   * POST /api/sessions/:id/respond
   *
   * AskUserQuestion에 대한 사용자 응답을 Soul 서버에 전달합니다.
   */
  router.post("/:id/respond", async (req, res) => {
    try {
      const agentSessionId = req.params.id as string;

      if (!agentSessionId || !VALID_ID_PATTERN.test(agentSessionId)) {
        res.status(400).json({
          error: { code: "INVALID_SESSION_ID", message: "Invalid agent session ID" },
        });
        return;
      }

      const body = req.body as SendRespondRequest;

      if (!body.requestId || typeof body.requestId !== "string" || !VALID_ID_PATTERN.test(body.requestId)) {
        res.status(400).json({
          error: { code: "INVALID_REQUEST", message: "requestId is required and must match [a-zA-Z0-9_-]{1,100}" },
        });
        return;
      }

      if (!body.answers || typeof body.answers !== "object") {
        res.status(400).json({
          error: { code: "INVALID_REQUEST", message: "answers is required" },
        });
        return;
      }

      // answers 값 검증: 키와 값이 문자열이고 합리적 길이
      const answerEntries = Object.entries(body.answers);
      if (answerEntries.length === 0 || answerEntries.length > 50) {
        res.status(400).json({
          error: { code: "INVALID_REQUEST", message: "answers must have 1-50 entries" },
        });
        return;
      }

      for (const [key, value] of answerEntries) {
        if (typeof key !== "string" || typeof value !== "string") {
          res.status(400).json({
            error: { code: "INVALID_REQUEST", message: "answer keys and values must be strings" },
          });
          return;
        }
        if (key.length > 1000 || value.length > 1000) {
          res.status(400).json({
            error: { code: "INVALID_REQUEST", message: "answer key/value too long (max 1000 chars)" },
          });
          return;
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SOUL_REQUEST_TIMEOUT_MS);

      let soulResponse: globalThis.Response;
      try {
        soulResponse = await fetch(
          `${soulBaseUrl}/sessions/${encodeURIComponent(agentSessionId)}/respond`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body: JSON.stringify({
              request_id: body.requestId,
              answers: body.answers,
            }),
            signal: controller.signal,
          },
        );
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          res.status(504).json({
            error: { code: "TIMEOUT", message: `Soul server request timed out after ${SOUL_REQUEST_TIMEOUT_MS / 1000}s` },
          });
          return;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!soulResponse.ok) {
        const errorBody = await soulResponse.text();
        console.error(`[actions] Soul respond failed (${soulResponse.status}):`, errorBody);
        res.status(502).json({
          error: { code: "SOUL_ERROR", message: `Soul server returned ${soulResponse.status}`, details: { body: errorBody } },
        });
        return;
      }

      const result = await soulResponse.json();
      res.json(result);
    } catch (err) {
      console.error("[actions] Failed to respond:", err);
      res.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Failed to respond" },
      });
    }
  });

  return router;
}
