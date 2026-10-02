import type { Logger } from 'pino';
import type { EventPersistence } from '../db/event_persistence.js';
import type { SSEEventPayload } from '../engine/protocol.js';
import type { AssignedCardContextCapture } from './assigned_card_context.js';

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
      timestamp:Date.now()/1_000,...(dedupe ? { _dedupe_key:dedupe } : {}) } as unknown as SSEEventPayload;
    // Outbox append is bounded local persistence. Its failure is observable; it cannot block model input or start a turn.
    void persistence.enqueueEvent(capture.sessionId,event,undefined,capture.registrationId).catch(()=>{
      logger.warn({ sessionId:capture.sessionId, inputId:capture.inputId },'assigned card prepared observation missing: append failed');
    });
  };
}
