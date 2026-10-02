import type { Logger } from 'pino';
import type { EventPersistence } from '../db/event_persistence.js';
import type { SSEEventPayload } from '../engine/protocol.js';
import type { AssignedCardContextCapture } from './assigned_card_context.js';

export function formatAssignedCardSnapshotContent(
  snapshot: AssignedCardContextCapture['snapshot'],
): string {
  const lines = [
    '담당 카드 입력 준비 스냅샷 · 소비 확인 전',
    '관측 범위: 저장된 준비 캡처 · 최종 모델 포맷과 소비는 확인하지 않음',
    `전체 ${snapshot.total}개 · 표시 ${snapshot.cards.length}개 · 생략 ${snapshot.omitted}개`,
  ];
  snapshot.cards.forEach((card, index) => {
    lines.push(
      `${index + 1}. ${card.title} · ${card.status} · v${card.version}`,
      `지시: ${card.instruction}`,
      `보고: ${card.report}`,
    );
  });
  lines.push(`준비 시각: ${snapshot.capturedAt}`);
  return lines.join('\n');
}

/** Copies already-read input data into the existing outbox. Never performs a provider call or waits for an ACK. */
export function createAssignedCardSnapshotRecorder(persistence: Pick<EventPersistence,'enqueueEvent'>, logger: Pick<Logger,'warn'>) {
  return async (capture: AssignedCardContextCapture): Promise<void> => {
    // Take an owned bounded copy before returning to the formatter. Readonly is only a TypeScript promise.
    const copied = {
      source: capture.source, sessionId: capture.sessionId, registrationId: capture.registrationId,
      executionCommandId: capture.executionCommandId, inputId: capture.inputId,
      identityMissing: !capture.registrationId || !capture.executionCommandId || !capture.inputId,
      snapshot: { total: capture.snapshot.total, omitted: capture.snapshot.omitted, capturedAt: capture.snapshot.capturedAt,
        cards: capture.snapshot.cards.slice(0,12).map(c=>({ id:c.id,title:c.title.slice(0,160),status:c.status,
          version:c.version,instruction:c.instruction.slice(0,401),report:c.report.slice(0,401) })) },
    };
    const dedupe = capture.registrationId && capture.inputId
      ? `assigned_card_context_snapshot:${capture.registrationId}:${capture.inputId}` : null;
    const event = { type:'debug',kind:'assigned_card_context_snapshot', capture:copied,
      content:formatAssignedCardSnapshotContent(copied.snapshot),
      timestamp:Date.now()/1_000,...(dedupe ? { _dedupe_key:dedupe } : {}) } as unknown as SSEEventPayload;
    // Outbox append is bounded local persistence. Its failure is observable; it cannot block model input or start a turn.
    void persistence.enqueueEvent(capture.sessionId,event,undefined,capture.registrationId).catch(()=>{
      logger.warn({ sessionId:capture.sessionId, inputId:capture.inputId },'assigned card prepared observation missing: append failed');
    });
  };
}
