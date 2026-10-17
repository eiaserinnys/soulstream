import type { FastifyRequest } from "fastify";
import { mutateCardRouteBody, readCardRouteBody, type CardRouteBodyOptions } from "../cards/card_route_body.js";
import type { FolderActorParams } from "../cards/control_plane/card_types.js";
import type { FolderAccess } from "../folders/folder_route_access.js";
import type { PersistentReportReplyDecision } from "./persistent_report_service.js";

/** 판에서 온 카드 질문 답 — 카드 답 저장 또는 이미 답한 질문의 되풀이 ACK. */
export type CardQuestionReply = Extract<PersistentReportReplyDecision, { action: "card" } | { action: "card-acked" }>;

export type CardQuestionReplyDeps = {
  sessionId: string;
  request: FastifyRequest;
  /** 판(세션) 접근. 카드 폴더 접근 판정보다 먼저 통과해야 한다. */
  requireSessionAccess: (input: { request: FastifyRequest; sessionId: string }) => Promise<unknown>;
  cardOptions: CardRouteBodyOptions;
  resolveAccess: () => FolderAccess | Promise<FolderAccess>;
  resolveActor: () => FolderActorParams | Promise<FolderActorParams>;
};

/**
 * 판 답을 카드 답으로 접수한다. `card-acked`(이미 답한 질문에 같은 답을 다시 보냄)도 ACK 전에
 * 카드 읽기 권한 검사를 통과하게 해, 권한 없는 사용자가 ACK/409 차이로 저장된 답을 알아내지 못하게 한다.
 */
export async function applyCardQuestionReply(decision: CardQuestionReply, deps: CardQuestionReplyDeps): Promise<void> {
  await deps.requireSessionAccess({ request: deps.request, sessionId: deps.sessionId });
  if (decision.action === "card-acked") {
    await readCardRouteBody(deps.cardOptions, decision.cardId, deps.resolveAccess);
    return;
  }
  await mutateCardRouteBody(deps.cardOptions, "answer_card_question", decision.cardId,
    { answer: decision.option, idempotencyKey: `report-answer:${decision.questionId}` },
    deps.resolveAccess, deps.resolveActor, decision.questionId);
}
