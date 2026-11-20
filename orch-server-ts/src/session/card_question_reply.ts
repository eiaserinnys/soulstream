import type { FastifyRequest } from "fastify";
import { mutateCardRouteBody, readCardRouteBody, type CardRouteBodyOptions } from "../cards/card_route_body.js";
import type { FolderActorParams } from "../cards/control_plane/card_types.js";
import type { BoardAccess } from "../board/board_access.js";
import type { PersistentReportReplyDecision } from "./persistent_report_service.js";

export type CardQuestionReply = Extract<PersistentReportReplyDecision, { action: "card" } | { action: "card-acked" } | { action: "reject" }>;
export type CardQuestionReplyFailure = { status: number; body: unknown };

export type CardQuestionReplyDeps = {
  sessionId: string;
  request: FastifyRequest;
  requireSessionAccess: (input: { request: FastifyRequest; sessionId: string }) => Promise<unknown>;
  cardOptions: CardRouteBodyOptions;
  resolveAccess: () => BoardAccess | Promise<BoardAccess>;
  resolveActor: () => FolderActorParams | Promise<FolderActorParams>;
};

/**
 * 판 답을 카드 답으로 접수한다. 카드가 특정된 모든 결정(저장·되풀이 ACK·거절)은 세션 접근과
 * 카드 읽기 권한을 지난 뒤에만 응답한다. 그래야 권한 없는 사용자가 응답 차이로 저장된 답을 알아내지 못한다.
 * 거절이면 라우트가 그대로 돌려줄 실패 응답을 반환하고, 그 외에는 undefined를 반환한다.
 */
export async function applyCardQuestionReply(decision: CardQuestionReply, deps: CardQuestionReplyDeps): Promise<CardQuestionReplyFailure | undefined> {
  await deps.requireSessionAccess({ request: deps.request, sessionId: deps.sessionId });
  if (decision.action === "card") {
    const body = decision.mode === "text"
      ? { mode: "text", answer: decision.text, idempotencyKey: `report-answer:${decision.questionId}` }
      : { mode: "choice", option: decision.option, ...(decision.text === undefined ? {} : { answer: decision.text }),
          idempotencyKey: `report-answer:${decision.questionId}` };
    await mutateCardRouteBody(deps.cardOptions, "answer_card_question", decision.cardId,
      body, deps.resolveAccess, deps.resolveActor, decision.questionId);
    return undefined;
  }
  if (decision.cardId !== null) await readCardRouteBody(deps.cardOptions, decision.cardId, deps.resolveAccess);
  return decision.action === "reject"
    ? { status: decision.status, body: { detail: { error: { code: decision.code, message: decision.message } } } }
    : undefined;
}
