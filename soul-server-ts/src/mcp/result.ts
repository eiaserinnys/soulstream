/**
 * MCP CallToolResult 헬퍼.
 *
 * Python `mcp_tools` 도구는 `{ok: true, ...}` 또는 `{error: "..."}` 형태의 plain dict를
 * 반환하고 FastMCP가 CallToolResult로 wrap한다. TS는 SDK가 wrap을 자동으로 하지 않으므로
 * 도구 핸들러가 직접 `CallToolResult`를 만들어 반환한다.
 *
 * 본 헬퍼는 다음 2가지 모양만 지원:
 *
 * - `jsonResult(value)` — 정상 응답. value를 JSON text + structuredContent로 모두 노출.
 * - `errorResult(message)` — 도메인 에러 (세션 미존재, 폴더 미존재 등 호출자가 복구 가능한 종류).
 *   `isError: true`로 마킹하되 throw하지 않음 (Python `{error: "..."}` 정합).
 *
 * 예기치 못한 throw는 SDK가 별도로 JSON-RPC error로 변환한다 — 본 헬퍼는 *예상된* 도메인
 * 실패만 다룬다 (design-principles §8 실패 격리, §7 경계에서만 검증).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: toStructuredContent(value),
  };
}

export function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { error: message },
  };
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return { result: value };
}
