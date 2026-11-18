import {
  PendingNodeCommandRejectedError,
  type NodeCommandResponse,
} from "../node/pending_commands.js";
import { DEFAULT_NODE_COMMAND_TIMEOUT_MS } from "../node/node_timeouts.js";
import type { SessionDeliveryRepository } from "./repositories/session_delivery_repository.js";

/**
 * card #1653 — 중앙이 노드 명령 응답을 기다리는 동안 attempt claim 시한이 먼저
 * 지나면 만료 sweep이 아직 진행 중인 발송을 pending으로 되돌리고, 늦게 도착한
 * 접수는 토큰 CAS를 잃는다. 카드 변경 보내기와 중앙 재생의 claim 시한을 그
 * 경로가 쓰는 노드 명령 시한보다 5초 길게 잡는다. 노드 스스로 잡는 route claim,
 * 완료 알림 조정기(60초), dispatching 시한(120초)은 그대로다.
 */
export const DELIVERY_CLAIM_TTL_MS = DEFAULT_NODE_COMMAND_TIMEOUT_MS + 5_000;

export type DeliveryReleaseRepository = Pick<
  SessionDeliveryRepository,
  "get" | "retryDeliveryAttempt" | "markUncertain"
>;

/**
 * 노드가 응답을 실어 보낸 명시적 거절만 푼다. 시한 초과
 * (`PendingNodeCommandTimeoutError`)와 응답 없는 거절은 만료 sweep에 맡긴다.
 */
export function isExplicitNodeRejection(
  error: unknown,
): error is PendingNodeCommandRejectedError & { response: NodeCommandResponse } {
  return error instanceof PendingNodeCommandRejectedError
    && error.response !== undefined;
}

/** 경고와 시도 기록에 남기는 노드 거절 사유 요약. 예전 재생 경로와 같은 형식이다. */
export function nodeRejectionDetailsSuffix(error: unknown): string {
  const details = rejectionDetails(error);
  if (details === undefined) return "";
  return ` (reason=${String(details.reason ?? null)}, cell=${String(details.cell ?? null)})`;
}

/**
 * 카드 변경 보내기와 중앙 재생이 함께 쓰는 실패 해제 판단 (card #1653).
 *
 * 보내는 쪽이 실패를 안고 claim 시한까지 행을 묶어 두지 않도록, 다시 읽은 행이
 * 이번 토큰을 아직 잡고 있고 state가 claimed/dispatching일 때만 푼다. 이미
 * 접수(queued)됐거나 토큰이 청소로 바뀐 행을 되돌리면 중복 실행이 된다.
 *
 * permanent/no_retry 거절은 uncertain으로 닫고, 그 밖의 실패는 재생 경로가
 * 쓰던 지연으로 재시도한다. 응답 없는 실패(전송 오류 등)는 지금처럼 지연 0이다.
 */
export async function releaseDeliveryAttemptAfterSendFailure(input: {
  repository: DeliveryReleaseRepository;
  deliveryId: string;
  attemptToken: string;
  error: unknown;
  failure: string;
  attemptCount: number;
}): Promise<"uncertain" | "retried" | "unchanged"> {
  const current = await input.repository.get(input.deliveryId);
  if (
    current?.attempt_token !== input.attemptToken
    || (current.state !== "claimed" && current.state !== "dispatching")
  ) {
    return "unchanged";
  }
  if (isPermanentNodeRejection(input.error)) {
    await input.repository.markUncertain(
      input.deliveryId,
      input.attemptToken,
      input.failure,
    );
    return "uncertain";
  }
  await input.repository.retryDeliveryAttempt(
    input.deliveryId,
    input.attemptToken,
    input.failure,
    retryDelayMsFor(input.error, input.attemptCount),
  );
  return "retried";
}

export function isPermanentNodeRejection(error: unknown): boolean {
  const rejection =
    error instanceof PendingNodeCommandRejectedError ? error : undefined;
  if (rejection?.response?.code !== "NODE_RESPONSE_REJECTED") return false;
  const details = rejectionDetails(error);
  return details?.cell === "permanent" || details?.cell === "no_retry";
}

function retryDelayMsFor(error: unknown, attemptCount: number): number {
  const rejection =
    error instanceof PendingNodeCommandRejectedError ? error : undefined;
  return rejection?.response
    ? Math.min(600_000, 60_000 * 2 ** attemptCount)
    : 0;
}

function rejectionDetails(
  error: unknown,
): Record<string, unknown> | undefined {
  const rejection =
    error instanceof PendingNodeCommandRejectedError ? error : undefined;
  const details = rejection?.response?.details;
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}
