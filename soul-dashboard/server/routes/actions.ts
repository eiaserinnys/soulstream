/**
 * Actions Routes - 세션 생성, 재개, 개입 API
 *
 * POST /api/sessions                  - 새 세션 생성 (Soul에 실행 요청)
 * POST /api/sessions/:id/resume       - 완료된 세션을 이어서 대화
 * POST /api/sessions/:id/intervene    - 실행 중인 세션에 개입 메시지 전송
 * POST /api/sessions/:id/message      - intervene의 레거시 호환 경로
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type {
  CreateSessionRequest,
  SendMessageRequest,
  UserMessageEvent,
} from "../../shared/types.js";
import type { EventHub } from "../event-hub.js";
import type { SessionStore } from "../session-store.js";
import { parseSessionId } from "../utils/parse-session-id.js";

const MAX_PROMPT_LENGTH = 100_000;
const MAX_MESSAGE_LENGTH = 50_000;

export interface ActionsRouterOptions {
  /** Soul 서버 기본 URL */
  soulBaseUrl: string;
  /** 인증 토큰 */
  authToken?: string;
  /** EventHub 인스턴스 (user_message 브로드캐스트용) */
  eventHub?: EventHub;
  /** SessionStore 인스턴스 (user_message JSONL persist용) */
  sessionStore?: SessionStore;
  /** SoulClient 인스턴스 (resume 시 새 세션 구독용) */
  soulClient?: import("../soul-client.js").SoulClient;
}

/**
 * Soul /execute 엔드포인트에 프록시 요청을 보내고
 * user_message를 브로드캐스트 + persist하는 공통 로직.
 */
async function executeSoul(opts: {
  soulBaseUrl: string;
  authToken?: string;
  clientId: string;
  requestId: string;
  prompt: string;
  resumeSessionId?: string;
  eventHub?: EventHub;
  sessionStore?: SessionStore;
}): Promise<
  | { ok: true; sessionKey: string }
  | { ok: false; status: number; error: { code: string; message: string; details?: unknown } }
> {
  const { soulBaseUrl, authToken, clientId, requestId, prompt, resumeSessionId, eventHub, sessionStore } = opts;

  const soulResponse = await fetch(`${soulBaseUrl}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify({
      client_id: clientId,
      request_id: requestId,
      prompt,
      resume_session_id: resumeSessionId ?? null,
      use_mcp: true,
    }),
  });

  if (!soulResponse.ok) {
    const errorBody = await soulResponse.text();
    console.error(`[actions] Soul execute failed (${soulResponse.status}):`, errorBody);
    return {
      ok: false,
      status: 502,
      error: {
        code: "SOUL_ERROR",
        message: `Soul server returned ${soulResponse.status}`,
        details: { body: errorBody },
      },
    };
  }

  // Soul이 SSE 스트림을 반환하지만, 대시보드에서는 세션 정보만 반환
  // 클라이언트는 별도로 /api/sessions/:id/events에 SSE 연결
  if (soulResponse.body) {
    await soulResponse.body.cancel();
  }

  const sessionKey = `${clientId}:${requestId}`;

  // user_message 이벤트 브로드캐스트 + JSONL persist
  const userMessageEvent: UserMessageEvent = {
    type: "user_message",
    user: clientId,
    text: prompt,
  };

  if (eventHub) {
    eventHub.broadcast(sessionKey, 0, userMessageEvent);
  }

  if (sessionStore) {
    sessionStore
      .appendEvent(
        clientId,
        requestId,
        0,
        userMessageEvent as unknown as Record<string, unknown>,
      )
      .catch((err) => {
        console.warn(`[actions] Failed to persist user_message for ${sessionKey}:`, err);
      });
  }

  return { ok: true, sessionKey };
}

export function createActionsRouter(options: ActionsRouterOptions): Router {
  const { soulBaseUrl, authToken, eventHub, sessionStore, soulClient } = options;
  const router = Router();

  /**
   * POST /api/sessions
   *
   * 대시보드에서 새 Claude Code 세션을 시작합니다.
   * Soul 서버의 /execute 엔드포인트에 요청을 프록시합니다.
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

      const result = await executeSoul({
        soulBaseUrl,
        authToken,
        clientId,
        requestId,
        prompt: body.prompt,
        resumeSessionId: body.resumeSessionId ?? undefined,
        eventHub,
        sessionStore,
      });

      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }

      res.status(201).json({
        clientId,
        requestId,
        sessionKey: result.sessionKey,
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
   * POST /api/sessions/:id/resume
   *
   * 완료된 세션을 이어서 대화합니다.
   * 기존 세션의 claude_session_id를 찾아 resume_session_id로 전달하여
   * 새 세션을 생성합니다.
   */
  router.post("/:id/resume", async (req, res) => {
    try {
      const { clientId: origClientId, requestId: origRequestId } =
        parseSessionId(
          req.params.id,
          req.query as Record<string, string>,
        );

      if (!origClientId || !origRequestId) {
        res.status(400).json({
          error: {
            code: "INVALID_SESSION_ID",
            message:
              'Session ID format: "clientId:requestId" or use ?clientId=...&requestId=...',
          },
        });
        return;
      }

      const body = req.body as { prompt: string; clientId?: string };

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

      // 기존 세션에서 claude_session_id 찾기
      if (!sessionStore) {
        res.status(500).json({
          error: {
            code: "INTERNAL_ERROR",
            message: "SessionStore not available",
          },
        });
        return;
      }

      const events = await sessionStore.readEvents(origClientId, origRequestId);

      // 이벤트가 없으면 세션이 존재하지 않음
      if (events.length === 0) {
        res.status(404).json({
          error: {
            code: "SESSION_NOT_FOUND",
            message: `No events found for ${origClientId}:${origRequestId}`,
          },
        });
        return;
      }

      let claudeSessionId: string | undefined;
      let lastEventType: string | undefined;
      for (const record of events) {
        // session 이벤트에서 session_id 추출 (우선)
        if (record.event.type === "session" && typeof record.event.session_id === "string") {
          claudeSessionId = record.event.session_id;
        }
        // complete 이벤트에도 claude_session_id가 있을 수 있음 (fallback)
        if (
          record.event.type === "complete" &&
          typeof record.event.claude_session_id === "string" &&
          !claudeSessionId
        ) {
          claudeSessionId = record.event.claude_session_id;
        }
        if (typeof record.event.type === "string") {
          lastEventType = record.event.type;
        }
      }

      // 실행 중인 세션은 재개할 수 없음
      if (lastEventType !== "complete" && lastEventType !== "error" && lastEventType !== "result") {
        res.status(409).json({
          error: {
            code: "SESSION_STILL_RUNNING",
            message: `Cannot resume a session that is still running (last event: ${lastEventType ?? "unknown"})`,
          },
        });
        return;
      }

      if (!claudeSessionId) {
        res.status(404).json({
          error: {
            code: "SESSION_NOT_FOUND",
            message: `No claude_session_id found for ${origClientId}:${origRequestId}`,
          },
        });
        return;
      }

      // resume에 soulClient가 필수 (새 세션 SSE 구독 필요)
      if (!soulClient) {
        res.status(500).json({
          error: {
            code: "INTERNAL_ERROR",
            message: "SoulClient not available for resume",
          },
        });
        return;
      }

      // 원래 세션에 이어지도록 처리:
      // Soul 서버에는 새 requestId로 요청하되 (이벤트 ID 충돌 방지),
      // 대시보드에는 원래 세션으로 이벤트가 포워딩됨
      const origSessionKey = `${origClientId}:${origRequestId}`;
      const newRequestId = generateRequestId();
      const newSessionKey = `${origClientId}:${newRequestId}`;

      // 원래 세션의 최대 이벤트 ID 계산 (offset 기준)
      const maxEventId = events.reduce((max, ev) => Math.max(max, ev.id), 0);
      const eventIdOffset = maxEventId + 1;

      // user_message를 원래 세션에 직접 추가 (offset ID 적용)
      const userMessageEvent: UserMessageEvent = {
        type: "user_message",
        user: origClientId,
        text: body.prompt,
      };

      if (eventHub) {
        eventHub.broadcast(origSessionKey, eventIdOffset, userMessageEvent);
        // 새 세션 → 원래 세션으로의 이벤트 포워딩 alias 등록
        eventHub.addAlias(newSessionKey, origSessionKey, eventIdOffset + 1);
      }

      if (sessionStore) {
        sessionStore
          .appendEvent(origClientId, origRequestId, eventIdOffset, userMessageEvent)
          .catch((err) => {
            console.warn(`[actions] Failed to persist resume user_message for ${origSessionKey}:`, err);
          });
      }

      // alias와 subscribe를 fetch 전에 등록하여 이벤트 유실 방지
      soulClient.subscribe(origClientId, newRequestId);

      // Soul 서버에 새 태스크로 요청
      const soulResponse = await fetch(`${soulBaseUrl}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          client_id: origClientId,
          request_id: newRequestId,
          prompt: body.prompt,
          resume_session_id: claudeSessionId,
          use_mcp: true,
        }),
      });

      if (!soulResponse.ok) {
        const errorBody = await soulResponse.text();
        console.error(`[actions] Soul execute failed (${soulResponse.status}):`, errorBody);
        // 실패 시 alias와 subscription 정리
        if (eventHub) eventHub.removeAlias(newSessionKey);
        soulClient.unsubscribe(origClientId, newRequestId);
        res.status(502).json({
          error: {
            code: "SOUL_ERROR",
            message: `Soul server returned ${soulResponse.status}`,
            details: { body: errorBody },
          },
        });
        return;
      }

      if (soulResponse.body) {
        await soulResponse.body.cancel();
      }

      res.status(201).json({
        sessionKey: origSessionKey,
        resumedFrom: origSessionKey,
        resumeSessionId: claudeSessionId,
        status: "running",
      });
    } catch (err) {
      console.error("[actions] Failed to resume session:", err);
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to resume session",
        },
      });
    }
  });

  /**
   * POST /api/sessions/:id/intervene
   * POST /api/sessions/:id/message (레거시 호환)
   *
   * 실행 중인 세션에 개입 메시지를 전송합니다.
   */
  const handleIntervene = async (req: Request, res: Response) => {
    try {
      const { clientId, requestId } = parseSessionId(
        req.params.id as string,
        req.query as Record<string, string>,
      );

      if (!clientId || !requestId) {
        res.status(400).json({
          error: {
            code: "INVALID_SESSION_ID",
            message:
              'Session ID format: "clientId:requestId" or use ?clientId=...&requestId=...',
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

      const soulResponse = await fetch(
        `${soulBaseUrl}/tasks/${encodeURIComponent(clientId)}/${encodeURIComponent(requestId)}/intervene`,
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
        },
      );

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

      // 개입 메시지를 JSONL에 persist (히스토리 재생 시 유실 방지)
      // eventId 0: Soul SSE 이벤트의 단조증가 ID와 별개이며,
      // intervention_sent 이벤트가 Soul에서 적절한 ID로 오므로 재생에 영향 없음.
      // Date.now()를 사용하면 resume 시 maxEventId가 왜곡되므로 사용하지 않음.
      if (sessionStore) {
        const interventionEvent = {
          type: "user_message",
          user: body.user,
          text: body.text,
        };
        sessionStore
          .appendEvent(
            clientId,
            requestId,
            0,
            interventionEvent,
          )
          .catch((err) => {
            console.warn(
              `[actions] Failed to persist intervention for ${clientId}:${requestId}:`,
              err,
            );
          });
      }

      const result = await soulResponse.json();
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
 * 대시보드 요청용 고유 request_id 생성.
 * "dash-" 접두사 + 타임스탬프 + 랜덤 4자리.
 */
function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 6);
  return `dash-${timestamp}-${random}`;
}
