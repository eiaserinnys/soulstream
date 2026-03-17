/**
 * Sessions Proxy Routes - Soul Server를 프록시하는 라우터
 *
 * Dashboard Server가 파일을 직접 읽지 않고 Soul Server API를 프록시합니다.
 *
 * GET /api/sessions              → Soul GET /sessions
 * GET /api/sessions/stream       → Soul GET /sessions/stream (SSE)
 *
 * Note: GET /api/sessions/:id/events는 events-cached.ts에서 처리합니다.
 */

import { Router, type Request, type Response } from "express";

export interface SessionsProxyRouterOptions {
  /** Soul 서버 기본 URL (예: http://localhost:3105) */
  soulBaseUrl: string;
  /** 인증 토큰 (옵션) */
  authToken?: string;
}

/** 외부 API 호출 타임아웃 (밀리초) */
const SOUL_REQUEST_TIMEOUT_MS = 30_000;

export function createSessionsProxyRouter(
  options: SessionsProxyRouterOptions,
): Router {
  const { soulBaseUrl, authToken } = options;
  const router = Router();

  /**
   * GET /api/sessions
   *
   * Soul Server의 /sessions를 프록시합니다.
   */
  router.get("/", async (req: Request, res: Response) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        SOUL_REQUEST_TIMEOUT_MS,
      );

      // 쿼리 파라미터를 upstream URL에 전달
      const queryString = new URLSearchParams(
        req.query as Record<string, string>,
      ).toString();
      const url = queryString
        ? `${soulBaseUrl}/sessions?${queryString}`
        : `${soulBaseUrl}/sessions`;

      let soulResponse: globalThis.Response;
      try {
        soulResponse = await fetch(url, {
          method: "GET",
          headers: {
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          res.status(504).json({
            error: {
              code: "TIMEOUT",
              message: "Soul server request timed out",
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
          `[sessions-proxy] Soul GET /sessions failed (${soulResponse.status}):`,
          errorBody,
        );
        res.status(soulResponse.status).json({
          error: {
            code: "SOUL_ERROR",
            message: `Soul server returned ${soulResponse.status}`,
          },
        });
        return;
      }

      const data = await soulResponse.json();
      res.json(data);
    } catch (err) {
      console.error("[sessions-proxy] Failed to proxy GET /sessions:", err);
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to fetch sessions",
        },
      });
    }
  });

  /**
   * GET /api/sessions/stream
   *
   * Soul Server의 /sessions/stream SSE를 프록시합니다.
   */
  router.get("/stream", async (_req: Request, res: Response) => {
    try {
      const controller = new AbortController();

      // SSE 헤더를 먼저 전송하여, soul-server 연결 실패 시에도
      // 브라우저 EventSource가 자동 재연결을 유지하도록 합니다.
      // (200 + text/event-stream이 아닌 응답은 EventSource를 CLOSED로 만들어 재연결이 중단됨)
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let soulResponse: globalThis.Response;
      try {
        soulResponse = await fetch(`${soulBaseUrl}/sessions/stream`, {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          signal: controller.signal,
        });
      } catch (err) {
        console.error("[sessions-proxy] Failed to connect to SSE stream:", err);
        // SSE 포맷으로 에러 전달 후 연결 종료 → 브라우저가 자동 재연결
        res.write("retry: 3000\nevent: error\ndata: {\"message\":\"Soul server unavailable\"}\n\n");
        res.end();
        return;
      }

      if (!soulResponse.ok || !soulResponse.body) {
        const errorBody = await soulResponse.text().catch(() => "");
        console.error(
          `[sessions-proxy] Soul GET /sessions/stream failed (${soulResponse.status}):`,
          errorBody,
        );
        res.write(`retry: 3000\nevent: error\ndata: ${JSON.stringify({message: `Soul server returned ${soulResponse.status}`})}\n\n`);
        res.end();
        return;
      }

      // 클라이언트 연결 종료 시 upstream 연결도 종료
      res.on("close", () => {
        controller.abort();
      });

      // SSE 스트림 파이프
      const reader = soulResponse.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);
        }
      } catch (err) {
        // 클라이언트 연결 종료 또는 upstream 오류
        if ((err as Error).name !== "AbortError") {
          console.error("[sessions-proxy] SSE stream error:", err);
        }
      } finally {
        if (!res.writableEnded) {
          res.end();
        }
      }
    } catch (err) {
      console.error(
        "[sessions-proxy] Failed to proxy GET /sessions/stream:",
        err,
      );
      if (!res.writableEnded) {
        if (!res.headersSent) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
        }
        res.write("retry: 3000\nevent: error\ndata: {\"message\":\"Internal proxy error\"}\n\n");
        res.end();
      }
    }
  });

  return router;
}
