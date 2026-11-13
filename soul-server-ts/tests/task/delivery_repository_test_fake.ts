/**
 * orch의 register 계약을 그대로 흉내 내는 인메모리 세션 전달 저장소.
 * 같은 relation_key에 다른 신원이 오면 기존 행을 dead_letter로 만든다.
 */
import { vi } from "vitest";

export function makeDeliveryRepository(rows: Map<string, Record<string, unknown>>) {
  return {
    register: vi.fn(async (params: Record<string, unknown>) => {
      const existing = [...rows.values()].find(
        (row) => row.delivery_id === params.deliveryId
          || row.relation_key === params.relationKey,
      );
      const createdAt = params.createdAt as Date;
      if (!existing) {
        const row = {
          delivery_id: params.deliveryId,
          target_session_id: params.targetSessionId,
          source_session_id: params.sourceSessionId,
          relation_key: params.relationKey,
          completion_id: params.completionId,
          intent: params.intent,
          source: params.source,
          producer_kind: params.producerKind,
          producer_id: params.producerId,
          producer_terminal_revision: params.producerTerminalRevision,
          parent_delivery_id: null,
          caller_turn_id: null,
          payload_hash: params.payloadHash,
          payload: params.payload,
          state: "pending",
          aggregate_state: "pending",
          dead_letter_reason: null,
          attempt_count: 0,
          next_attempt_at: createdAt,
          last_error: null,
          attempt_token: null,
          attempt_expires_at: null,
          created_at: createdAt,
          updated_at: createdAt,
          delivered_at: null,
          consumed_at: null,
        };
        rows.set(row.delivery_id as string, row);
        return { row, inserted: true, conflict: false };
      }
      const conflict =
        existing.delivery_id !== params.deliveryId
        || existing.relation_key !== params.relationKey
        || existing.payload_hash !== params.payloadHash
        || existing.intent !== params.intent
        || existing.completion_id !== (params.completionId ?? null);
      if (!conflict) return { row: existing, inserted: false, conflict: false };
      const dead = {
        ...existing,
        state: "uncertain",
        aggregate_state: "dead_letter",
        dead_letter_reason: "delivery identity conflict",
      };
      rows.set(dead.delivery_id as string, dead);
      return { row: dead, inserted: false, conflict: true };
    }),
    get: vi.fn(async (deliveryId: string) => rows.get(deliveryId) ?? null),
    claimAttemptForTarget: vi.fn(async (
      deliveryId: string,
      targetSessionId: string,
      attemptToken: string,
    ) => {
      const row = rows.get(deliveryId);
      if (
        !row || row.state !== "pending"
        || (row.next_attempt_at as Date).getTime() > Date.now()
      ) return null;
      const claimed = {
        ...row,
        target_session_id: targetSessionId,
        state: "claimed",
        attempt_token: attemptToken,
      };
      rows.set(deliveryId, claimed);
      return claimed;
    }),
    deferPending: vi.fn(async (
      deliveryId: string,
      reason: string,
      retryDelayMs: number,
    ) => {
      const row = rows.get(deliveryId);
      if (!row) return null;
      const deferred = {
        ...row,
        state: "pending",
        attempt_token: null,
        last_error: reason,
        next_attempt_at: new Date(Date.now() + retryDelayMs),
      };
      rows.set(deliveryId, deferred);
      return deferred;
    }),
    retryDeliveryAttempt: vi.fn(async () => null),
    expireStaleDeliveryAttempts: vi.fn(async () => 0),
    markUncertain: vi.fn(async () => null),
  };
}
