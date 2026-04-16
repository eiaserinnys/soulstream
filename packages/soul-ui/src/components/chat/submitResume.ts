/**
 * submitResume — 완료(completed) 또는 오류(error) 상태의 Claude 세션에
 * 새 메시지를 보내 대화를 이어간다 ("New Chat" 모드).
 *
 * 현재 백엔드는 running 세션 개입과 완료 세션 resume을 동일한
 * `POST /api/sessions/{sessionId}/intervene` 엔드포인트로 처리한다.
 * 세션 상태 판정은 서버가 수행하므로, 클라이언트는 동일 호출을 재사용한다.
 *
 * 별도 전략 함수로 둔 이유:
 *   1) 호출 지점의 의미(개입 vs 재개)를 명시적으로 분리한다.
 *   2) 향후 resume 전용 엔드포인트로 백엔드가 분기될 때 이 파일만 교체한다.
 *
 * 동작 — 네트워크, React Query 갱신 모두 submitIntervention과 동일하다.
 */

import {
  submitIntervention,
  type SubmitInterventionContext,
  type SubmitInterventionResult,
} from "./submitIntervention";

export type SubmitResumeContext = SubmitInterventionContext;
export type SubmitResumeResult = SubmitInterventionResult;

export async function submitResume(
  ctx: SubmitResumeContext,
): Promise<SubmitResumeResult> {
  return submitIntervention(ctx);
}
