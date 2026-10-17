/**
 * submit 전략 공통 에러 유틸리티.
 *
 * 서버 응답의 detail/error 필드에서 사용자에게 표시할 메시지를 추출한다.
 * 서버가 detail을 객체로 반환하는 경우(예: node_mismatch)를 처리한다.
 */

export function extractErrorMessage(
  body: Record<string, unknown>,
  status: number,
): string {
  const detail = body.detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.message === "string") return d.message;
    const nested = d.error;
    if (typeof nested === "string") return nested;
    if (nested && typeof nested === "object") {
      const nestedMessage = (nested as Record<string, unknown>).message;
      if (typeof nestedMessage === "string") return nestedMessage;
    }
    return JSON.stringify(detail);
  }
  const errMsg = body.error;
  if (errMsg && typeof errMsg === "object") {
    return ((errMsg as Record<string, unknown>).message ??
      JSON.stringify(errMsg)) as string;
  }
  if (typeof errMsg === "string") return errMsg;
  return `HTTP ${status}`;
}
