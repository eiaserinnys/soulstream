/**
 * 세션 ID 파싱 유틸리티
 *
 * agentSessionId 전환 이후로 파싱이 단순화됨.
 * URL 파라미터에서 agentSessionId를 그대로 반환합니다.
 *
 * @deprecated agentSessionId 전환 후 이 유틸은 불필요.
 * req.params.id를 직접 사용하세요.
 */

/**
 * 세션 ID를 agentSessionId로 반환합니다.
 */
export function parseSessionId(
  idParam: string,
  _query: Record<string, string>,
): { agentSessionId?: string } {
  const decoded = decodeURIComponent(idParam);
  if (decoded) {
    return { agentSessionId: decoded };
  }
  return {};
}
