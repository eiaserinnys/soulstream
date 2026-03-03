/**
 * Events Cached Routes - 캐시 + 라이브 통합 이벤트 스트리밍
 *
 * GET /api/sessions/:id/events
 *
 * 흐름:
 * 1. 클라이언트 Last-Event-ID 파싱
 * 2. 캐시에서 Last-Event-ID 이후 이벤트 읽기
 * 3. 캐시된 이벤트 SSE 전송
 * 4. Soul 서버 /sessions/:id/history 연결 (Last-Event-ID = 캐시의 마지막)
 * 5. Soul에서 새 이벤트 수신 시:
 *    - 캐시에 저장
 *    - 클라이언트에 전달
 */

import { Router, type Request, type Response } from "express";
import type { SessionCache, CachedEvent } from "../session-cache.js";

export interface EventsCachedRouterOptions {
  /** Soul 서버 기본 URL (예: http://localhost:3105) */
  soulBaseUrl: string;
  /** 세션 캐시 */
  sessionCache: SessionCache;
  /** 인증 토큰 (옵션) */
  authToken?: string;
  /** 캐시 우회 모드 (진단용) */
  bypassCache?: boolean;
}

export function createEventsCachedRouter(
  options: EventsCachedRouterOptions,
): Router {
  const { soulBaseUrl, sessionCache, authToken, bypassCache } = options;
  const router = Router();

  /**
   * GET /api/sessions/:id/events
   *
   * 캐시 + 라이브 통합 SSE 스트림.
   */
  router.get("/:id/events", async (req: Request, res: Response) => {
    try {
      const agentSessionId = req.params.id as string;

      if (!agentSessionId) {
        res.status(400).json({
          error: {
            code: "INVALID_SESSION_ID",
            message: "Session ID is required",
          },
        });
        return;
      }

      // 1. 클라이언트 Last-Event-ID 파싱
      const lastEventIdHeader = req.headers["last-event-id"];
      let clientLastEventId = 0;
      if (typeof lastEventIdHeader === "string") {
        const parsed = parseInt(lastEventIdHeader, 10);
        if (!isNaN(parsed)) {
          clientLastEventId = parsed;
        }
      }

      // 2. 캐시에서 Last-Event-ID 이후 이벤트 읽기
      let cachedEvents: CachedEvent[];
      if (bypassCache) {
        cachedEvents = [];
      } else {
        try {
          cachedEvents = await sessionCache.readEvents(
            agentSessionId,
            clientLastEventId,
          );
        } catch (err) {
          console.warn(`[events-cached] Failed to read cache:`, err);
          cachedEvents = [];
        }
      }

      // 캐시의 마지막 이벤트 ID (Soul 서버에 전달할 값)
      const cacheLastEventId = bypassCache
        ? 0
        : cachedEvents.length > 0
          ? cachedEvents[cachedEvents.length - 1].id
          : clientLastEventId;

      // Soul 서버에 연결하여 새 이벤트 가져오기
      const controller = new AbortController();
      const url = new URL(
        `/sessions/${encodeURIComponent(agentSessionId)}/history`,
        soulBaseUrl,
      );
      if (cacheLastEventId > 0) {
        url.searchParams.set("last_event_id", String(cacheLastEventId));
      }

      let soulResponse: globalThis.Response;
      try {
        soulResponse = await fetch(url.toString(), {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            ...(cacheLastEventId > 0
              ? { "Last-Event-ID": String(cacheLastEventId) }
              : {}),
          },
          signal: controller.signal,
        });
      } catch (err) {
        console.error(
          "[events-cached] Failed to connect to Soul server:",
          err,
        );
        res.status(502).json({
          error: {
            code: "SOUL_CONNECTION_ERROR",
            message: "Failed to connect to Soul server SSE stream",
          },
        });
        return;
      }

      // Soul 서버 404 등 오류 처리
      if (!soulResponse.ok) {
        const contentType = soulResponse.headers.get("content-type") ?? "";

        if (contentType.includes("application/json")) {
          const errorBody = await soulResponse.json();
          res.status(soulResponse.status).json(errorBody);
        } else {
          const errorText = await soulResponse.text().catch(() => "");
          console.error(
            `[events-cached] Soul server error (${soulResponse.status}):`,
            errorText,
          );
          res.status(soulResponse.status).json({
            error: {
              code: "SOUL_ERROR",
              message: `Soul server returned ${soulResponse.status}`,
            },
          });
        }
        return;
      }

      if (!soulResponse.body) {
        res.status(502).json({
          error: {
            code: "SOUL_ERROR",
            message: "Soul server returned empty body",
          },
        });
        return;
      }

      // 3. SSE 헤더 설정
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // 클라이언트 연결 종료 시 upstream 연결도 종료
      res.on("close", () => {
        controller.abort();
      });

      // 4. 캐시된 이벤트 먼저 전송
      for (const record of cachedEvents) {
        const eventType = (record.event.type as string) ?? "unknown";
        const data = JSON.stringify(record.event);
        const sseMessage = `id: ${record.id}\nevent: ${eventType}\ndata: ${data}\n\n`;
        res.write(sseMessage);
      }

      // 5. Soul 서버에서 새 이벤트 수신 및 캐시 + 전달
      const reader = soulResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          // SSE 이벤트 파싱 및 캐시 저장
          const events = parseSSEBuffer(buffer);
          buffer = events.remaining;

          for (const event of events.parsed) {
            // 캐시에 저장 (history_sync 등 메타 이벤트는 제외)
            if (
              !bypassCache &&
              event.id !== undefined &&
              event.type !== "history_sync" &&
              event.data
            ) {
              try {
                const eventData = JSON.parse(event.data);
                await sessionCache.appendEvent(
                  agentSessionId,
                  event.id,
                  eventData,
                );
              } catch {
                // 파싱 실패 무시
              }
            }

            // 클라이언트에 전달 (원본 그대로)
            res.write(event.raw);
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("[events-cached] SSE stream error:", err);
        }
      } finally {
        if (!res.writableEnded) {
          res.end();
        }
      }
    } catch (err) {
      console.error("[events-cached] Request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: "INTERNAL_ERROR",
            message: "Failed to establish SSE stream",
          },
        });
      }
    }
  });

  return router;
}

interface ParsedSSEEvent {
  id?: number;
  type?: string;
  data?: string;
  raw: string;
}

interface ParsedSSEResult {
  parsed: ParsedSSEEvent[];
  remaining: string;
}

/**
 * SSE 버퍼에서 완전한 이벤트를 파싱합니다.
 */
function parseSSEBuffer(buffer: string): ParsedSSEResult {
  const events: ParsedSSEEvent[] = [];
  const lines = buffer.split("\n");
  let remaining = "";

  let currentEvent: ParsedSSEEvent = { raw: "" };
  let rawLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 마지막 줄이면서 줄바꿈으로 끝나지 않으면 remaining에 추가
    if (i === lines.length - 1 && !buffer.endsWith("\n")) {
      remaining = line;
      break;
    }

    rawLines.push(line);

    if (line === "") {
      // 빈 줄 = 이벤트 종료
      if (rawLines.length > 1) {
        currentEvent.raw = rawLines.join("\n") + "\n";
        events.push(currentEvent);
      }
      currentEvent = { raw: "" };
      rawLines = [];
      continue;
    }

    // 필드 파싱
    if (line.startsWith("id:")) {
      const value = line.slice(3).trim();
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed)) {
        currentEvent.id = parsed;
      }
    } else if (line.startsWith("event:")) {
      currentEvent.type = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      currentEvent.data = line.slice(5).trim();
    }
  }

  // 마지막에 남은 불완전한 이벤트가 있으면 remaining에 추가
  if (rawLines.length > 0) {
    remaining = rawLines.join("\n") + (remaining ? "\n" + remaining : "");
  }

  return { parsed: events, remaining };
}
