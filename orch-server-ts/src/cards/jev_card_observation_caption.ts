import type { JevCardObservation } from '../../../../packages/wire-schema/src/card_observation.js';
import type { CardObservationJob } from './jev_card_observation_pipeline.js';
import type { ObservationInput, ObservationOutcome } from './jev_card_observation.js';
const LABELS = {
  ready_for_review: '완료 가능 — 사용자 확인을 받을 수 있는 상태로 분류',
  waiting: '위임 대기 — 다른 작업 결과를 기다리는 상태로 분류',
  blocked: '막힘 — 진행에 필요한 조건이 부족한 상태로 분류',
  in_progress: '진행 중 — 남은 작업이 있는 상태로 분류',
  unrelated: '무관 — 이번 대화가 카드 작업과 관계없는 것으로 분류',
  unknown: '판단 불가 — 관측 범위가 부족해 분류를 보류',
};
const FAILURE_LABELS: Record<string, string> = {
  credential_unavailable: '인증 정보를 사용할 수 없어 평가하지 못함',
  input_limit: '입력 범위 제한으로 평가하지 못함', timeout: '응답 시간 초과로 평가하지 못함',
  error: '평가 요청 실패', invalid_response: '유효한 분류 결과가 없음', reserved: '평가 요청 기록만 있고 결과는 아직 없음',
};
export function observationPayload(job: CardObservationJob, input: ObservationInput, outcome: ObservationOutcome,
  phase: JevCardObservation['phase'] = 'result'): JevCardObservation {
  const lines = outcome.status === 'evaluated'
    ? outcome.cards.map(c => `${outcome.cards.length > 1 ? `${c.title} · ` : ''}${c.providerChoice === 'ready_for_review' ? '완료 가능 · 관측 범위 제한' : LABELS[c.classification]}`)
    : [`미평가 — ${FAILURE_LABELS[outcome.reason ?? 'error'] ?? '평가 결과 없음'}`];
  if (input.scope.omittedCards) lines.push(`미평가 ${input.scope.omittedCards}개 — 카드 수 제한`);
  return { type: 'debug', kind: 'jev_card_observation', timestamp: Date.now() / 1_000,
    complete_event_id: job.completeEventId, final_response_event_id: job.finalResponseEventId,
    phase, content: `Jev · ${lines.join('\nJev · ')}`, captured_at: job.capturedAt, outcome,
    scope: { ...input.scope, preparedObservations: input.startObservations.map(s => ({ eventId: s.eventId,
      source: s.source, capturedAt: s.capturedAt, registrationId: s.registrationId, executionCommandId: s.executionCommandId, inputId: s.inputId })) },
    details: ['실험 분류·고정 분류 설명입니다. Jev가 생성한 구체적 근거가 아닙니다. 최종 완료 승인은 사용자에게 있습니다.',
      '실제 시작·입력 소비 snapshot은 확인되지 않았습니다. 카드 현황은 종료 후 조회 시점 자료이며 정확한 종료 상태가 아닙니다.',
      `관측 대화: 이벤트 ${input.scope.historyFirstEventId ?? '?'}–${input.scope.historyLastEventId ?? '?'} / 완료 이벤트 ${job.completeEventId}까지. ${input.scope.truncated || input.scope.omittedHistoryEvents ? '일부 이력이 생략되었습니다.' : '텍스트 이력만 사용했습니다.'}`,
      '도구 출력과 첨부는 관측하지 않았습니다. 대화 기반 분류이며 완료 사실을 검증한 결과가 아닙니다.',
      `Provider 호출 ${outcome.calls}회 · ${outcome.latencyMs}ms · 요청 ${outcome.inputBytes} bytes`,
      ...outcome.cards.map(c => `${c.title} · 저장 상태 ${c.storedStatus} · 버전 ${c.version ?? '미확인'} · Jev 출력 ${c.providerChoice ?? '없음'}${c.completionWithheld ? ' · 완료 판정 보류' : ''}${c.confidence === undefined ? '' : ` · provider confidence ${c.confidence} (정확도 아님)`}`)] };
}
