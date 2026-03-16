/**
 * input-request-actions - AskUserQuestion 응답 제출 유틸리티
 *
 * 응답 API 호출 후 트리 노드 상태를 갱신합니다.
 */

import { useDashboardStore } from '../stores/dashboard-store';

/**
 * 사용자의 응답을 서버에 제출하고 트리 노드 상태를 갱신합니다.
 *
 * @returns 성공 시 true, 실패 시 false
 */
export async function submitInputResponse(
  sessionId: string,
  requestId: string,
  nodeId: string,
  question: string,
  answer: string
): Promise<boolean> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, answers: { [question]: answer } }),
    });
    if (!response.ok) return false;
    useDashboardStore.getState().respondToInputRequest(nodeId);
    return true;
  } catch {
    return false;
  }
}
