/**
 * input-request-actions - AskUserQuestion 응답 제출 유틸리티
 *
 * 응답 API를 호출합니다. 트리 노드 상태 갱신은 서버에서 돌아오는 SSE 이벤트가 처리합니다.
 */

import { isInputResponseAlreadyHandled } from './action-failure';
import { useDashboardStore } from '../stores/dashboard-store';

export const INPUT_RESPONSE_ERROR_MESSAGE =
  '응답 전송에 실패했습니다. 다시 시도해 주세요.';

/** 사용자가 누른 동작의 제출 결과. 성공·이미 처리됨·실패를 구분한다. */
export type ActionSubmitResult =
  | { sent: true }
  /** 이미 처리된 요청이라 보낼 필요가 없다. 사용자에게 실패를 알리지 않는다. */
  | { sent: false; reason: "already_resolved" }
  /** 전송 자체가 실패했다. 사용자에게 이유를 알린다. */
  | { sent: false; reason: "failed"; status?: number; body?: string };

/** 도구 승인 제출 결과. 기존 이름을 유지한다. */
export type ToolApprovalResult = ActionSubmitResult;

/** 입력 요청 응답 제출 결과. */
export type InputResponseResult = ActionSubmitResult;

/**
 * 사용자의 응답을 서버에 제출합니다.
 * 상태 갱신은 서버가 발행하는 input_request_responded SSE 이벤트가 처리합니다.
 *
 * 로컬에서 이미 responded인 요청과 422의 INPUT_REQUEST_ALREADY_RESPONDED,
 * REQUEST_NOT_PENDING, INPUT_REQUEST_EXPIRED는 already_resolved로 구분한다.
 */
export async function submitInputResponse(
  sessionId: string,
  requestId: string,
  nodeId: string,
  question: string,
  answer: string
): Promise<InputResponseResult> {
  try {
    const node = useDashboardStore.getState().processingCtx?.nodeMap?.get(nodeId);
    if (node?.type === "input_request" && (node as any).responded) {
      return { sent: false, reason: "already_resolved" }; // 이미 응답됨
    }
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, answers: { [question]: answer } }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error('AskUserQuestion response submission failed', {
        sessionId,
        nodeId,
        status: response.status,
      });
      if (isInputResponseAlreadyHandled({ status: response.status, body })) {
        return { sent: false, reason: "already_resolved" };
      }
      return { sent: false, reason: "failed", status: response.status, body };
    }
    // 상태 갱신은 SSE로 돌아오는 input_request_responded 이벤트가 처리한다.
    return { sent: true };
  } catch (error) {
    console.error('AskUserQuestion response submission failed', {
      sessionId,
      nodeId,
      error,
    });
    return { sent: false, reason: "failed" };
  }
}

export async function submitToolApproval(
  sessionId: string,
  approvalId: string,
  nodeId: string,
  decision: "approved" | "rejected",
  message?: string,
): Promise<ToolApprovalResult> {
  try {
    const node = useDashboardStore.getState().processingCtx?.nodeMap?.get(nodeId);
    if (node?.type === "tool_approval" && (node as any).resolved) {
      return { sent: false, reason: "already_resolved" };
    }
    const action = decision === "approved" ? "approve" : "reject";
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/tool-approvals/${encodeURIComponent(approvalId)}/${action}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message ? { message } : {}),
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("Tool approval submission failed", {
        sessionId,
        nodeId,
        status: response.status,
      });
      return { sent: false, reason: "failed", status: response.status, body };
    }
    return { sent: true };
  } catch (error) {
    console.error("Tool approval submission failed", {
      sessionId,
      nodeId,
      error,
    });
    return { sent: false, reason: "failed" };
  }
}
