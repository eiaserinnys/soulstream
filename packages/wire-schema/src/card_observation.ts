/** Typed payload carried by the existing durable `debug` event. Not a model message. */
export interface JevCardObservation {
  type: 'debug'; kind: 'jev_card_observation'; timestamp: number;
  complete_event_id: number; final_response_event_id: number;
  phase: 'reserved' | 'result'; content: string; details: string[];
  outcome: { status: 'evaluated' | 'not_evaluated'; reason?: string; calls: number; latencyMs: number; inputBytes: number;
    cards: Array<{ cardId: string; title: string; storedStatus: string; version: number | null;
      classification: 'ready_for_review' | 'blocked' | 'in_progress' | 'waiting' | 'unrelated' | 'unknown';
      providerChoice?: string; confidence?: number; completionWithheld?: boolean }> };
  scope: Record<string, unknown>;
  captured_at: string;
}
export function isJevCardObservation(value: unknown): value is JevCardObservation {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<JevCardObservation>;
  return event.type === 'debug' && event.kind === 'jev_card_observation'
    && Number.isSafeInteger(event.complete_event_id) && (event.complete_event_id ?? 0) > 0
    && Number.isSafeInteger(event.final_response_event_id) && (event.final_response_event_id ?? 0) > 0
    && typeof event.content === 'string' && Array.isArray(event.details)
    && event.details.every(line => typeof line === 'string');
}
