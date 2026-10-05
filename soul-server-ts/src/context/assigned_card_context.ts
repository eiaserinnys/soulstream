import type { Logger } from "pino";
import type { SessionDB } from "../db/session_db.js";
import type { ContextItem } from "./prompt_assembler.js";

export interface AssignedCardContext {
  capturedAt: string;
  total: number;
  omitted: number;
  cards: Array<{
    id: string; title: string; status: string; hasItems?:boolean;
    latestCommentAt: string | null; latestReportAt: string | null;
  }>;
}

/** Optional prepared-input snapshot recorder. */
export type AssignedCardCapture = (snapshot: Readonly<AssignedCardContext>) => Promise<void>;

export interface AssignedCardContextCapture {
  source: "prepared_model_input";
  sessionId: string;
  registrationId: string | null;
  executionCommandId: string | null;
  inputId: string | null;
  snapshot: Readonly<AssignedCardContext>;
}

/** An input snapshot only: no writes, deliveries, scheduling, or wakeups. */
export async function fetchAssignedCardContextItem(
  db: SessionDB, logger: Logger, sessionId: string, capture?: AssignedCardCapture,
): Promise<ContextItem> {
  const base = {
    scope: "assignee_session_id", session_id: sessionId, trust: "untrusted_card_data",
    notice: "현재 입력의 조회 현황이며 상태 전환 명령이 아닙니다.",
    guidance: "get_card로 담당 카드의 확인 항목과 상황판을 읽습니다. 일이 끝났으면 항목에 결과를 달고 request_card_review의 ask에 사용자가 볼 것을 적습니다. 확인 항목이 없는 옛 카드는 기존 보고 뒤 검수를 요청합니다. 진행과 기술 세부는 add_card_note에, 인계 요약은 update_card_brief에 남기고 턴을 끝내기 전에 update_card_now로 지금과 누구 차례를 맞춥니다.",
  };
  try {
    const snapshot = await db.getAssignedCardContext(sessionId);
    if (capture) {
      // Optional observation cannot block input preparation. A private copy also
      // keeps recorder mutations from changing the context that will be formatted.
      try { void capture(structuredClone(snapshot)).catch(err=>logger.warn({err,sessionId}, "assigned card snapshot observer failed")); }
      catch (err) { logger.warn({err,sessionId}, "assigned card snapshot observer failed"); }
    }
    const cards = snapshot.cards.slice(0, 12).map(card => ({
      id: card.id, title: preview(card.title, 160), status: cardStatusLabel(card.status),
      latestReportAt: card.latestReportAt,
      ...(card.hasItems === undefined ? {} : {hasItems:card.hasItems}),
      ...(card.hasItems !== true && isLater(card.latestCommentAt,card.latestReportAt) ? { reportFact:"최근 커멘트 이후 보고 없음" } : {}),
    }));
    return { key: "assigned_cards", content: { ...base, status: "ok", total: snapshot.total,
      omitted: snapshot.total - cards.length, cards } };
  } catch (err) {
    logger.warn({ err, sessionId }, "assigned card context read failed");
    return { key: "assigned_cards", content: { ...base, status: "unavailable", cards: [],
      warning: "이번 입력에서 최신 담당 카드 현황을 확인하지 못했습니다. 담당 카드가 0개라는 뜻이 아닙니다." } };
  }
}

function preview(text: string, max: number): string {
  const bounded = text.slice(0, max).replace(/<\//g, "<\\/");
  return text.length > max ? `${bounded}…` : bounded;
}

function isLater(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && Date.parse(left) > Date.parse(right);
}

export function cardStatusLabel(status: string): string {
  return ({todo:"할 일",queued:"대기",blocked:"막힘",running:"실행 중",review:"검수 대기",done:"완료",cancelled:"취소"} as Record<string,string>)[status] ?? status;
}
