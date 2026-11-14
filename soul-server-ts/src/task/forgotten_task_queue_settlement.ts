import type { SessionDeliveryHostClient } from "../control_plane/persistence_host_clients.js";
import { isDeliveryIntent } from "./delivery_contract.js";
import { INSTRUCTION_UNCERTAIN_REASON } from "./state/node_instruction_decision.js";
import type { InterventionMessage } from "./task_models.js";
import { wasHandoffAttempted } from "./task_intervention_queue.js";

export const FORGOTTEN_TASK_RETURNED_REASON = "task_forgotten_before_dispatch";

/** 지시를 러너에 넘기는 일이 아직 끝나지 않은 줄 상태다. */
const HANDOFF_OPEN_STATES: ReadonlySet<string> = new Set(["claimed", "dispatching", "queued"]);

export type ForgottenQueueLedger = Pick<
  SessionDeliveryHostClient,
  "get" | "retryDeliveryAttempt" | "markUncertain"
>;

/**
 * 잊힌 task의 메모리 큐에 남은 지시를 노드 재시작을 기다리지 않고 장부에서 정리한다
 * (설계 약속 13: 받은 지시는 적용, 반환, 모름 가운데 하나로 끝난다).
 *
 * 가르는 기준은 노드 자신의 넘김 시도 기록이다. 러너에 넘기려 한 적이 없는 지시는 서버가 다시
 * 띄울 수 있는 대기 상태로 돌려준다. 넘김을 시도한 뒤 큐로 되돌아온 지시(wasHandoffAttempted)와
 * 시도 번호가 없어 돌려줄 수 없는 줄은 모름으로 둔다. 장부의 dispatching_at은 서버가 노드에 넘기기
 * 시작한 표시라 기준이 아니다(노드 재시작 복구는 메모리를 잃었으므로 그 값을 쓴다:
 * queued_delivery_transcript_recovery). 이미 끝난 줄과 장부에 없는 줄, 장부 지시가 아닌 메시지는
 * 건드리지 않는다. 한 줄이 실패해도 나머지는 정리하고, 실패는 한꺼번에 던진다.
 */
export async function settleQueuedOfForgottenTask(
  repository: ForgottenQueueLedger,
  messages: readonly InterventionMessage[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const message of messages) {
    if (!isDeliveryIntent(message.deliveryIntent) || !message.deliveryId) continue;
    try {
      const row = await repository.get(message.deliveryId);
      if (!row || !HANDOFF_OPEN_STATES.has(row.state)) continue;
      const attemptToken = row.attempt_token ?? message.deliveryAttemptToken ?? null;
      if (!wasHandoffAttempted(message) && attemptToken) {
        await repository.retryDeliveryAttempt(
          row.delivery_id,
          attemptToken,
          FORGOTTEN_TASK_RETURNED_REASON,
          0,
        );
      } else {
        await repository.markUncertain(
          row.delivery_id,
          attemptToken ?? undefined,
          INSTRUCTION_UNCERTAIN_REASON,
        );
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "queued instruction settlement failed for a forgotten task");
  }
}
