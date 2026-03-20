/**
 * input-request-actions - AskUserQuestion 응답 제출 유틸리티
 *
 * 응답 API를 호출합니다. 트리 노드 상태 갱신은 서버에서 돌아오는 SSE 이벤트가 처리합니다.
 */

import { useDashboardStore } from '../stores/dashboard-store';

/**
 * 사용자의 응답을 서버에 제출합니다.
 * 상태 갱신은 서버가 발행하는 input_request_responded SSE 이벤트가 처리합니다.
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
    const node = useDashboardStore.getState().processingCtx?.nodeMap?.get(nodeId);
    if (node?.type === "input_request" && (node as any).responded) {
      return false; // 이미 응답됨
    }
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, answers: { [question]: answer } }),
    });
    if (!response.ok) return false;
    // 상태 갱신은 SSE로 돌아오는 input_request_responded 이벤트가 처리한다.
    return true;
  } catch {
    return false;
  }
}
