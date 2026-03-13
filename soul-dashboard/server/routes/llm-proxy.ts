/**
 * LLM Proxy Route - Soul Server의 LLM completions API를 프록시
 *
 * POST /api/llm/completions → Soul Server POST /llm/completions
 *
 * 대시보드 클라이언트에서 LLM 세션의 컨텍스트 누적 전송 기능을 지원합니다.
 */

import { Router } from "express";

/** 외부 API 호출 타임아웃 (밀리초) */
const LLM_REQUEST_TIMEOUT_MS = 60_000;

/** messages 배열 최대 항목 수 */
const MAX_MESSAGES = 200;

/** messages 총 content 길이 제한 (문자 수) */
const MAX_TOTAL_CONTENT_LENGTH = 500_000;

export interface LlmProxyRouterOptions {
  /** Soul 서버 기본 URL */
  soulBaseUrl: string;
  /** 인증 토큰 */
  authToken?: string;
}

/** Soul Server LlmMessage.role과 동일한 허용 값 */
const VALID_ROLES = new Set(["system", "user", "assistant"]);

/** messages 배열의 각 항목이 유효한 구조인지 검증 */
function isValidMessage(m: unknown): m is { role: string; content: string } {
  if (typeof m !== "object" || m === null) return false;
  const r = m as Record<string, unknown>;
  return (
    typeof r.role === "string" &&
    VALID_ROLES.has(r.role) &&
    typeof r.content === "string"
  );
}

export function createLlmProxyRouter(options: LlmProxyRouterOptions): Router {
  const { soulBaseUrl, authToken } = options;
  const router = Router();

  /**
   * POST /api/llm/completions
   *
   * Soul Server의 POST /llm/completions로 프록시합니다.
   * Authorization 헤더를 포워딩합니다.
   *
   * 보안: 허용된 필드만 화이트리스트로 전달합니다.
   */
  router.post("/completions", async (req, res) => {
    try {
      const body = req.body;

      // 필수 필드 타입 검증
      if (
        typeof body.provider !== "string" || !body.provider ||
        typeof body.model !== "string" || !body.model ||
        !Array.isArray(body.messages) ||
        body.messages.length === 0
      ) {
        res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: "provider (string), model (string), and messages (non-empty array) are required",
          },
        });
        return;
      }

      // messages 배열 구조 검증
      if (!body.messages.every(isValidMessage)) {
        res.status(400).json({
          error: {
            code: "INVALID_REQUEST",
            message: "Each message must have a string 'role' and 'content'",
          },
        });
        return;
      }

      // 크기 제한 검증
      if (body.messages.length > MAX_MESSAGES) {
        res.status(400).json({
          error: {
            code: "TOO_MANY_MESSAGES",
            message: `Messages array exceeds maximum of ${MAX_MESSAGES} items`,
          },
        });
        return;
      }

      const totalLength = body.messages.reduce(
        (sum: number, m: { content: string }) => sum + m.content.length,
        0,
      );
      if (totalLength > MAX_TOTAL_CONTENT_LENGTH) {
        res.status(400).json({
          error: {
            code: "CONTENT_TOO_LARGE",
            message: `Total content length exceeds maximum of ${MAX_TOTAL_CONTENT_LENGTH} characters`,
          },
        });
        return;
      }

      // 화이트리스트 전달: 허용된 필드만 추출
      const sanitizedBody = {
        provider: body.provider,
        model: body.model,
        messages: body.messages.map((m: { role: string; content: string }) => ({
          role: m.role,
          content: m.content,
        })),
        ...(body.client_id && typeof body.client_id === "string"
          ? { client_id: body.client_id }
          : {}),
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);

      let soulResponse: globalThis.Response;
      try {
        soulResponse = await fetch(`${soulBaseUrl}/llm/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify(sanitizedBody),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          res.status(504).json({
            error: {
              code: "TIMEOUT",
              message: `LLM request timed out after ${LLM_REQUEST_TIMEOUT_MS / 1000}s`,
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
          `[llm-proxy] Soul LLM completions failed (${soulResponse.status}):`,
          errorBody,
        );
        res.status(soulResponse.status).json({
          error: {
            code: "SOUL_ERROR",
            message: `Soul server returned ${soulResponse.status}`,
            details: { body: errorBody },
          },
        });
        return;
      }

      const result = await soulResponse.json();
      res.json(result);
    } catch (err) {
      console.error("[llm-proxy] Failed to proxy LLM completions:", err);
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to proxy LLM completions",
        },
      });
    }
  });

  return router;
}
